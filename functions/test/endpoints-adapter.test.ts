import assert from "node:assert/strict";
import test from "node:test";

import { PluginAuthError } from "../src/plugin-auth/errors";
import { PluginOpsApprovalService } from "../src/plugin-auth/ops-approval-service";
import { InMemoryPluginAuthStore } from "../src/plugin-auth/in-memory-store";
import type {
  PluginAuthStore,
  VerifiedPluginOpsIdentity,
} from "../src/plugin-auth/types";
import {
  createHarness,
  leaseSigningKeyMetadata,
  pairAndIssueDeviceCredential,
  pkceChallengeFor,
} from "./helpers";

type EndpointHandler = (
  request: Record<string, unknown>,
  response: FakeResponse,
) => Promise<void>;

class FakeResponse {
  public statusCode = 200;
  public payload: unknown;
  public headers = new Map<string, string>();

  public set(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  public status(code: number): this {
    this.statusCode = code;
    return this;
  }

  public json(payload: unknown): this {
    this.payload = payload;
    return this;
  }

  public send(payload: unknown): this {
    this.payload = payload;
    return this;
  }
}

class JsonSerializingFakeResponse extends FakeResponse {
  public json(payload: unknown): this {
    this.payload = JSON.parse(JSON.stringify(payload));
    return this;
  }
}

function request(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    protocol: "https",
    headers,
    body,
    rawBody,
    ip: "127.0.0.1",
    is(contentType: string) {
      return contentType === "application/json";
    },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    ...overrides,
  };
}

const requester: VerifiedPluginOpsIdentity = {
  actorId: "serviceAccount:requester@example.iam.gserviceaccount.com",
  issuer: "https://accounts.google.com",
  subject: "requester-subject",
  email: "requester@example.iam.gserviceaccount.com",
};
const approver: VerifiedPluginOpsIdentity = {
  actorId: "serviceAccount:approver@example.iam.gserviceaccount.com",
  issuer: "https://accounts.google.com",
  subject: "approver-subject",
  email: "approver@example.iam.gserviceaccount.com",
};

test("public endpoint adapters reject unknown fields and portal bearer sessions", async () => {
  const endpoints = (await import("../src/plugin-auth/endpoints")) as Record<
    string,
    unknown
  >;
  const createPublic = endpoints.createPublicEndpointHandler as
    | ((
        endpoint: string,
        operation: (body: Record<string, unknown>) => Promise<unknown>,
      ) => EndpointHandler)
    | undefined;
  assert.equal(typeof createPublic, "function");
  const handler = createPublic?.("renew-lease", async () => ({ status: "renewed" }));
  assert.ok(handler);

  const unknownField = new FakeResponse();
  await handler(
    request({ binding_id: "bind_test", device_credential: "credential", extra: "reject" }),
    unknownField,
  );
  assert.equal(unknownField.statusCode, 400);
  assert.deepEqual(unknownField.payload, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: "Invalid request body" },
  });

  const portalBearer = new FakeResponse();
  await handler(
    request(
      { binding_id: "bind_test", device_credential: "credential" },
      { authorization: "Bearer portal-firebase-id-token" },
    ),
    portalBearer,
  );
  assert.equal(portalBearer.statusCode, 401);
  assert.deepEqual(portalBearer.payload, {
    ok: false,
    error: {
      code: "AUTH_DOMAIN_MISMATCH",
      message: "Portal sessions are not accepted by plugin endpoints",
    },
  });

  const success = new FakeResponse();
  await handler(
    request({ binding_id: "bind_test", device_credential: "credential" }),
    success,
  );
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.payload, {
    ok: true,
    result: { status: "renewed" },
  });

  let callbackUri = "";
  const callbackHandler = createPublic?.("begin-pairing", async (body) => {
    callbackUri = body.callback_uri as string;
    return { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" };
  });
  assert.ok(callbackHandler);
  const callbackResponse = new FakeResponse();
  await callbackHandler(
    request({
      callback_uri: "https://analytics.example/plugin/pair/callback",
      pairing_id: "pair_test",
      pairing_secret: "pairing-secret",
      state: "oauth-state",
      nonce: "oauth-nonce",
      pkce_challenge: "pkce-challenge-value",
    }),
    callbackResponse,
  );
  assert.equal(callbackResponse.statusCode, 200);
  assert.equal(callbackUri, "https://analytics.example/plugin/pair/callback");
});

test("public pairing and lease endpoint responses preserve the profile allowlist shape", async () => {
  const endpoints = (await import("../src/plugin-auth/endpoints")) as Record<
    string,
    unknown
  >;
  const createPublic = endpoints.createPublicEndpointHandler as (
    endpoint: string,
    operation: (body: Record<string, unknown>) => Promise<unknown>,
  ) => EndpointHandler;
  const result = {
    status: "completed",
    bindingId: "bind_test",
    pluginPrincipalId: "pp_test",
    deviceCredential: "pdc_test",
    email: "artist@xd.com",
    display_name: "Artist",
    avatar_url: "https://images.example/artist.png",
    profile_updated_at: "2026-07-22T02:00:00.000Z",
  };
  const handler = createPublic("poll-pairing", async () => result);
  const response = new FakeResponse();
  await handler(
    request({
      pairing_id: "pair_test",
      pairing_secret: "pairing-secret",
      device_id: "device-test",
      device_challenge: "device-challenge",
    }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual((response.payload as { result: unknown }).result, result);
  assert.deepEqual(Object.keys(result).sort(), [
    "avatar_url",
    "bindingId",
    "deviceCredential",
    "display_name",
    "email",
    "pluginPrincipalId",
    "profile_updated_at",
    "status",
  ]);
  assert.equal(Object.hasOwn(result, "issuer"), false);
  assert.equal(Object.hasOwn(result, "subject"), false);
  assert.equal(Object.hasOwn(result, "credential"), false);
  assert.equal(Object.hasOwn(result, "role"), false);

  const renewed = {
    token: "lease-token",
    issuedAt: "2026-07-22T02:00:00.000Z",
    expiresAt: "2026-07-22T03:00:00.000Z",
    bindingId: "bind_test",
    pluginPrincipalId: "pp_test",
    keyId: "lease-key-1",
    jti: "lease-jti",
    version: 1,
    email: "artist@xd.com",
    display_name: "Artist",
    avatar_url: "https://images.example/artist.png",
    profile_updated_at: "2026-07-22T02:00:00.000Z",
  };
  const renewHandler = createPublic("renew-lease", async () => renewed);
  const renewResponse = new FakeResponse();
  await renewHandler(
    request({ binding_id: "bind_test", device_credential: "credential" }),
    renewResponse,
  );
  assert.equal(renewResponse.statusCode, 200);
  assert.deepEqual((renewResponse.payload as { result: unknown }).result, renewed);
});

test("real pairing and lease services serialize only protocol fields plus the profile allowlist", async () => {
  const endpoints = (await import("../src/plugin-auth/endpoints")) as Record<
    string,
    unknown
  >;
  const createPublic = endpoints.createPublicEndpointHandler as (
    endpoint: string,
    operation: (body: Record<string, unknown>) => Promise<unknown>,
  ) => EndpointHandler;
  const harness = createHarness();
  const created = await harness.pairing.create({
    deviceId: "device-real-service",
    deviceChallenge: "device-real-service-challenge",
    clientVersion: "8.0.0",
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await harness.pairing.beginBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-real-service",
    nonce: "browser-nonce-real-service",
    pkceChallenge: pkceChallengeFor("pkce-verifier-real-service"),
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await harness.pairing.completeBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-real-service",
    callbackUri: "https://analytics.example/plugin/pair/callback",
    authorizationCode: "google-authorization-code-real-service",
    pkceVerifier: "pkce-verifier-real-service",
  });

  const pollHandler = createPublic("poll-pairing", async (body) =>
    harness.pairing.poll({
      pairingId: body.pairing_id as string,
      pairingSecret: body.pairing_secret as string,
      deviceId: body.device_id as string,
      deviceChallenge: body.device_challenge as string,
    }),
  );
  const pollBody = {
    pairing_id: created.pairingId,
    pairing_secret: created.pairingSecret,
    device_id: "device-real-service",
    device_challenge: "device-real-service-challenge",
  };
  const firstPollResponse = new JsonSerializingFakeResponse();
  await pollHandler(request(pollBody), firstPollResponse);
  assert.equal(firstPollResponse.statusCode, 200);
  const firstPollResult = (firstPollResponse.payload as { result: Record<string, unknown> }).result;
  assert.deepEqual(Object.keys(firstPollResult).sort(), [
    "avatar_url",
    "bindingId",
    "deviceCredential",
    "display_name",
    "email",
    "pluginPrincipalId",
    "profile_updated_at",
    "status",
  ]);
  const issued = firstPollResult;

  const replayResponse = new JsonSerializingFakeResponse();
  await pollHandler(request(pollBody), replayResponse);
  assert.equal(replayResponse.statusCode, 200);
  const replayResult = (replayResponse.payload as { result: Record<string, unknown> }).result;
  assert.deepEqual(Object.keys(replayResult).sort(), Object.keys(issued).sort());
  assert.equal(replayResult.email, "artist.b@xd.com");
  assert.equal(replayResult.profile_updated_at, "2026-07-22T02:00:00.000Z");

  await harness.store.runTransaction(async (transaction) => {
    const principal = await transaction.getPrincipal(replayResult.pluginPrincipalId as string);
    assert.ok(principal);
    principal.profileUpdatedAt = "malformed" as unknown as Date;
    await transaction.putPrincipal(principal);
  });

  const renewHandler = createPublic("renew-lease", async (body) =>
    harness.lease.renew({
      bindingId: body.binding_id as string,
      deviceCredential: body.device_credential as string,
    }),
  );
  const renewResponse = new JsonSerializingFakeResponse();
  await renewHandler(
    request({
      binding_id: firstPollResult.bindingId,
      device_credential: firstPollResult.deviceCredential,
    }),
    renewResponse,
  );
  assert.equal(renewResponse.statusCode, 200);
  const renewResult = (renewResponse.payload as { result: Record<string, unknown> }).result;
  assert.deepEqual(Object.keys(renewResult).sort(), [
    "avatar_url",
    "bindingId",
    "display_name",
    "email",
    "expiresAt",
    "issuedAt",
    "jti",
    "keyId",
    "pluginPrincipalId",
    "profile_updated_at",
    "token",
    "version",
  ]);
  assert.match(renewResult.issuedAt as string, /^2026-07-22T02:00:00\.000Z$/);
  assert.match(renewResult.expiresAt as string, /^2026-07-22T03:00:00\.000Z$/);
  assert.equal(renewResult.profile_updated_at, null);
  for (const sensitiveKey of [
    "issuer",
    "subject",
    "firebase_uid",
    "role",
    "enabled",
    "createdAt",
    "disabledAt",
    "disabledReason",
    "credential",
    "secret",
    "avatarUrl",
    "displayName",
  ]) {
    assert.equal(Object.hasOwn(renewResult, sensitiveKey), false, sensitiveKey);
  }
});

test("lease renewal endpoint reports attempts and failures without changing the auth response", async () => {
  const endpoints = (await import("../src/plugin-auth/endpoints")) as Record<string, unknown>;
  const createPublic = endpoints.createPublicEndpointHandler as (
    endpoint: string,
    operation: (body: Record<string, unknown>) => Promise<unknown>,
    limiter: { check(): void; sizeForTest(): number } | undefined,
    monitoring: { onAttempt(): Promise<void>; onFailure(): Promise<void> },
  ) => EndpointHandler;
  const counters: string[] = [];
  const handler = createPublic(
    "renew-lease",
    async () => {
      throw new PluginAuthError("INVALID_DEVICE_CREDENTIAL", "Plugin authorization failed");
    },
    undefined,
    {
      async onAttempt() { counters.push("attempt"); },
      async onFailure() { counters.push("failure"); },
    },
  );
  const response = new FakeResponse();
  await handler(
    request({ binding_id: "bind_test", device_credential: "credential" }),
    response,
  );
  assert.deepEqual(counters, ["attempt", "failure"]);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.payload, {
    ok: false,
    error: { code: "INVALID_DEVICE_CREDENTIAL", message: "Plugin authorization failed" },
  });
});

test("public plugin auth maps domain mismatch to forbidden while portal bearer stays unauthorized", async () => {
  const endpoints = (await import("../src/plugin-auth/endpoints")) as Record<string, unknown>;
  const createPublic = endpoints.createPublicEndpointHandler as (
    endpoint: string,
    operation: (body: Record<string, unknown>) => Promise<unknown>,
  ) => EndpointHandler;
  const handler = createPublic(
    "renew-lease",
    async () => {
      throw new PluginAuthError(
        "AUTH_DOMAIN_MISMATCH",
        "Plugin authentication domain mismatch",
      );
    },
  );
  const response = new FakeResponse();
  await handler(request({ binding_id: "bind_test", device_credential: "credential" }), response);
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.payload, {
    ok: false,
    error: { code: "AUTH_DOMAIN_MISMATCH", message: "Plugin authentication domain mismatch" },
  });
});

test("private ops adapters enforce bearer identity and preserve two-person request/approve/execute boundaries", async () => {
  const endpoints = (await import("../src/plugin-auth/endpoints")) as Record<
    string,
    unknown
  >;
  const createPrivate = endpoints.createPluginOpsEndpointHandler as
    | ((input: {
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
      }) => EndpointHandler)
    | undefined;
  assert.equal(typeof createPrivate, "function");

  const harness = createHarness();
  const paired = await pairAndIssueDeviceCredential(harness);
  const approvals = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  const verifier = {
    async verify(token: string): Promise<VerifiedPluginOpsIdentity> {
      if (token === "requester-token") return requester;
      if (token === "approver-token") return approver;
      throw new PluginAuthError(
        "OPS_IDENTITY_REQUIRED",
        "Plugin operations identity is required",
      );
    },
  };
  const dependencies = { store: harness.store, verifier, approvals };

  const requestHandler = createPrivate?.({
    expectedFields: ["action", "target_id", "parameters"],
    dependencies,
    operation: (body, identity, service) =>
      service.request({
        identity,
        action: body.action as "revoke_binding",
        targetId: body.target_id as string,
        parameters: body.parameters as Record<string, string>,
      }),
  });
  assert.ok(requestHandler);
  const unknownField = new FakeResponse();
  await requestHandler(
    request(
      {
        action: "revoke_binding",
        target_id: paired.issued.bindingId,
        parameters: { reason: "lost_device" },
        approved_by: "attacker@example.iam.gserviceaccount.com",
      },
      { authorization: "Bearer requester-token" },
    ),
    unknownField,
  );
  assert.equal(unknownField.statusCode, 400);
  assert.deepEqual(unknownField.payload, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: "Invalid request body" },
  });
  const wrongAudience = new FakeResponse();
  await requestHandler(
    request(
      {
        action: "revoke_binding",
        target_id: paired.issued.bindingId,
        parameters: { reason: "lost_device" },
      },
      { authorization: "Bearer wrong-audience-token" },
    ),
    wrongAudience,
  );
  assert.equal(wrongAudience.statusCode, 401);

  const requestedResponse = new FakeResponse();
  await requestHandler(
    request(
      {
        action: "revoke_binding",
        target_id: paired.issued.bindingId,
        parameters: { reason: "lost_device" },
      },
      { authorization: "Bearer requester-token" },
    ),
    requestedResponse,
  );
  assert.equal(requestedResponse.statusCode, 200);
  const reviewId = (requestedResponse.payload as { result: { reviewId: string } }).result
    .reviewId;

  const approveHandler = createPrivate?.({
    expectedFields: ["review_id"],
    dependencies,
    operation: async (body, identity, service) => {
      await service.approve({ identity, reviewId: body.review_id as string });
      return { status: "approved" };
    },
  });
  assert.ok(approveHandler);
  const selfApproval = new FakeResponse();
  await approveHandler(
    request(
      { review_id: reviewId },
      { authorization: "Bearer requester-token" },
    ),
    selfApproval,
  );
  assert.equal(selfApproval.statusCode, 400);

  const approved = new FakeResponse();
  await approveHandler(
    request({ review_id: reviewId }, { authorization: "Bearer approver-token" }),
    approved,
  );
  assert.equal(approved.statusCode, 200);

  const executeHandler = createPrivate?.({
    expectedFields: ["review_id"],
    dependencies,
    operation: async (body, identity, service) => {
      await service.execute({ identity, reviewId: body.review_id as string });
      return { status: "executed" };
    },
  });
  assert.ok(executeHandler);
  const executed = new FakeResponse();
  await executeHandler(
    request({ review_id: reviewId }, { authorization: "Bearer requester-token" }),
    executed,
  );
  assert.equal(executed.statusCode, 200);
  assert.equal(
    harness.store
      .exportForTest()
      .bindings.find((binding) => binding.bindingId === paired.issued.bindingId)
      ?.revocationReason,
    "lost_device",
  );
});

test("private ops identity denial survives audit-store failure without running the operation", async () => {
  const endpoints = (await import("../src/plugin-auth/endpoints")) as Record<
    string,
    unknown
  >;
  const createPrivate = endpoints.createPluginOpsEndpointHandler as (input: {
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
  }) => EndpointHandler;
  const harness = createHarness();
  const auditFailingStore: PluginAuthStore = {
    async runTransaction<T>(): Promise<T> {
      throw new Error("audit store unavailable");
    },
  };
  const approvals = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  const auditFailures: string[] = [];
  let operationCalled = false;
  const handler = createPrivate({
    expectedFields: ["review_id"],
    dependencies: {
      store: auditFailingStore,
      verifier: {
        async verify(): Promise<VerifiedPluginOpsIdentity> {
          throw new PluginAuthError(
            "OPS_IDENTITY_REQUIRED",
            "Plugin operations identity is required",
          );
        },
      },
      approvals,
      onAuditFailure: async (reason) => {
        auditFailures.push(reason);
      },
    },
    operation: async () => {
      operationCalled = true;
      return { status: "executed" };
    },
  });
  const response = new FakeResponse();

  await handler(
    request(
      { review_id: "review_denied" },
      { authorization: "Bearer rejected-token" },
    ),
    response,
  );

  assert.equal(operationCalled, false);
  assert.deepEqual(auditFailures, ["plugin_ops_bearer_rejected"]);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.payload, {
    ok: false,
    error: {
      code: "OPS_IDENTITY_REQUIRED",
      message: "Plugin operations identity is required",
    },
  });
});

test("rate limiter prunes expired sources and evicts deterministically at a bounded size", async () => {
  const endpoints = (await import("../src/plugin-auth/endpoints")) as Record<
    string,
    unknown
  >;
  const createRateLimiter = endpoints.createRateLimiter as
    | ((input: { now: () => number; maxEntries: number }) => {
        check(request: Record<string, unknown>, endpoint: string): void;
        sizeForTest(): number;
      })
    | undefined;
  assert.equal(typeof createRateLimiter, "function");
  let now = 1_000;
  const limiter = createRateLimiter?.({ now: () => now, maxEntries: 2 });
  assert.ok(limiter);
  limiter.check(request({}, {}, { ip: "first" }), "poll");
  limiter.check(request({}, {}, { ip: "second" }), "poll");
  limiter.check(request({}, {}, { ip: "third" }), "poll");
  assert.equal(limiter.sizeForTest(), 2);
  now += 61_000;
  limiter.check(request({}, {}, { ip: "fresh" }), "poll");
  assert.equal(limiter.sizeForTest(), 1);
});
