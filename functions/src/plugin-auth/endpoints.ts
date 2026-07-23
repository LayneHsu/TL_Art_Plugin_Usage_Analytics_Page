import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { onRequest, type Request } from "firebase-functions/v2/https";
import type { Response } from "express";

import { CredentialService } from "./credential-service";
import { SystemRandomSource } from "./crypto";
import { PluginAuthError, pluginAuthHttpStatus } from "./errors";
import { FirestorePluginAuthStore } from "./firestore-store";
import { GooglePluginOidcExchange } from "./google-oidc";
import { assertPluginEndpointHeaders } from "./http-boundary";
import { LeaseService } from "./lease-service";
import { PluginAuthDecisionService } from "./auth-decision";
import { PluginOpsApprovalService } from "./ops-approval-service";
import { PairingService } from "./pairing-service";
import { authenticatePluginOpsRequest } from "./plugin-ops-http";
import { GooglePluginOpsTokenVerifier } from "./plugin-ops-identity";
import { assertPrincipalPepperConfiguration } from "./principal-service";
import { auditDenied } from "./service-helpers";
import type {
  Clock,
  PluginAuthConfiguration,
  PluginAuthStore,
  PluginOpsAction,
  VerifiedPluginOpsIdentity,
} from "./types";
import { FirestoreMonitoringService } from "../usage/monitoring-firestore";

const pluginOAuthClientSecret = defineSecret("PLUGIN_OAUTH_CLIENT_SECRET");
const pluginCredentialPepper = defineSecret("PLUGIN_CREDENTIAL_PEPPER");
const pluginCredentialDeliveryKeys = defineSecret(
  "PLUGIN_CREDENTIAL_DELIVERY_KEYS_JSON",
);
const pluginPrincipalKeyPepper = defineSecret("PLUGIN_PRINCIPAL_KEY_PEPPER");
const pluginLeaseSigningKeys = defineSecret("PLUGIN_LEASE_SIGNING_KEYS_JSON");

const pluginOAuthClientId = defineString("PLUGIN_OAUTH_CLIENT_ID");
const pluginCompanyDomain = defineString("PLUGIN_COMPANY_DOMAIN");
const pluginAllowedCallbackUris = defineString(
  "PLUGIN_ALLOWED_CALLBACK_URIS_JSON",
);
const pluginAllowedWebOrigins = defineString("PLUGIN_ALLOWED_WEB_ORIGINS_JSON");
const pluginOpsAudience = defineString("PLUGIN_OPS_AUDIENCE");
const pluginOpsAllowedServiceAccounts = defineString(
  "PLUGIN_OPS_ALLOWED_SERVICE_ACCOUNTS_JSON",
);
const pluginPrincipalKeyId = defineString("PLUGIN_PRINCIPAL_KEY_ID");
const pluginPrincipalPepperMigrationMode = defineString(
  "PLUGIN_PRINCIPAL_PEPPER_MIGRATION_MODE",
);

const pluginSecrets = [
  pluginOAuthClientSecret,
  pluginCredentialPepper,
  pluginCredentialDeliveryKeys,
  pluginPrincipalKeyPepper,
  pluginLeaseSigningKeys,
];

export const pluginAuthRuntimeSecrets = pluginSecrets;

class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

const clock = new SystemClock();
const random = new SystemRandomSource();

interface RateLimitedRequest {
  ip?: string;
}

interface RateLimiter {
  check(request: RateLimitedRequest, endpoint: string): void;
  sizeForTest(): number;
}

export function createRateLimiter(input: {
  now?: () => number;
  maxEntries?: number;
} = {}): RateLimiter {
  const now = input.now ?? (() => Date.now());
  const maxEntries = input.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
    throw new Error("Invalid rate limiter capacity");
  }
  const windows = new Map<string, { count: number; resetsAt: number }>();
  const prune = (timestamp: number): void => {
    for (const [key, window] of windows) {
      if (window.resetsAt <= timestamp) {
        windows.delete(key);
      }
    }
  };
  return {
    check(request, endpoint) {
      const timestamp = now();
      prune(timestamp);
      const key = `${endpoint}:${request.ip || "unknown"}`;
      let current = windows.get(key);
      if (!current) {
        while (windows.size >= maxEntries) {
          const oldest = [...windows.entries()].sort((left, right) => {
            const expiry = left[1].resetsAt - right[1].resetsAt;
            return expiry || left[0].localeCompare(right[0]);
          })[0]?.[0];
          if (!oldest) break;
          windows.delete(oldest);
        }
        current = { count: 1, resetsAt: timestamp + 60_000 };
        windows.set(key, current);
        return;
      }
      current.count += 1;
      if (current.count > 60) {
        throw new PluginAuthError("POLL_RATE_LIMITED", "Request rate exceeded");
      }
    },
    sizeForTest() {
      return windows.size;
    },
  };
}

const rateLimiter = createRateLimiter();

function parseStringArray(value: string, label: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function runtimeLeaseSigningKeys(): PluginAuthConfiguration["leaseSigningKeys"] {
  const signingKeyConfiguration = JSON.parse(pluginLeaseSigningKeys.value()) as {
    currentKeyId?: unknown;
    verificationKeys?: unknown;
  };
  const verificationKeys = signingKeyConfiguration.verificationKeys as
    | Record<string, unknown>
    | undefined;
  if (
    typeof signingKeyConfiguration.currentKeyId !== "string" ||
    !verificationKeys ||
    typeof verificationKeys !== "object" ||
    typeof verificationKeys[signingKeyConfiguration.currentKeyId] !== "string" ||
    Object.entries(verificationKeys).some(
      ([keyId, value]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId) ||
        typeof value !== "string" ||
        value.length < 32,
    )
  ) {
    throw new Error("Invalid plugin lease signing key configuration");
  }
  return {
    currentKeyId: signingKeyConfiguration.currentKeyId,
    verificationKeys: verificationKeys as Record<string, string>,
  };
}

function runtimeConfiguration(): PluginAuthConfiguration {
  const leaseSigningKeys = runtimeLeaseSigningKeys();
  const deliveryKeyConfiguration = JSON.parse(pluginCredentialDeliveryKeys.value()) as {
    currentKeyId?: unknown;
    verificationKeys?: unknown;
  };
  const deliveryVerificationKeys = deliveryKeyConfiguration.verificationKeys as
    | Record<string, unknown>
    | undefined;
  if (
    typeof deliveryKeyConfiguration.currentKeyId !== "string" ||
    !deliveryVerificationKeys ||
    typeof deliveryVerificationKeys !== "object" ||
    typeof deliveryVerificationKeys[deliveryKeyConfiguration.currentKeyId] !==
      "string" ||
    Object.values(deliveryVerificationKeys).some(
      (value) => typeof value !== "string" || value.length < 32,
    )
  ) {
    throw new Error("Invalid plugin credential delivery key configuration");
  }
  const principalKeyId = pluginPrincipalKeyId.value();
  const principalPepperMigrationMode = pluginPrincipalPepperMigrationMode.value();
  assertPrincipalPepperConfiguration({
    keyId: principalKeyId,
    migrationMode: principalPepperMigrationMode,
  });
  return {
    companyDomain: pluginCompanyDomain.value().toLowerCase(),
    allowedIssuers: ["https://accounts.google.com", "accounts.google.com"],
    oauthAudience: pluginOAuthClientId.value(),
    allowedCallbackUris: parseStringArray(
      pluginAllowedCallbackUris.value(),
      "plugin callback URI configuration",
    ),
    pairingTtlSeconds: 300,
    pairingPollIntervalSeconds: 2,
    rotationTtlSeconds: 300,
    credentialPepper: pluginCredentialPepper.value(),
    credentialDeliveryKeys: {
      currentKeyId: deliveryKeyConfiguration.currentKeyId,
      verificationKeys: deliveryVerificationKeys as Record<string, string>,
    },
    principalKeyPepper: pluginPrincipalKeyPepper.value(),
    principalKeyId,
    principalPepperMigrationMode: principalPepperMigrationMode as
      | "disabled"
      | "explicit",
    leaseIssuer: "tl-art-tool-usage-analytics/plugin-auth",
    leaseAudience: "tl-art-tool-usage-ingestion",
    leaseTtlSeconds: 3600,
    leaseClockSkewSeconds: 300,
    leaseSigningKeys,
  };
}

function createStore(): FirestorePluginAuthStore {
  const app = getApps().length > 0 ? getApp() : initializeApp();
  return new FirestorePluginAuthStore(getFirestore(app));
}

export function createRuntimePluginAuthDecisionService(): PluginAuthDecisionService {
  return new PluginAuthDecisionService({
    store: createStore(),
    configuration: runtimeConfiguration(),
    clock,
    random,
    onAuditFailure: (reason) => {
      console.error("plugin_auth_denial_audit_failed", { reason: reason.slice(0, 64) });
    },
  });
}

export async function recordRuntimePluginAuthFailure(reason: string): Promise<void> {
  const store = createStore();
  await store.runTransaction(async (transaction) => {
    await auditDenied(transaction, { clock, random }, { reason: reason.slice(0, 64) });
  });
}

function createServices(callbackUri?: string) {
  const configuration = runtimeConfiguration();
  const configuredCallback = callbackUri ?? configuration.allowedCallbackUris[0];
  const store = createStore();
  const oidc = new GooglePluginOidcExchange({
    clientId: configuration.oauthAudience,
    clientSecret: pluginOAuthClientSecret.value(),
    callbackUri: configuredCallback,
  });
  return {
    configuration,
    oidc,
    pairing: new PairingService({ store, clock, random, oidc, configuration }),
    credentials: new CredentialService({
      store,
      clock,
      random,
      configuration,
    }),
    lease: new LeaseService({ store, clock, random, configuration }),
  };
}

export function createRuntimePluginOpsIdentityVerifier(): GooglePluginOpsTokenVerifier {
  return new GooglePluginOpsTokenVerifier({
    audience: pluginOpsAudience.value(),
    allowedIssuers: ["https://accounts.google.com", "accounts.google.com"],
    allowedServiceAccounts: parseStringArray(
      pluginOpsAllowedServiceAccounts.value(),
      "plugin ops service-account allowlist",
    ),
  });
}

function createOpsServices() {
  const store = createStore();
  const leaseSigningKeys = runtimeLeaseSigningKeys();
  return {
    store,
    onAuditFailure: (reason: string) => {
      console.error("plugin_auth_denial_audit_failed", { reason: reason.slice(0, 64) });
    },
    verifier: createRuntimePluginOpsIdentityVerifier(),
    approvals: new PluginOpsApprovalService({
      store,
      clock,
      random,
      reviewTtlSeconds: 600,
      leaseSigningKeyMetadata: {
        currentKeyId: leaseSigningKeys.currentKeyId,
        verificationKeyIds: Object.keys(leaseSigningKeys.verificationKeys),
      },
    }),
  };
}

export function requireHttps(request: Request): void {
  const forwardedProtocol = request.get("x-forwarded-proto");
  if (
    process.env.FUNCTIONS_EMULATOR !== "true" &&
    request.protocol !== "https" &&
    forwardedProtocol !== "https"
  ) {
    throw new PluginAuthError("INVALID_REQUEST", "HTTPS is required");
  }
}

export function readBoundedJsonBody(
  request: Request,
): Record<string, unknown> {
  const rawLength = request.rawBody?.byteLength ?? 0;
  if (rawLength > 16_384 || !request.is("application/json")) {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid request body");
  }
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid request body");
  }
  return request.body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid request body");
  }
  return value;
}

function assertExactFields(
  body: Record<string, unknown>,
  expected: string[],
): void {
  const actual = Object.keys(body).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((value, index) => value !== allowed[index])
  ) {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid request body");
  }
}

const publicEndpointFields: Record<string, string[]> = {
  "create-pairing": [
    "callback_uri",
    "device_id",
    "device_challenge",
    "client_version",
  ],
  "begin-pairing": [
    "callback_uri",
    "pairing_id",
    "pairing_secret",
    "state",
    "nonce",
    "pkce_challenge",
  ],
  "complete-pairing": [
    "callback_uri",
    "pairing_id",
    "pairing_secret",
    "state",
    "authorization_code",
    "pkce_verifier",
  ],
  "cancel-browser-pairing": ["pairing_id", "pairing_secret"],
  "poll-pairing": [
    "pairing_id",
    "pairing_secret",
    "device_id",
    "device_challenge",
  ],
  "acknowledge-pairing": [
    "pairing_id",
    "pairing_secret",
    "device_id",
    "device_challenge",
    "binding_id",
    "device_credential",
  ],
  "cancel-pairing": [
    "pairing_id",
    "pairing_secret",
    "device_id",
    "device_challenge",
  ],
  "renew-lease": ["binding_id", "device_credential"],
  "prepare-rotation": ["binding_id", "device_credential"],
  "confirm-rotation": [
    "binding_id",
    "rotation_id",
    "new_device_credential",
  ],
  "cancel-rotation": ["binding_id", "rotation_id", "device_credential"],
  unlink: ["binding_id", "device_credential"],
};

function stringMapField(
  body: Record<string, unknown>,
  name: string,
): Record<string, string> {
  const value = body[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid request body");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new PluginAuthError("INVALID_REQUEST", "Invalid request body");
    }
    result[key] = item;
  }
  return result;
}

function opsActionField(body: Record<string, unknown>): PluginOpsAction {
  const action = stringField(body, "action");
  if (
    action !== "revoke_binding" &&
    action !== "disable_principal" &&
    action !== "record_signing_key_rotation"
  ) {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid plugin operation");
  }
  return action;
}

function applyCors(request: Request, response: Response): boolean {
  const origin = request.get("origin");
  if (origin) {
    const allowedOrigins = parseStringArray(
      pluginAllowedWebOrigins.value(),
      "plugin web origin configuration",
    );
    if (!allowedOrigins.includes(origin)) {
      throw new PluginAuthError("INVALID_REQUEST", "Origin is not allowed");
    }
    response.set("Access-Control-Allow-Origin", origin);
    response.set("Vary", "Origin");
    response.set("Access-Control-Allow-Headers", "Content-Type");
    response.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (request.method === "OPTIONS") {
    response.status(204).send("");
    return true;
  }
  return false;
}

async function handlePublicEndpoint(
  request: Request,
  response: Response,
  endpoint: string,
  operation: (body: Record<string, unknown>) => Promise<unknown>,
  limiter: RateLimiter = rateLimiter,
  monitoring: {
    onAttempt?: () => Promise<void>;
    onFailure?: () => Promise<void>;
  } = {},
): Promise<void> {
  let operationAttempted = false;
  const record = async (operation: (() => Promise<void>) | undefined): Promise<void> => {
    if (!operation) return;
    try {
      await operation();
    } catch {
      // Monitoring is best-effort and must not change authentication behavior.
    }
  };
  try {
    if (applyCors(request, response)) {
      return;
    }
    requireHttps(request);
    assertPluginEndpointHeaders(request.headers);
    if (request.method !== "POST") {
      throw new PluginAuthError("INVALID_REQUEST", "POST is required");
    }
    limiter.check(request, endpoint);
    const body = readBoundedJsonBody(request);
    assertExactFields(body, publicEndpointFields[endpoint] ?? []);
    operationAttempted = true;
    await record(monitoring.onAttempt);
    const result = await operation(body);
    response.status(200).json({ ok: true, result });
  } catch (error) {
    if (operationAttempted) await record(monitoring.onFailure);
    const pluginError =
      error instanceof PluginAuthError
        ? error
        : new PluginAuthError("INVALID_REQUEST", "Request could not be completed");
    response.status(pluginAuthHttpStatus(pluginError)).json({
      ok: false,
      error: { code: pluginError.code, message: pluginError.publicMessage },
    });
  }
}

export function createPublicEndpointHandler(
  endpoint: string,
  operation: (body: Record<string, unknown>) => Promise<unknown>,
  limiter: RateLimiter = rateLimiter,
  monitoring: {
    onAttempt?: () => Promise<void>;
    onFailure?: () => Promise<void>;
  } = {},
): (
  request: Request,
  response: Response,
) => Promise<void> {
  return (request, response) =>
    handlePublicEndpoint(request, response, endpoint, operation, limiter, monitoring);
}

const publicEndpointOptions = {
  secrets: pluginSecrets,
  timeoutSeconds: 30,
  memory: "256MiB" as const,
  cors: false,
};

export const pluginCreatePairing = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "create-pairing", async (body) => {
      const callbackUri = stringField(body, "callback_uri");
      return createServices(callbackUri).pairing.create({
        deviceId: stringField(body, "device_id"),
        deviceChallenge: stringField(body, "device_challenge"),
        clientVersion: stringField(body, "client_version"),
        callbackUri,
      });
    });
  },
);

export const pluginBeginPairing = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "begin-pairing", async (body) => {
      const callbackUri = stringField(body, "callback_uri");
      const services = createServices(callbackUri);
      const state = stringField(body, "state");
      const nonce = stringField(body, "nonce");
      const pkceChallenge = stringField(body, "pkce_challenge");
      await services.pairing.beginBrowserClaim({
        pairingId: stringField(body, "pairing_id"),
        pairingSecret: stringField(body, "pairing_secret"),
        state,
        nonce,
        pkceChallenge,
        callbackUri,
      });
      return {
        authorizationUrl: services.oidc.createAuthorizationUrl({
          state,
          nonce,
          pkceChallenge,
        }),
      };
    });
  },
);

export const pluginCompletePairing = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "complete-pairing", async (body) => {
      const callbackUri = stringField(body, "callback_uri");
      await createServices(callbackUri).pairing.completeBrowserClaim({
        pairingId: stringField(body, "pairing_id"),
        pairingSecret: stringField(body, "pairing_secret"),
        state: stringField(body, "state"),
        callbackUri,
        authorizationCode: stringField(body, "authorization_code"),
        pkceVerifier: stringField(body, "pkce_verifier"),
      });
      return { status: "claimed" };
    });
  },
);

export const pluginCancelBrowserPairing = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "cancel-browser-pairing", async (body) => {
      await createServices().pairing.cancelBrowserClaim({
        pairingId: stringField(body, "pairing_id"),
        pairingSecret: stringField(body, "pairing_secret"),
      });
      return { status: "cancelled" };
    });
  },
);

export const pluginPollPairing = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "poll-pairing", async (body) =>
      createServices().pairing.poll({
        pairingId: stringField(body, "pairing_id"),
        pairingSecret: stringField(body, "pairing_secret"),
        deviceId: stringField(body, "device_id"),
        deviceChallenge: stringField(body, "device_challenge"),
      }),
    );
  },
);

export const pluginAcknowledgePairingDelivery = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "acknowledge-pairing", async (body) => {
      await createServices().pairing.acknowledgeDelivery({
        pairingId: stringField(body, "pairing_id"),
        pairingSecret: stringField(body, "pairing_secret"),
        deviceId: stringField(body, "device_id"),
        deviceChallenge: stringField(body, "device_challenge"),
        bindingId: stringField(body, "binding_id"),
        deviceCredential: stringField(body, "device_credential"),
      });
      return { status: "acknowledged" };
    });
  },
);

export const pluginCancelPairing = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "cancel-pairing", async (body) => {
      await createServices().pairing.cancel({
        pairingId: stringField(body, "pairing_id"),
        pairingSecret: stringField(body, "pairing_secret"),
        deviceId: stringField(body, "device_id"),
        deviceChallenge: stringField(body, "device_challenge"),
      });
      return { status: "cancelled" };
    });
  },
);

export const pluginRenewLease = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    const app = getApps().length > 0 ? getApp() : initializeApp();
    const monitoring = new FirestoreMonitoringService(getFirestore(app));
    await handlePublicEndpoint(
      request,
      response,
      "renew-lease",
      async (body) => createServices().lease.renew({
          bindingId: stringField(body, "binding_id"),
          deviceCredential: stringField(body, "device_credential"),
        }),
      rateLimiter,
      {
        onAttempt: async () => {
          await monitoring.incrementCounter("lease_renew_attempts", 1, new Date());
        },
        onFailure: async () => {
          await monitoring.incrementCounter("lease_renew_failures", 1, new Date());
        },
      },
    );
  },
);

export const pluginPrepareCredentialRotation = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "prepare-rotation", async (body) =>
      createServices().credentials.prepareRotation({
        bindingId: stringField(body, "binding_id"),
        currentCredential: stringField(body, "device_credential"),
      }),
    );
  },
);

export const pluginConfirmCredentialRotation = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "confirm-rotation", async (body) => {
      await createServices().credentials.confirmRotation({
        bindingId: stringField(body, "binding_id"),
        rotationId: stringField(body, "rotation_id"),
        newDeviceCredential: stringField(body, "new_device_credential"),
      });
      return { status: "confirmed" };
    });
  },
);

export const pluginCancelCredentialRotation = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "cancel-rotation", async (body) => {
      await createServices().credentials.cancelRotation({
        bindingId: stringField(body, "binding_id"),
        rotationId: stringField(body, "rotation_id"),
        currentCredential: stringField(body, "device_credential"),
      });
      return { status: "cancelled" };
    });
  },
);

export const pluginUnlink = onRequest(
  publicEndpointOptions,
  async (request, response) => {
    await handlePublicEndpoint(request, response, "unlink", async (body) => {
      await createServices().credentials.unlink({
        bindingId: stringField(body, "binding_id"),
        currentCredential: stringField(body, "device_credential"),
      });
      return { status: "unlinked" };
    });
  },
);

const pluginOpsEndpointOptions = {
  timeoutSeconds: 30,
  memory: "256MiB" as const,
  cors: false,
  invoker: "private" as const,
  secrets: [pluginLeaseSigningKeys],
};

async function handlePluginOpsEndpoint(
  request: Request,
  response: Response,
  expectedFields: string[],
  operation: (
    body: Record<string, unknown>,
    identity: VerifiedPluginOpsIdentity,
    approvals: PluginOpsApprovalService,
  ) => Promise<unknown>,
  injectedServices?: {
    store: PluginAuthStore;
    verifier: { verify(token: string): Promise<VerifiedPluginOpsIdentity> };
    approvals: PluginOpsApprovalService;
    onAuditFailure?: (reason: string) => Promise<void> | void;
  },
): Promise<void> {
  const services = injectedServices ?? createOpsServices();
  try {
    requireHttps(request);
    if (request.method !== "POST") {
      throw new PluginAuthError("INVALID_REQUEST", "POST is required");
    }
    const body = readBoundedJsonBody(request);
    assertExactFields(body, expectedFields);
    const identity = await authenticatePluginOpsRequest(
      request.headers,
      services.verifier,
    );
    const result = await operation(body, identity, services.approvals);
    response.status(200).json({ ok: true, result });
  } catch (error) {
    const pluginError =
      error instanceof PluginAuthError
        ? error
        : new PluginAuthError("INVALID_REQUEST", "Request could not be completed");
    if (pluginError.code === "OPS_IDENTITY_REQUIRED") {
      const reason = "plugin_ops_bearer_rejected";
      try {
        await services.store.runTransaction(async (transaction) => {
          await auditDenied(transaction, { clock, random }, { reason });
        });
      } catch {
        try {
          await services.onAuditFailure?.(reason.slice(0, 64));
        } catch {
          // 已确定的拒绝结果不能被审计降级覆盖.
        }
      }
    }
    response.status(pluginAuthHttpStatus(pluginError)).json({
      ok: false,
      error: { code: pluginError.code, message: pluginError.publicMessage },
    });
  }
}

export function createPluginOpsEndpointHandler(input: {
  expectedFields: string[];
  operation: (
    body: Record<string, unknown>,
    identity: VerifiedPluginOpsIdentity,
    approvals: PluginOpsApprovalService,
  ) => Promise<unknown>;
    dependencies: {
      store: PluginAuthStore;
      verifier: { verify(token: string): Promise<VerifiedPluginOpsIdentity> };
      approvals: PluginOpsApprovalService;
      onAuditFailure?: (reason: string) => Promise<void> | void;
    };
}): (request: Request, response: Response) => Promise<void> {
  return (request, response) =>
    handlePluginOpsEndpoint(
      request,
      response,
      input.expectedFields,
      input.operation,
      input.dependencies,
    );
}

export const pluginOpsRequest = onRequest(
  pluginOpsEndpointOptions,
  async (request, response) => {
    await handlePluginOpsEndpoint(
      request,
      response,
      ["action", "target_id", "parameters"],
      (body, identity, approvals) =>
        approvals.request({
          identity,
          action: opsActionField(body),
          targetId: stringField(body, "target_id"),
          parameters: stringMapField(body, "parameters"),
        }),
    );
  },
);

export const pluginOpsApprove = onRequest(
  pluginOpsEndpointOptions,
  async (request, response) => {
    await handlePluginOpsEndpoint(
      request,
      response,
      ["review_id"],
      async (body, identity, approvals) => {
        await approvals.approve({
          identity,
          reviewId: stringField(body, "review_id"),
        });
        return { status: "approved" };
      },
    );
  },
);

export const pluginOpsExecute = onRequest(
  pluginOpsEndpointOptions,
  async (request, response) => {
    await handlePluginOpsEndpoint(
      request,
      response,
      ["review_id"],
      async (body, identity, approvals) => {
        await approvals.execute({
          identity,
          reviewId: stringField(body, "review_id"),
        });
        return { status: "executed" };
      },
    );
  },
);
