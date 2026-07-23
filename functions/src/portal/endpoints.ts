import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { onRequest, type Request } from "firebase-functions/v2/https";
import type { Response } from "express";

import { FirestorePortalStore } from "./firestore-store";
import { isPortalPolicyKeyId, PortalError, PortalService, type PortalBootstrapAdminConfig, type PortalPolicyKeyring } from "./service";
import type { PortalDateFilter, PortalIdentity } from "./types";

const portalCompanyDomains = defineString("PORTAL_COMPANY_DOMAINS_JSON");
const portalAllowedWebOrigins = defineString("PORTAL_ALLOWED_WEB_ORIGINS_JSON");
const portalPolicyHmacKeys = defineSecret("PORTAL_POLICY_HMAC_KEYS_JSON");
const portalBootstrapAdmin = defineSecret("PORTAL_BOOTSTRAP_ADMIN_JSON");
const portalRuntimeSecrets = [portalPolicyHmacKeys, portalBootstrapAdmin];
const maxPortalReportDays = 366;
const maxPortalCursorLength = 1_024;
const dayMilliseconds = 86_400_000;
const portalKeyPattern = /^[A-Za-z0-9._-]{1,128}$/;
const portalDocumentKeyPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const pluginVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type PortalReportKind = "team" | "principal" | "errors" | "error-details";
export type PortalManagementKind = "people" | "policies" | "devices";

function body(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw new PortalError("invalid_request", "A JSON request body is required", 400);
  return request.body as Record<string, unknown>;
}

function invalidReportInput(message: string): never {
  throw new PortalError("invalid_request", message, 400);
}

function companyDate(value: unknown, label: string): { value: string; milliseconds: number } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalidReportInput(`${label} must be a valid company date`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalidReportInput(`${label} must be a valid company date`);
  return { value, milliseconds: parsed.getTime() };
}

function optionalPortalKey(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !portalKeyPattern.test(value)) invalidReportInput(`${label} is invalid`);
  return value;
}

function optionalFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalidReportInput("fingerprint is invalid");
  return value;
}

function optionalPluginVersion(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 64 || !pluginVersionPattern.test(value)) invalidReportInput("plugin_version is invalid");
  return value;
}

function reportLimit(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) invalidReportInput("limit must be an integer from 1 to 100");
  return value;
}

function reportCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > maxPortalCursorLength || !/^[A-Za-z0-9_-]+$/.test(value)) invalidReportInput("cursor is invalid");
  const decoded = Buffer.from(value, "base64url");
  const decodedText = decoded.toString("utf8");
  if (decoded.byteLength < 1 || !decodedText || Buffer.from(decodedText, "utf8").toString("base64url") !== value) invalidReportInput("cursor is invalid");
  return value;
}

function managementCursor(value: unknown, management: PortalManagementKind): string | undefined {
  const encoded = reportCursor(value);
  if (encoded === undefined) return undefined;
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    invalidReportInput("cursor is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidReportInput("cursor is invalid");
  const candidate = parsed as { v?: unknown; kind?: unknown; value?: unknown };
  if (candidate.v !== 1 || candidate.kind !== management || typeof candidate.value !== "string" || !candidate.value) invalidReportInput("cursor is invalid");
  return candidate.value;
}

function encodedManagementPage<T extends { next_cursor: string | null }>(page: T, management: PortalManagementKind): T {
  return {
    ...page,
    next_cursor: page.next_cursor ? Buffer.from(JSON.stringify({ v: 1, kind: management, value: page.next_cursor }), "utf8").toString("base64url") : null,
  };
}

function optionalManagementString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalidReportInput(`${label} is invalid`);
  return value;
}

function reportRequest(input: Record<string, unknown>, report: PortalReportKind): { filter: PortalDateFilter; limit: number; cursor?: string } {
  const from = companyDate(input.from, "from");
  const to = companyDate(input.to, "to");
  if (to.milliseconds < from.milliseconds) invalidReportInput("from must not be later than to");
  if (((to.milliseconds - from.milliseconds) / dayMilliseconds) + 1 > maxPortalReportDays) invalidReportInput(`date range must not exceed ${maxPortalReportDays} days`);
  const result = input.result === undefined
    ? undefined
    : ["succeeded", "failed", "cancelled", "interrupted"].includes(String(input.result)) && typeof input.result === "string"
      ? input.result as PortalDateFilter["result"]
      : invalidReportInput("result is invalid");
  const filter: PortalDateFilter = {
    from: from.value,
    to: to.value,
    toolKey: optionalPortalKey(input.tool_key, "tool_key"),
    actionKey: optionalPortalKey(input.action_key, "action_key"),
    result,
    fingerprint: optionalFingerprint(input.fingerprint),
    pluginVersion: optionalPluginVersion(input.plugin_version),
    pluginPrincipalId: optionalPortalKey(input.plugin_principal_id, "plugin_principal_id"),
  };
  if (report === "error-details" && (!filter.fingerprint || !filter.toolKey || !filter.actionKey)) {
    invalidReportInput("error details require fingerprint, tool_key, and action_key");
  }
  return { filter, limit: reportLimit(input.limit), cursor: reportCursor(input.cursor) };
}

function stringArray(value: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`Invalid ${label}`);
  return parsed.map((item) => item.trim());
}

function domains(): string[] {
  return stringArray(portalCompanyDomains.value(), "portal company domains");
}

function allowedWebOrigins(): string[] {
  return stringArray(portalAllowedWebOrigins.value(), "portal allowed web origins").map((value) => new URL(value).origin);
}

export function parsePortalPolicyKeyring(value: string): PortalPolicyKeyring {
  const parsed = JSON.parse(value) as { currentKeyId?: unknown; previousKeyIds?: unknown; keys?: unknown };
  if (typeof parsed.currentKeyId !== "string" || !Array.isArray(parsed.previousKeyIds) || !parsed.keys || typeof parsed.keys !== "object" || Array.isArray(parsed.keys)) {
    throw new Error("Invalid portal policy HMAC key configuration");
  }
  const keys = parsed.keys as Record<string, unknown>;
  const orderedKeyIds = [parsed.currentKeyId, ...parsed.previousKeyIds];
  if (parsed.previousKeyIds.some((keyId) => typeof keyId !== "string") || new Set(orderedKeyIds).size !== orderedKeyIds.length || orderedKeyIds.length !== Object.keys(keys).length || orderedKeyIds.some((keyId) => typeof keyId !== "string" || !(keyId in keys)) || typeof keys[parsed.currentKeyId] !== "string" || Object.entries(keys).some(([keyId, key]) => !isPortalPolicyKeyId(keyId) || typeof key !== "string" || key.length < 32)) {
    throw new Error("Invalid portal policy HMAC key configuration");
  }
  return { currentKeyId: parsed.currentKeyId, previousKeyIds: parsed.previousKeyIds as string[], keys: keys as Record<string, string> };
}

export function parsePortalBootstrapAdmin(value: string, companyDomains: string[]): PortalBootstrapAdminConfig {
  const parsed = JSON.parse(value) as { bootstrapId?: unknown; email?: unknown };
  const email = typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
  const domain = email.split("@")[1] ?? "";
  const allowed = new Set(companyDomains.map((item) => item.trim().toLowerCase().replace(/^@/, "")));
  if (typeof parsed.bootstrapId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(parsed.bootstrapId) || !/^[^@\s]+@[^@\s]+$/.test(email) || !allowed.has(domain)) {
    throw new Error("Invalid portal bootstrap administrator configuration");
  }
  return { bootstrapId: parsed.bootstrapId, email };
}

function applyCors(response: Response, origin: string): void {
  response.set("Access-Control-Allow-Origin", origin);
  response.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.set("Access-Control-Max-Age", "3600");
  response.set("Vary", "Origin");
}

function requireAllowedOrigin(request: Request, response: Response, origins: Set<string>): string {
  const requested = request.get("origin") ?? "";
  let normalized = "";
  try {
    normalized = new URL(requested).origin;
  } catch {
    throw new PortalError("invalid_origin", "Portal request origin is not allowed", 403);
  }
  if (!origins.has(normalized)) throw new PortalError("invalid_origin", "Portal request origin is not allowed", 403);
  applyCors(response, normalized);
  return normalized;
}

export interface PortalIdentityVerificationOptions {
  companyDomains?: string[];
  verifyIdToken?: (token: string, checkRevoked: boolean) => Promise<DecodedIdToken>;
}

export async function verifyPortalIdentity(request: Request, options: PortalIdentityVerificationOptions = {}): Promise<PortalIdentity> {
  const header = request.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new PortalError("invalid_identity", "Portal sign-in is required");
  let token: DecodedIdToken;
  try {
    const verifier = options.verifyIdToken ?? ((value: string, checkRevoked: boolean) => getAuth().verifyIdToken(value, checkRevoked));
    token = await verifier(match[1], true);
  } catch {
    throw new PortalError("invalid_identity", "Portal sign-in is required");
  }
  if (token.firebase?.sign_in_provider !== "google.com") throw new PortalError("invalid_identity", "Google company sign-in is required");
  const email = String(token.email ?? "").trim().toLowerCase();
  if (options.companyDomains?.length) {
    const allowed = new Set(options.companyDomains.map((value) => value.trim().toLowerCase().replace(/^@/, "")));
    if (!allowed.has(email.split("@")[1] ?? "")) throw new PortalError("company_account_required", "A company account is required");
  }
  return { uid: token.uid, email, emailVerified: token.email_verified === true, displayName: typeof token.name === "string" ? token.name : undefined, photoUrl: typeof token.picture === "string" ? token.picture : undefined };
}

function errorStatus(error: PortalError): number {
  if (error.code === "invalid_request") return 400;
  if (error.code === "not_found") return 404;
  if (["confirmation_required", "last_admin_protected"].includes(error.code)) return 409;
  if (["portal_admin_required", "invalid_origin"].includes(error.code)) return 403;
  return error.status;
}

export function createPortalHttpHandler(input: {
  service: PortalService;
  action: (identity: PortalIdentity, request: Request) => Promise<unknown>;
  resolveIdentity?: (request: Request) => Promise<PortalIdentity>;
  requireMethod?: "GET" | "POST";
  allowedOrigins?: string[];
}) {
  const origins = new Set((input.allowedOrigins ?? []).map((value) => new URL(value).origin));
  return async (request: Request, response: Response): Promise<void> => {
    try {
      requireAllowedOrigin(request, response, origins);
      if (request.method === "OPTIONS") {
        response.status(204).send("");
        return;
      }
      if (input.requireMethod && request.method !== input.requireMethod) throw new PortalError("invalid_request", `${input.requireMethod} is required`, 400);
      if (request.method !== "GET" && (request.rawBody?.byteLength ?? 0) > 262_144) throw new PortalError("invalid_request", "Request is too large", 400);
      const identity = await (input.resolveIdentity ?? verifyPortalIdentity)(request);
      const result = await input.action(identity, request);
      response.status(200).json({ ok: true, result });
    } catch (error) {
      if (!(error instanceof PortalError)) {
        console.error("portal_request_failed", { error_name: error instanceof Error ? error.name : "UnknownError" });
        response.status(500).json({ ok: false, error: { code: "internal_error", message: "Portal request could not be completed" } });
        return;
      }
      response.status(errorStatus(error)).json({ ok: false, error: { code: error.code, message: error.message } });
    }
  };
}

function runPortalReport(service: PortalService, report: PortalReportKind, identity: PortalIdentity, request: Request): Promise<unknown> {
  const parsed = reportRequest(body(request), report);
  if (report === "team") return service.teamSummary(identity, parsed.filter, parsed.limit, parsed.cursor);
  if (report === "principal") return service.principalUsage(identity, parsed.filter, parsed.limit, parsed.cursor);
  if (report === "errors") return service.errorSummary(identity, parsed.filter, parsed.limit, parsed.cursor);
  return service.errorDetails(identity, parsed.filter, parsed.limit, parsed.cursor);
}

async function runPortalManagement(service: PortalService, management: PortalManagementKind, identity: PortalIdentity, request: Request): Promise<unknown> {
  const input = body(request);
  if (management === "devices") {
    const page = await service.pluginDevices(identity, reportLimit(input.limit), managementCursor(input.cursor, management));
    return encodedManagementPage(page, management);
  }
  if (management === "people") {
    if (input.operation === "list") {
      const search = optionalManagementString(input.search, "search");
      const page = await service.listPeople(identity, reportLimit(input.limit), managementCursor(input.cursor, management), search);
      return encodedManagementPage(page, management);
    }
    if (input.operation === "update") {
      if (typeof input.target_uid !== "string" || !portalDocumentKeyPattern.test(input.target_uid)) invalidReportInput("target_uid is invalid");
      const role = input.role === undefined ? undefined : input.role === "visitor" || input.role === "admin" ? input.role : invalidReportInput("role is invalid");
      const status = input.status === undefined ? undefined : input.status === "active" || input.status === "disabled" || input.status === "removed" ? input.status : invalidReportInput("status is invalid");
      const confirmation = optionalManagementString(input.confirmation, "confirmation");
      if (role === undefined && status === undefined) invalidReportInput("A person change is required");
      if (!confirmation) invalidReportInput("confirmation is required");
      return service.updatePerson({ identity, targetUid: input.target_uid, role, status, confirmation });
    }
    invalidReportInput("Unknown people operation");
  }
  if (input.operation === "list") {
    const page = await service.listPolicies(identity, reportLimit(input.limit), managementCursor(input.cursor, management));
    return encodedManagementPage(page, management);
  }
  if (input.operation === "preview") {
    if (typeof input.email !== "string" || !input.email) invalidReportInput("email is invalid");
    return service.previewPolicy(identity, input.email);
  }
  if (input.operation === "upsert") {
    const kind = input.kind === "email" || input.kind === "domain" ? input.kind : invalidReportInput("kind is invalid");
    const role = input.role === "visitor" || input.role === "admin" ? input.role : invalidReportInput("role is invalid");
    if (kind === "domain" && role !== "visitor") invalidReportInput("Domain policies may only grant visitor access");
    if (typeof input.enabled !== "boolean") invalidReportInput("enabled must be a boolean");
    if (typeof input.value !== "string" || !input.value.trim()) invalidReportInput("value is invalid");
    if (typeof input.confirmation !== "string" || !input.confirmation) invalidReportInput("confirmation is required");
    return service.upsertPolicy({ identity, kind, value: input.value, role, enabled: input.enabled, confirmation: input.confirmation });
  }
  invalidReportInput("Unknown policy operation");
}

export function createPortalReportHttpHandler(input: {
  service: PortalService;
  report: PortalReportKind;
  resolveIdentity?: (request: Request) => Promise<PortalIdentity>;
  allowedOrigins?: string[];
}) {
  return createPortalHttpHandler({
    service: input.service,
    requireMethod: "POST",
    allowedOrigins: input.allowedOrigins,
    resolveIdentity: input.resolveIdentity,
    action: (identity, request) => runPortalReport(input.service, input.report, identity, request),
  });
}

export function createPortalManagementHttpHandler(input: {
  service: PortalService;
  management: PortalManagementKind;
  resolveIdentity?: (request: Request) => Promise<PortalIdentity>;
  allowedOrigins?: string[];
}) {
  return createPortalHttpHandler({
    service: input.service,
    requireMethod: "POST",
    allowedOrigins: input.allowedOrigins,
    resolveIdentity: input.resolveIdentity,
    action: (identity, request) => runPortalManagement(input.service, input.management, identity, request),
  });
}

function runtimeService(companyDomains: string[]): PortalService {
  const app = getApps().length > 0 ? getApp() : initializeApp();
  return new PortalService(new FirestorePortalStore(getFirestore(app)), {
    companyDomains,
    policyKeyring: parsePortalPolicyKeyring(portalPolicyHmacKeys.value()),
    bootstrapAdmin: parsePortalBootstrapAdmin(portalBootstrapAdmin.value(), companyDomains),
  });
}

function onPortalRequest(action: (service: PortalService, identity: PortalIdentity, request: Request) => Promise<unknown>, method: "GET" | "POST" = "POST") {
  return onRequest({ timeoutSeconds: 30, memory: "256MiB" as const, cors: false, secrets: portalRuntimeSecrets }, async (request, response) => {
    const companyDomains = domains();
    const service = runtimeService(companyDomains);
    await createPortalHttpHandler({ service, requireMethod: method, allowedOrigins: allowedWebOrigins(), resolveIdentity: (current) => verifyPortalIdentity(current, { companyDomains }), action: (identity, current) => action(service, identity, current) })(request, response);
  });
}

export const portalSession = onPortalRequest((service, identity) => service.currentSession(identity));

export const portalSignIn = onPortalRequest((service, identity) => service.signIn(identity));

export const portalTeamSummary = onPortalRequest((service, identity, request) => runPortalReport(service, "team", identity, request));

export const portalPrincipalUsage = onPortalRequest((service, identity, request) => runPortalReport(service, "principal", identity, request));

export const portalDevices = onPortalRequest((service, identity, request) => runPortalManagement(service, "devices", identity, request));

export const portalErrors = onPortalRequest((service, identity, request) => runPortalReport(service, "errors", identity, request));

export const portalErrorDetails = onPortalRequest((service, identity, request) => runPortalReport(service, "error-details", identity, request));

export const portalPeople = onPortalRequest((service, identity, request) => runPortalManagement(service, "people", identity, request));

export const portalPolicies = onPortalRequest((service, identity, request) => runPortalManagement(service, "policies", identity, request));
