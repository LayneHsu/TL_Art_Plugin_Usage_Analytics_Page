import { createHmac, randomUUID } from "node:crypto";

import runtimeParameters from "../generated/firebase-runtime-parameters.json";

import type {
  ErrorDetailRow,
  ErrorSummaryRow,
  PortalBootstrapMutationInput,
  PortalBootstrapMutationResult,
  PortalAccessPolicy,
  PortalAccessPolicyPublic,
  PortalAuditRecord,
  PortalDateFilter,
  PortalIdentity,
  PortalPage,
  PortalPersonMutationInput,
  PortalPersonMutationResult,
  PortalPolicyPreview,
  PortalPolicyMutationInput,
  PortalPolicyMutationResult,
  PortalQueryAuditMetadata,
  PortalSignInMutationInput,
  PortalSignInMutationResult,
  PluginDeviceRow,
  PortalRole,
  PortalSession,
  PortalStore,
  PortalUser,
  PortalUserPublic,
  PrincipalUsageRow,
  TeamSummaryRow,
  TeamSummaryPage,
} from "./types";
import { signInPolicyRole } from "./policy";
import { normalizePortalUserSearch, portalUserSearchTerms } from "./user-search";

export class PortalError extends Error {
  public constructor(
    public readonly code:
      | "invalid_identity"
      | "company_account_required"
      | "portal_access_denied"
      | "portal_disabled"
      | "portal_admin_required"
      | "portal_role_changed"
      | "invalid_origin"
      | "last_admin_protected"
      | "confirmation_required"
      | "invalid_request"
      | "not_found",
    message: string,
    public readonly status = code === "portal_admin_required" || code === "last_admin_protected" ? 403 : 401,
  ) {
    super(message);
    this.name = "PortalError";
  }
}

export interface PortalServiceOptions {
  companyDomains: string[];
  policyKeyring: PortalPolicyKeyring;
  bootstrapAdmin?: PortalBootstrapAdminConfig;
  now?: () => Date;
  visitorMinimumGroupSize?: number;
}

export interface PortalBootstrapAdminConfig {
  bootstrapId: string;
  email: string;
}

export interface PortalPolicyKeyring {
  currentKeyId: string;
  previousKeyIds: string[];
  keys: Record<string, string>;
}

const portalPolicyKeyIdPattern = new RegExp(runtimeParameters.constraints.portal_policy_hmac_key_id.pattern);

export function isPortalPolicyKeyId(value: string): boolean {
  return value.length <= runtimeParameters.constraints.portal_policy_hmac_key_id.max_length && portalPolicyKeyIdPattern.test(value);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

function policyKey(keyring: PortalPolicyKeyring, keyId = keyring.currentKeyId): string {
  if (!isPortalPolicyKeyId(keyId)) throw new Error("Invalid portal policy key ID");
  const key = keyring.keys[keyId];
  if (typeof key !== "string" || key.length < 32) throw new Error("Invalid portal policy HMAC key");
  return key;
}

function orderedPortalPolicyKeyIds(keyring: PortalPolicyKeyring): string[] {
  if (!Array.isArray(keyring.previousKeyIds)) throw new Error("Invalid portal policy previous key order");
  const keyIds = [keyring.currentKeyId, ...keyring.previousKeyIds];
  if (new Set(keyIds).size !== keyIds.length || keyIds.length !== Object.keys(keyring.keys).length || keyIds.some((keyId) => !(keyId in keyring.keys))) {
    throw new Error("Invalid portal policy previous key order");
  }
  keyIds.forEach((keyId) => policyKey(keyring, keyId));
  return keyIds;
}

export function portalValueHash(value: string, keyring: PortalPolicyKeyring, keyId = keyring.currentKeyId): string {
  return createHmac("sha256", policyKey(keyring, keyId)).update(value).digest("hex");
}

export function portalEmailPolicyId(email: string, keyring: PortalPolicyKeyring, keyId = keyring.currentKeyId): string {
  return `email_${keyId}_${portalValueHash(normalizeEmail(email), keyring, keyId)}`;
}

export function portalDomainPolicyId(domain: string, keyring: PortalPolicyKeyring, keyId = keyring.currentKeyId): string {
  return `domain_${keyId}_${portalValueHash(normalizeDomain(domain), keyring, keyId)}`;
}

function portalPolicyCandidates(kind: "email" | "domain", value: string, keyring: PortalPolicyKeyring) {
  return orderedPortalPolicyKeyIds(keyring).map((keyId) => ({
    policyId: kind === "email" ? portalEmailPolicyId(value, keyring, keyId) : portalDomainPolicyId(value, keyring, keyId),
    valueHash: portalValueHash(value, keyring, keyId),
  }));
}

function assertIdentity(identity: PortalIdentity, domains: Set<string>): string {
  const email = normalizeEmail(identity.email);
  if (!identity.uid || !email || !identity.emailVerified) {
    throw new PortalError("invalid_identity", "Verified company account is required");
  }
  const domain = email.split("@")[1] ?? "";
  if (!domain || !domains.has(domain)) {
    throw new PortalError("company_account_required", "A company account is required");
  }
  return email;
}

function auditRecord(input: {
  actorUid: string;
  action: string;
  targetUid?: string;
  targetPolicyId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  result: PortalAuditRecord["result"];
  reason?: string;
  now: Date;
  query?: PortalQueryAuditMetadata;
}): PortalAuditRecord {
  return {
    audit_id: `paa_${randomUUID().replace(/-/g, "")}`,
    actor_uid: input.actorUid,
    action: input.action,
    ...(input.targetUid ? { target_uid: input.targetUid } : {}),
    ...(input.targetPolicyId ? { target_policy_id: input.targetPolicyId } : {}),
    ...(input.before ? { before: input.before } : {}),
    ...(input.after ? { after: input.after } : {}),
    result: input.result,
    ...(input.reason ? { reason: input.reason } : {}),
    occurred_at: input.now.toISOString(),
    ...(input.query ? { query: input.query } : {}),
  };
}

function boundedLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value), 100)) : 100;
}

function safeKey(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function safeDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? undefined : value;
}

function safeVersion(value: string | undefined): string | undefined {
  return value && value.length <= 64 && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value) ? value : undefined;
}

function safeResult(value: PortalDateFilter["result"]): PortalDateFilter["result"] {
  return value && ["succeeded", "failed", "cancelled", "interrupted"].includes(value) ? value : undefined;
}

function queryAudit(filter: PortalDateFilter, limit: number, cursor?: string): PortalQueryAuditMetadata {
  return {
    ...(safeDate(filter.from) ? { from: safeDate(filter.from) } : {}),
    ...(safeDate(filter.to) ? { to: safeDate(filter.to) } : {}),
    ...(safeKey(filter.toolKey) ? { tool_key: safeKey(filter.toolKey) } : {}),
    ...(safeKey(filter.actionKey) ? { action_key: safeKey(filter.actionKey) } : {}),
    ...(safeResult(filter.result) ? { result: safeResult(filter.result) } : {}),
    ...(safeKey(filter.pluginPrincipalId) ? { plugin_principal_id: safeKey(filter.pluginPrincipalId) } : {}),
    ...(filter.fingerprint && /^[a-f0-9]{64}$/.test(filter.fingerprint) ? { fingerprint: filter.fingerprint } : {}),
    ...(safeVersion(filter.pluginVersion) ? { plugin_version: safeVersion(filter.pluginVersion) } : {}),
    limit: boundedLimit(limit),
    cursor_present: Boolean(cursor),
  };
}

function publicUser(user: PortalUser): PortalSession {
  return {
    uid: user.uid,
    email: user.normalized_email,
    display_name: user.display_name,
    photo_url: user.photo_url,
    role: user.role,
    status: "active",
    first_login_at: user.first_login_at,
    last_login_at: user.last_login_at,
  };
}

function publicPerson(user: PortalUser): PortalUserPublic {
  return {
    uid: user.uid,
    normalized_email: user.normalized_email,
    display_name: user.display_name,
    photo_url: user.photo_url,
    role: user.role,
    status: user.status,
    first_login_at: user.first_login_at,
    last_login_at: user.last_login_at,
  };
}

function publicPolicy(policy: PortalAccessPolicy): PortalAccessPolicyPublic {
  return {
    policy_id: policy.policy_id,
    kind: policy.kind,
    normalized_value: policy.normalized_value,
    role: policy.role,
    enabled: policy.enabled,
    updated_at: policy.updated_at,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cursorValue(cursor: string | undefined): string | null {
  if (!cursor) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new PortalError("invalid_request", "Invalid page cursor", 400);
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (!decoded || Buffer.from(decoded, "utf8").toString("base64url") !== cursor) throw new PortalError("invalid_request", "Invalid page cursor", 400);
  return decoded;
}

function pageRows<T>(values: T[], limit: number, cursor: string | undefined, key: (value: T) => string): PortalPage<T> {
  const ordered = [...values].sort((left, right) => key(left).localeCompare(key(right)));
  const after = cursorValue(cursor);
  const found = after === null ? 0 : ordered.findIndex((value) => key(value) > after);
  const start = found < 0 ? ordered.length : found;
  const items = ordered.slice(start, start + limit).map(clone);
  const next = start + limit < ordered.length && items.length ? Buffer.from(key(items[items.length - 1]), "utf8").toString("base64url") : null;
  return { items, next_cursor: next };
}

function matchesResult(row: TeamSummaryRow | PrincipalUsageRow, result: PortalDateFilter["result"]): boolean {
  if (!result) return true;
  return row[`run_${result}` as "run_succeeded" | "run_failed" | "run_cancelled" | "run_interrupted"] > 0;
}

export class PortalService {
  private readonly domains: Set<string>;
  private readonly clock: () => Date;
  private readonly minimumGroupSize: number;
  private readonly policyKeyring: PortalPolicyKeyring;
  private readonly bootstrapAdmin: PortalBootstrapAdminConfig | null;

  public constructor(private readonly store: PortalStore, options: PortalServiceOptions) {
    this.domains = new Set(options.companyDomains.map(normalizeDomain).filter(Boolean));
    this.clock = options.now ?? (() => new Date());
    this.minimumGroupSize = options.visitorMinimumGroupSize ?? 2;
    this.policyKeyring = options.policyKeyring;
    if (this.domains.size === 0) throw new Error("At least one company domain is required");
    portalPolicyCandidates("domain", [...this.domains][0], this.policyKeyring);
    this.bootstrapAdmin = options.bootstrapAdmin
      ? { bootstrapId: options.bootstrapAdmin.bootstrapId.trim(), email: normalizeEmail(options.bootstrapAdmin.email) }
      : null;
    if (this.bootstrapAdmin) {
      const bootstrapDomain = this.bootstrapAdmin.email.split("@")[1] ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(this.bootstrapAdmin.bootstrapId) || !this.domains.has(bootstrapDomain)) {
        throw new Error("Invalid portal bootstrap administrator configuration");
      }
    }
  }

  public async signIn(identity: PortalIdentity): Promise<PortalSession> {
    const email = assertIdentity(identity, this.domains);
    const now = this.clock();
    const domain = email.split("@")[1] ?? "";
    const displayName = (identity.displayName ?? email.split("@")[0]).trim().slice(0, 128);
    const photoUrl = identity.photoUrl?.trim().slice(0, 2048) || null;
    if (this.bootstrapAdmin?.email === email) {
      const bootstrapAudit = auditRecord({ actorUid: identity.uid, action: "portal_first_admin_bootstrap", targetUid: identity.uid, result: "succeeded", now });
      const bootstrap = await this.store.bootstrapFirstAdmin({
        bootstrapId: this.bootstrapAdmin.bootstrapId,
        uid: identity.uid,
        normalizedEmail: email,
        displayName,
        photoUrl,
        auditId: bootstrapAudit.audit_id,
        occurredAt: now.toISOString(),
      });
      if (bootstrap.status === "created") return publicUser(bootstrap.user);
    }
    const audit = auditRecord({ actorUid: identity.uid, action: "portal_sign_in", targetUid: identity.uid, result: "succeeded", now });
    const result = await this.store.signInUser({
      uid: identity.uid,
      normalizedEmail: email,
      displayName,
      photoUrl,
      emailPolicyCandidates: portalPolicyCandidates("email", email, this.policyKeyring),
      domainPolicyCandidates: portalPolicyCandidates("domain", domain, this.policyKeyring),
      auditId: audit.audit_id,
      occurredAt: now.toISOString(),
    });
    if (result.status === "disabled") throw new PortalError("portal_disabled", "Portal access is disabled");
    if (result.status === "access_denied") throw new PortalError("portal_access_denied", "Portal access has not been authorized");
    return publicUser(result.user);
  }

  public async currentSession(identity: PortalIdentity): Promise<PortalSession> {
    assertIdentity(identity, this.domains);
    const user = await this.store.getUser(identity.uid);
    if (!user || user.status !== "active") throw new PortalError("portal_access_denied", "Portal access is not available");
    return publicUser(user);
  }

  public async teamSummary(identity: PortalIdentity, filter: PortalDateFilter = { from: "1970-01-01", to: "9999-12-31" }, limit = 100, cursor?: string): Promise<TeamSummaryPage> {
    return this.runAuditedQuery(identity, "team_summary_query", { ...queryAudit(filter, limit, cursor), scope: "team_summary" }, async () => {
      const session = await this.currentSession(identity);
      const result = await this.store.listTeamAggregates(filter, boundedLimit(limit), cursor, session.role === "admin" ? 0 : this.minimumGroupSize);
      const latest = await this.currentSession(identity);
      if (latest.role !== session.role) throw new PortalError("portal_role_changed", "Portal role changed during the request", 409);
      return result;
    });
  }

  public async errorSummary(identity: PortalIdentity, filter: PortalDateFilter, limit = 100, cursor?: string): Promise<PortalPage<ErrorSummaryRow>> {
    return this.runAuditedQuery(identity, "error_summary_query", { ...queryAudit(filter, limit, cursor), scope: "error_summary" }, async () => {
      const session = await this.currentSession(identity);
      const result = await this.store.listErrorAggregates(filter, boundedLimit(limit), cursor, session.role === "admin" ? 0 : this.minimumGroupSize);
      const latest = await this.currentSession(identity);
      if (latest.role !== session.role) throw new PortalError("portal_role_changed", "Portal role changed during the request", 409);
      return result;
    });
  }

  public async principalUsage(identity: PortalIdentity, filter: PortalDateFilter, limit = 100, cursor?: string): Promise<PortalPage<PrincipalUsageRow>> {
    const query = queryAudit(filter, limit, cursor);
    let actorUid = identity.uid;
    try {
      const session = await this.requireAdmin(identity);
      actorUid = session.uid;
      const rows = await this.store.listPrincipalAggregates(filter, boundedLimit(limit), cursor);
      await this.requireAdmin(identity);
      await this.store.writeAudit(auditRecord({ actorUid, action: "principal_usage_query", result: "succeeded", now: this.clock(), query }));
      return rows;
    } catch (error) {
      const result = error instanceof PortalError && ["portal_admin_required", "portal_access_denied", "portal_disabled"].includes(error.code) ? "denied" : "failed";
      await this.store.writeAudit(auditRecord({ actorUid, action: "principal_usage_query", result, now: this.clock(), query })).catch(() => undefined);
      throw error;
    }
  }

  public async pluginDevices(identity: PortalIdentity, limit = 100, cursor?: string): Promise<PortalPage<PluginDeviceRow>> {
    const query: PortalQueryAuditMetadata = { scope: "all_plugin_devices", limit: boundedLimit(limit), cursor_present: Boolean(cursor) };
    let actorUid = identity.uid;
    try {
      const session = await this.requireAdmin(identity);
      actorUid = session.uid;
      const page = await this.store.listPluginDevices({ limit: boundedLimit(limit), cursor });
      await this.requireAdmin(identity);
      const result = {
        items: page.items.map((device) => ({
          binding_id: device.binding_id,
          plugin_principal_id: device.plugin_principal_id,
          status: device.status,
          created_at: device.created_at,
          last_seen_at: device.last_seen_at,
          revoked_at: device.revoked_at,
        })),
        next_cursor: page.next_cursor,
      };
      await this.store.writeAudit(auditRecord({ actorUid, action: "plugin_device_query", result: "succeeded", now: this.clock(), query }));
      return result;
    } catch (error) {
      const result = error instanceof PortalError && ["portal_admin_required", "portal_access_denied", "portal_disabled"].includes(error.code) ? "denied" : "failed";
      await this.store.writeAudit(auditRecord({ actorUid, action: "plugin_device_query", result, now: this.clock(), query })).catch(() => undefined);
      throw error;
    }
  }

  public async errorDetails(identity: PortalIdentity, filter: PortalDateFilter, limit = 100, cursor?: string): Promise<PortalPage<ErrorDetailRow>> {
    const query = queryAudit(filter, limit, cursor);
    let actorUid = identity.uid;
    try {
      const session = await this.requireAdmin(identity);
      actorUid = session.uid;
      if (!filter.fingerprint || !/^[a-f0-9]{64}$/.test(filter.fingerprint)) throw new PortalError("invalid_request", "A valid error fingerprint is required", 400);
      if (!filter.toolKey || safeKey(filter.toolKey) !== filter.toolKey || !filter.actionKey || safeKey(filter.actionKey) !== filter.actionKey) throw new PortalError("invalid_request", "Valid tool and action keys are required", 400);
      if (filter.pluginVersion && safeVersion(filter.pluginVersion) !== filter.pluginVersion) throw new PortalError("invalid_request", "Invalid plugin version", 400);
      const page = await this.store.listErrorDetails(filter, boundedLimit(limit), cursor);
      await this.requireAdmin(identity);
      const result = {
        items: page.items.map((row) => ({ event_id: row.event_id, plugin_principal_id: row.plugin_principal_id, display_name: row.display_name, email: row.email, binding_id: row.binding_id, tool_key: row.tool_key, action_key: row.action_key, event_type: row.event_type, plugin_version: row.plugin_version, observed_at: row.observed_at, received_at: row.received_at })),
        next_cursor: page.next_cursor,
      };
      await this.store.writeAudit(auditRecord({ actorUid, action: "error_detail_query", result: "succeeded", now: this.clock(), query }));
      return result;
    } catch (error) {
      const result = error instanceof PortalError && ["portal_admin_required", "portal_access_denied", "portal_disabled"].includes(error.code) ? "denied" : "failed";
      await this.store.writeAudit(auditRecord({ actorUid, action: "error_detail_query", result, now: this.clock(), query })).catch(() => undefined);
      throw error;
    }
  }

  public async listPeople(identity: PortalIdentity, limit = 100, cursor?: string, search?: string): Promise<PortalPage<PortalUserPublic>> {
    const normalizedSearch = search?.trim().toLowerCase();
    const query: PortalQueryAuditMetadata = { scope: "portal_people", search_present: Boolean(normalizedSearch), limit: boundedLimit(limit), cursor_present: Boolean(cursor) };
    return this.runAuditedQuery(identity, "portal_people_query", query, async () => {
      await this.requireAdmin(identity);
      const page = await this.store.listUsers({ limit: boundedLimit(limit), cursor, search: normalizedSearch });
      await this.requireAdmin(identity);
      return { items: page.items.map(publicPerson), next_cursor: page.next_cursor };
    });
  }

  public async listPolicies(identity: PortalIdentity, limit = 100, cursor?: string): Promise<PortalPage<PortalAccessPolicyPublic>> {
    const query: PortalQueryAuditMetadata = { scope: "portal_policies", limit: boundedLimit(limit), cursor_present: Boolean(cursor) };
    return this.runAuditedQuery(identity, "portal_policy_list_query", query, async () => {
      await this.requireAdmin(identity);
      const page = await this.store.listPolicies({ limit: boundedLimit(limit), cursor });
      await this.requireAdmin(identity);
      return { items: page.items.map(publicPolicy), next_cursor: page.next_cursor };
    });
  }

  public async previewPolicy(identity: PortalIdentity, value: string): Promise<PortalPolicyPreview> {
    const query: PortalQueryAuditMetadata = { scope: "portal_policy_preview", search_present: Boolean(value.trim()), limit: 1, cursor_present: false };
    return this.runAuditedQuery(identity, "portal_policy_preview_query", query, async () => {
      await this.requireAdmin(identity);
      const email = normalizeEmail(value);
      const parts = email.split("@");
      if (parts.length !== 2 || !parts[0] || !this.domains.has(parts[1])) {
        throw new PortalError("company_account_required", "A company email is required", 400);
      }
      const policy = await this.resolvePolicy(email);
      await this.requireAdmin(identity);
      if (!policy) {
        return { normalized_email: email, access: "denied", role: null, matched_by: "none", matched_value: null };
      }
      return {
        normalized_email: email,
        access: "granted",
        role: policy.role,
        matched_by: policy.kind,
        matched_value: policy.normalized_value,
      };
    });
  }

  public async updatePerson(input: {
    identity: PortalIdentity;
    targetUid: string;
    role?: PortalRole;
    status?: "active" | "disabled" | "removed";
    confirmation?: string;
  }): Promise<PortalSession> {
    let actor: PortalSession;
    try {
      actor = await this.requireAdmin(input.identity);
    } catch (error) {
      await this.denyManagement(input.identity.uid, "portal_person_updated", input.targetUid || undefined, undefined);
      throw error;
    }
    if (!input.targetUid || (input.role === undefined && input.status === undefined)) {
      await this.denyManagement(actor.uid, "portal_person_updated", input.targetUid || undefined, undefined);
      throw new PortalError("invalid_request", "A person change is required", 400);
    }
    if (input.targetUid === actor.uid) {
      await this.denyManagement(actor.uid, "portal_person_updated", input.targetUid, undefined);
      throw new PortalError("confirmation_required", "Administrators cannot change their own access", 409);
    }
    if (input.confirmation !== input.targetUid) {
      await this.denyManagement(actor.uid, "portal_person_updated", input.targetUid, undefined);
      throw new PortalError("confirmation_required", "Explicit target confirmation is required", 409);
    }
    const now = this.clock();
    const audit = auditRecord({ actorUid: actor.uid, action: "portal_person_updated", targetUid: input.targetUid, result: "succeeded", now });
    const result = await this.store.mutatePerson({ actorUid: actor.uid, targetUid: input.targetUid, role: input.role, status: input.status, auditId: audit.audit_id, occurredAt: now.toISOString() });
    if (result.status === "actor_not_admin") throw new PortalError("portal_admin_required", "Administrator access is required");
    if (result.status === "target_not_found") throw new PortalError("not_found", "Portal user was not found", 404);
    if (result.status === "last_admin") throw new PortalError("last_admin_protected", "The last active administrator cannot be removed", 409);
    return publicUser(result.user);
  }

  public async upsertPolicy(input: {
    identity: PortalIdentity;
    kind: "email" | "domain";
    value: string;
    role: PortalRole;
    enabled: boolean;
    confirmation?: string;
  }): Promise<PortalAccessPolicyPublic> {
    let actor: PortalSession;
    try {
      actor = await this.requireAdmin(input.identity);
    } catch (error) {
      await this.denyManagement(input.identity.uid, "portal_policy_updated", undefined, undefined);
      throw error;
    }
    const value = input.kind === "email" ? normalizeEmail(input.value) : normalizeDomain(input.value);
    const policyId = input.kind === "email" ? portalEmailPolicyId(value, this.policyKeyring) : portalDomainPolicyId(value, this.policyKeyring);
    if (!value || input.confirmation !== value) {
      await this.denyManagement(actor.uid, "portal_policy_updated", undefined, policyId);
      throw new PortalError("confirmation_required", "Explicit policy confirmation is required", 409);
    }
    if (input.kind === "domain" && input.role !== "visitor") {
      await this.denyManagement(actor.uid, "portal_policy_updated", undefined, policyId);
      throw new PortalError("invalid_request", "Domain policies may only grant visitor access", 400);
    }
    if (input.kind === "email" && (!value.includes("@") || !this.domains.has(value.split("@")[1] ?? ""))) {
      await this.denyManagement(actor.uid, "portal_policy_updated", undefined, policyId);
      throw new PortalError("company_account_required", "A company email is required");
    }
    const now = this.clock();
    const policy: PortalAccessPolicy = { policy_id: policyId, kind: input.kind, value_hash: portalValueHash(value, this.policyKeyring), normalized_value: value, role: input.role, enabled: input.enabled, updated_at: now.toISOString(), updated_by: actor.uid };
    const audit = auditRecord({ actorUid: actor.uid, action: "portal_policy_updated", targetPolicyId: policyId, result: "succeeded", now });
    const result = await this.store.mutatePolicy({ actorUid: actor.uid, policy, auditId: audit.audit_id, occurredAt: now.toISOString() });
    if (result.status === "actor_not_admin") throw new PortalError("portal_admin_required", "Administrator access is required");
    return publicPolicy(result.policy);
  }

  private async denyManagement(actorUid: string, action: string, targetUid?: string, targetPolicyId?: string): Promise<void> {
    await this.store.writeAudit(auditRecord({ actorUid, action, targetUid, targetPolicyId, result: "denied", now: this.clock() })).catch(() => undefined);
  }

  private async runAuditedQuery<T>(identity: PortalIdentity, action: string, query: PortalQueryAuditMetadata, operation: () => Promise<T>): Promise<T> {
    const actorUid = identity.uid;
    try {
      const result = await operation();
      await this.store.writeAudit(auditRecord({ actorUid, action, result: "succeeded", now: this.clock(), query }));
      return result;
    } catch (error) {
      const deniedCodes = new Set(["invalid_identity", "company_account_required", "portal_access_denied", "portal_disabled", "portal_admin_required", "portal_role_changed"]);
      const denied = error instanceof PortalError && deniedCodes.has(error.code);
      await this.store.writeAudit(auditRecord({
        actorUid,
        action,
        result: denied ? "denied" : "failed",
        reason: denied && error instanceof PortalError ? error.code : "internal_failure",
        now: this.clock(),
        query,
      })).catch(() => undefined);
      throw error;
    }
  }

  private async requireAdmin(identity: PortalIdentity): Promise<PortalSession> {
    const session = await this.currentSession(identity);
    if (session.role !== "admin") throw new PortalError("portal_admin_required", "Administrator access is required");
    return session;
  }

  private async resolvePolicy(email: string): Promise<PortalAccessPolicy | null> {
    for (const candidate of portalPolicyCandidates("email", email, this.policyKeyring)) {
      const exact = await this.store.getPolicy(candidate.policyId);
      if (exact) {
        if (exact.enabled) return exact;
        break;
      }
    }
    const domain = email.split("@")[1] ?? "";
    for (const candidate of portalPolicyCandidates("domain", domain, this.policyKeyring)) {
      const fallback = await this.store.getPolicy(candidate.policyId);
      if (fallback) return fallback.enabled ? fallback : null;
    }
    return null;
  }
}

export class InMemoryPortalStore implements PortalStore {
  public readonly users = new Map<string, PortalUser>();
  public readonly policies = new Map<string, PortalAccessPolicy>();
  public readonly audits: PortalAuditRecord[] = [];
  public teamRows: TeamSummaryRow[] = [];
  public principalRows: PrincipalUsageRow[] = [];
  public deviceRows: PluginDeviceRow[] = [];
  public errorRows: ErrorSummaryRow[] = [];
  public errorDetailRows: Array<ErrorDetailRow & { fingerprint: string }> = [];
  private readonly consumedBootstrapIds = new Set<string>();
  private mutationTail: Promise<void> = Promise.resolve();

  private async serializeMutation<T>(operation: () => T): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return operation(); } finally { release(); }
  }

  public async getUser(uid: string): Promise<PortalUser | null> { return clone(this.users.get(uid) ?? null); }
  public async putUser(user: PortalUser): Promise<void> { this.users.set(user.uid, clone(user)); }
  public async listUsers(input: { limit: number; cursor?: string; search?: string }): Promise<PortalPage<PortalUser>> {
    const search = normalizePortalUserSearch(input.search ?? "");
    const values = [...this.users.values()].filter((user) => !search || portalUserSearchTerms(user).includes(search)).sort((left, right) => left.uid.localeCompare(right.uid));
    const start = input.cursor ? Math.max(values.findIndex((user) => user.uid === input.cursor) + 1, 0) : 0;
    const items = values.slice(start, start + input.limit).map(clone);
    return { items, next_cursor: start + input.limit < values.length && items.length ? items[items.length - 1].uid : null };
  }
  public async countActiveAdmins(): Promise<number> { return [...this.users.values()].filter((user) => user.status === "active" && user.role === "admin").length; }
  public async getPolicy(policyId: string): Promise<PortalAccessPolicy | null> { return clone(this.policies.get(policyId) ?? null); }
  public async putPolicy(policy: PortalAccessPolicy): Promise<void> { this.policies.set(policy.policy_id, clone(policy)); }
  public async listPolicies(input: { limit: number; cursor?: string }): Promise<PortalPage<PortalAccessPolicy>> {
    const values = [...this.policies.values()].sort((left, right) => left.policy_id.localeCompare(right.policy_id));
    const start = input.cursor ? Math.max(values.findIndex((policy) => policy.policy_id === input.cursor) + 1, 0) : 0;
    const items = values.slice(start, start + input.limit).map(clone);
    return { items, next_cursor: start + input.limit < values.length && items.length ? items[items.length - 1].policy_id : null };
  }
  public async writeAudit(record: PortalAuditRecord): Promise<void> { this.audits.push(clone(record)); }
  public async bootstrapFirstAdmin(input: PortalBootstrapMutationInput): Promise<PortalBootstrapMutationResult> {
    return this.serializeMutation(() => {
      const audit = (result: "succeeded" | "denied", reason?: string): PortalAuditRecord => ({
        audit_id: input.auditId,
        actor_uid: input.uid,
        action: "portal_first_admin_bootstrap",
        target_uid: input.uid,
        result,
        ...(reason ? { reason } : {}),
        occurred_at: input.occurredAt,
      });
      if (this.consumedBootstrapIds.has(input.bootstrapId)) {
        this.audits.push(audit("denied", "bootstrap_already_consumed"));
        return { status: "already_consumed" };
      }
      const existing = this.users.get(input.uid);
      if (existing && existing.status !== "active") {
        this.consumedBootstrapIds.add(input.bootstrapId);
        this.audits.push(audit("denied", "bootstrap_identity_not_eligible"));
        return { status: "identity_not_eligible" };
      }
      if ([...this.users.values()].some((user) => user.role === "admin" && user.status === "active")) {
        this.consumedBootstrapIds.add(input.bootstrapId);
        this.audits.push(audit("denied", "active_admin_exists"));
        return { status: "active_admin_exists" };
      }
      const next: PortalUser = existing
        ? { ...existing, normalized_email: input.normalizedEmail, display_name: input.displayName, photo_url: input.photoUrl, role: "admin", last_login_at: input.occurredAt, updated_at: input.occurredAt }
        : { uid: input.uid, normalized_email: input.normalizedEmail, display_name: input.displayName, photo_url: input.photoUrl, role: "admin", status: "active", first_login_at: input.occurredAt, last_login_at: input.occurredAt, updated_at: input.occurredAt };
      this.users.set(next.uid, clone(next));
      this.consumedBootstrapIds.add(input.bootstrapId);
      this.audits.push({ ...audit("succeeded"), after: { role: "admin", status: "active" } });
      return { status: "created", user: clone(next) };
    });
  }
  public async signInUser(input: PortalSignInMutationInput): Promise<PortalSignInMutationResult> {
    return this.serializeMutation(() => {
      const existing = this.users.get(input.uid);
      const emailMatch = input.emailPolicyCandidates.map((candidate) => ({ candidate, policy: this.policies.get(candidate.policyId) })).find((item) => item.policy);
      const domainMatch = input.domainPolicyCandidates.map((candidate) => ({ candidate, policy: this.policies.get(candidate.policyId) })).find((item) => item.policy);
      const emailPolicy = emailMatch?.policy ?? null;
      const domainPolicy = domainMatch?.policy ?? null;
      const policyRole = signInPolicyRole(input, emailPolicy, domainPolicy);
      const migrate = (match: typeof emailMatch, candidates: typeof input.emailPolicyCandidates): void => {
        const current = candidates[0];
        if (!match?.policy || !current || match.candidate.policyId === current.policyId) return;
        this.policies.delete(match.candidate.policyId);
        this.policies.set(current.policyId, clone({ ...match.policy, policy_id: current.policyId, value_hash: current.valueHash, updated_at: input.occurredAt, updated_by: "system:policy-key-rotation" }));
      };
      migrate(emailMatch, input.emailPolicyCandidates);
      migrate(domainMatch, input.domainPolicyCandidates);
      const denied = (status: "access_denied" | "disabled"): PortalSignInMutationResult => {
        this.audits.push({ audit_id: input.auditId, actor_uid: input.uid, action: "portal_sign_in", target_uid: input.uid, result: "denied", occurred_at: input.occurredAt });
        return { status };
      };
      if (existing?.status === "disabled" || existing?.status === "removed") return denied("disabled");
      if (!existing && !policyRole) return denied("access_denied");
      const next: PortalUser = existing
        ? { ...existing, normalized_email: input.normalizedEmail, display_name: input.displayName, photo_url: input.photoUrl, last_login_at: input.occurredAt, updated_at: input.occurredAt }
        : { uid: input.uid, normalized_email: input.normalizedEmail, display_name: input.displayName, photo_url: input.photoUrl, role: policyRole ?? "visitor", status: "active", first_login_at: input.occurredAt, last_login_at: input.occurredAt, updated_at: input.occurredAt };
      this.users.set(next.uid, clone(next));
      this.audits.push({ audit_id: input.auditId, actor_uid: input.uid, action: "portal_sign_in", target_uid: input.uid, ...(existing ? { before: { role: existing.role, status: existing.status } } : {}), after: { role: next.role, status: next.status }, result: "succeeded", occurred_at: input.occurredAt });
      return { status: "signed_in", user: clone(next) };
    });
  }
  public async mutatePerson(input: PortalPersonMutationInput): Promise<PortalPersonMutationResult> {
    return this.serializeMutation(() => {
      const denied = (): PortalAuditRecord => ({ audit_id: input.auditId, actor_uid: input.actorUid, action: "portal_person_updated", target_uid: input.targetUid, result: "denied", occurred_at: input.occurredAt });
      const actor = this.users.get(input.actorUid);
      if (!actor || actor.role !== "admin" || actor.status !== "active") {
        this.audits.push(denied());
        return { status: "actor_not_admin" };
      }
      const target = this.users.get(input.targetUid);
      if (!target) {
        this.audits.push(denied());
        return { status: "target_not_found" };
      }
      const next: PortalUser = { ...target, role: input.role ?? target.role, status: input.status ?? target.status, updated_at: input.occurredAt };
      const removesActiveAdmin = target.role === "admin" && target.status === "active" && (next.role !== "admin" || next.status !== "active");
      if (removesActiveAdmin && [...this.users.values()].filter((current) => current.role === "admin" && current.status === "active").length <= 1) {
        this.audits.push({ ...denied(), before: { role: target.role, status: target.status }, after: { role: next.role, status: next.status } });
        return { status: "last_admin" };
      }
      this.users.set(next.uid, clone(next));
      this.audits.push({ audit_id: input.auditId, actor_uid: input.actorUid, action: "portal_person_updated", target_uid: input.targetUid, before: { role: target.role, status: target.status }, after: { role: next.role, status: next.status }, result: "succeeded", occurred_at: input.occurredAt });
      return { status: "updated", user: clone(next) };
    });
  }
  public async mutatePolicy(input: PortalPolicyMutationInput): Promise<PortalPolicyMutationResult> {
    return this.serializeMutation(() => {
      const actor = this.users.get(input.actorUid);
      if (!actor || actor.role !== "admin" || actor.status !== "active") {
        this.audits.push({ audit_id: input.auditId, actor_uid: input.actorUid, action: "portal_policy_updated", target_policy_id: input.policy.policy_id, result: "denied", occurred_at: input.occurredAt });
        return { status: "actor_not_admin" };
      }
      const previous = this.policies.get(input.policy.policy_id);
      this.policies.set(input.policy.policy_id, clone(input.policy));
      this.audits.push({ audit_id: input.auditId, actor_uid: input.actorUid, action: "portal_policy_updated", target_policy_id: input.policy.policy_id, ...(previous ? { before: { role: previous.role, enabled: previous.enabled } } : {}), after: { role: input.policy.role, enabled: input.policy.enabled }, result: "succeeded", occurred_at: input.occurredAt });
      return { status: "updated", policy: clone(input.policy) };
    });
  }
  public async listTeamAggregates(filter: PortalDateFilter, limit: number, cursor?: string, minimumDistinctUsers = 0): Promise<TeamSummaryPage> {
    const rows = this.teamRows.filter((row) => (!filter.toolKey || row.tool_key === filter.toolKey) && (!filter.actionKey || row.action_key === filter.actionKey) && row.distinct_users >= minimumDistinctUsers && matchesResult(row, filter.result));
    return {
      ...pageRows(rows, limit, cursor, (row) => `${row.tool_key}\u0000${row.action_key}`),
      summary: rows.reduce((total, row) => ({ run_started: total.run_started + row.run_started, run_succeeded: total.run_succeeded + row.run_succeeded, run_failed: total.run_failed + row.run_failed, run_cancelled: total.run_cancelled + row.run_cancelled, run_interrupted: total.run_interrupted + row.run_interrupted, distinct_users: Math.max(total.distinct_users, row.distinct_users) }), { run_started: 0, run_succeeded: 0, run_failed: 0, run_cancelled: 0, run_interrupted: 0, distinct_users: 0 }),
      failure_trend: [],
    };
  }
  public async listPrincipalAggregates(filter: PortalDateFilter, limit: number, cursor?: string): Promise<PortalPage<PrincipalUsageRow>> {
    const rows = this.principalRows.filter((row) => (!filter.pluginPrincipalId || row.plugin_principal_id === filter.pluginPrincipalId) && (!filter.toolKey || row.tool_key === filter.toolKey) && (!filter.actionKey || row.action_key === filter.actionKey) && matchesResult(row, filter.result));
    return pageRows(rows, limit, cursor, (row) => `${row.plugin_principal_id}\u0000${row.tool_key}\u0000${row.action_key}`);
  }
  public async listPluginDevices(input: { limit: number; cursor?: string }): Promise<PortalPage<PluginDeviceRow>> {
    const values = [...this.deviceRows].sort((left, right) => left.binding_id.localeCompare(right.binding_id));
    const start = input.cursor ? Math.max(values.findIndex((device) => device.binding_id === input.cursor) + 1, 0) : 0;
    const items = values.slice(start, start + input.limit).map(clone);
    return { items, next_cursor: start + input.limit < values.length && items.length ? items[items.length - 1].binding_id : null };
  }
  public async listErrorAggregates(filter: PortalDateFilter, limit: number, cursor?: string, minimumDistinctUsers = 0): Promise<PortalPage<ErrorSummaryRow>> {
    const rows = this.errorRows.filter((row) => row.distinct_users >= minimumDistinctUsers && (!filter.toolKey || row.tool_key === filter.toolKey) && (!filter.actionKey || row.action_key === filter.actionKey) && (!filter.fingerprint || row.fingerprint === filter.fingerprint) && (!filter.pluginVersion || row.affected_versions.includes(filter.pluginVersion)));
    return pageRows(rows, limit, cursor, (row) => `${row.tool_key}\u0000${row.action_key}\u0000${row.fingerprint}`);
  }
  public async listErrorDetails(filter: PortalDateFilter, limit: number, cursor?: string): Promise<PortalPage<ErrorDetailRow>> {
    const rows = this.errorDetailRows.filter((row) => row.fingerprint === filter.fingerprint && row.tool_key === filter.toolKey && row.action_key === filter.actionKey && (!filter.pluginVersion || row.plugin_version === filter.pluginVersion) && row.observed_at.slice(0, 10) >= filter.from && row.observed_at.slice(0, 10) <= filter.to);
    const page = pageRows(rows, limit, cursor, (row) => `${row.observed_at}\u0000${row.event_id}`);
    return { items: page.items.map(({ fingerprint: _fingerprint, ...row }) => row), next_cursor: page.next_cursor };
  }
}
