import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryPortalStore,
  PortalError,
  PortalService as RuntimePortalService,
  portalDomainPolicyId as createPortalDomainPolicyId,
  portalEmailPolicyId as createPortalEmailPolicyId,
} from "../src/portal/service";
import { createPortalHttpHandler, createPortalManagementHttpHandler, createPortalReportHttpHandler, parsePortalBootstrapAdmin, parsePortalPolicyKeyring, verifyPortalIdentity } from "../src/portal/endpoints";
import { FirestorePortalStore } from "../src/portal/firestore-store";

const identity = (uid: string, email: string, name = uid) => ({ uid, email, emailVerified: true, displayName: name });

const policyKeyring = {
  currentKeyId: "k2",
  previousKeyIds: ["k1"],
  keys: {
    k2: "current-portal-policy-hmac-key-material-2026",
    k1: "previous-portal-policy-hmac-key-material-2025",
  },
};

const portalEmailPolicyId = (email: string, keyring = policyKeyring, keyId?: string) => createPortalEmailPolicyId(email, keyring, keyId);
const portalDomainPolicyId = (domain: string, keyring = policyKeyring, keyId?: string) => createPortalDomainPolicyId(domain, keyring, keyId);

class PortalService extends RuntimePortalService {
  public constructor(store: ConstructorParameters<typeof RuntimePortalService>[0], options: Omit<ConstructorParameters<typeof RuntimePortalService>[1], "policyKeyring"> & { policyKeyring?: typeof policyKeyring }) {
    super(store, { policyKeyring, ...options });
  }
}

function user(uid: string, role: "visitor" | "admin", status: "active" | "disabled" | "removed" = "active") {
  return { uid, normalized_email: `${uid}@xindong.com`, display_name: uid, photo_url: null, role, status, first_login_at: null, last_login_at: null, updated_at: "2026-07-23T00:00:00.000Z" } as const;
}

class PortalFakeResponse {
  public statusCode = 200;
  public payload: unknown;
  public headers = new Map<string, string>();
  public set(name: string, value: string): this { this.headers.set(name, value); return this; }
  public status(code: number): this { this.statusCode = code; return this; }
  public json(payload: unknown): this { this.payload = payload; return this; }
  public send(payload: unknown): this { this.payload = payload; return this; }
}

function portalHttpRequest(method: string, origin: string): Record<string, unknown> {
  return {
    method,
    body: {},
    rawBody: Buffer.from("{}"),
    get(name: string) { return name.toLowerCase() === "origin" ? origin : undefined; },
  };
}

type PortalReportKind = "team" | "principal" | "errors" | "error-details";
type PortalManagementKind = "people" | "policies" | "devices";

async function requestPortalReport(
  service: RuntimePortalService,
  report: PortalReportKind,
  requestBody: Record<string, unknown>,
): Promise<PortalFakeResponse> {
  const handler = createPortalReportHttpHandler({
    service,
    report,
    allowedOrigins: ["https://studio.example.github.io"],
    resolveIdentity: async () => identity("admin", "admin@xindong.com"),
  });
  const request = portalHttpRequest("POST", "https://studio.example.github.io");
  request.body = requestBody;
  request.rawBody = Buffer.from(JSON.stringify(requestBody));
  const response = new PortalFakeResponse();
  await handler(request as never, response as never);
  return response;
}

async function requestPortalManagement(
  service: RuntimePortalService,
  management: PortalManagementKind,
  requestBody: Record<string, unknown>,
): Promise<PortalFakeResponse> {
  const handler = createPortalManagementHttpHandler({
    service,
    management,
    allowedOrigins: ["https://studio.example.github.io"],
    resolveIdentity: async () => identity("admin", "admin@xindong.com"),
  });
  const request = portalHttpRequest("POST", "https://studio.example.github.io");
  request.body = requestBody;
  request.rawBody = Buffer.from(JSON.stringify(requestBody));
  const response = new PortalFakeResponse();
  await handler(request as never, response as never);
  return response;
}

test("portal policy IDs are keyed, versioned, and do not reveal the source value", () => {
  const keyedEmailPolicyId = portalEmailPolicyId as unknown as (email: string, keyring: typeof policyKeyring) => string;
  const keyedDomainPolicyId = portalDomainPolicyId as unknown as (domain: string, keyring: typeof policyKeyring) => string;
  const emailId = keyedEmailPolicyId("Artist@Xindong.com", policyKeyring);
  const domainId = keyedDomainPolicyId("Xindong.com", policyKeyring);
  const rotatedEmailId = keyedEmailPolicyId("Artist@Xindong.com", {
    currentKeyId: "k3",
    previousKeyIds: [],
    keys: { k3: "rotated-portal-policy-hmac-key-material-2027" },
  });

  assert.match(emailId, /^email_k2_[a-f0-9]{64}$/);
  assert.match(domainId, /^domain_k2_[a-f0-9]{64}$/);
  assert.notEqual(emailId, rotatedEmailId);
  assert.doesNotMatch(`${emailId}:${domainId}`, /artist|xindong/i);
});

test("portal policy key IDs use the shared 32-character boundary", () => {
  const keyId32 = `k${"a".repeat(31)}`;
  assert.equal(parsePortalPolicyKeyring(JSON.stringify({ currentKeyId: keyId32, previousKeyIds: [], keys: { [keyId32]: "portal-policy-hmac-material-at-least-32-bytes" } })).currentKeyId, keyId32);
  const keyId33 = `k${"a".repeat(32)}`;
  assert.throws(
    () => parsePortalPolicyKeyring(JSON.stringify({ currentKeyId: keyId33, previousKeyIds: [], keys: { [keyId33]: "portal-policy-hmac-material-at-least-32-bytes" } })),
    /Invalid portal policy HMAC key configuration/,
  );
  assert.throws(
    () => parsePortalPolicyKeyring(JSON.stringify({ currentKeyId: "k3", keys: { k3: "current-portal-policy-hmac-key-material-2027", k2: "previous-portal-policy-hmac-key-material-2026" } })),
    /Invalid portal policy HMAC key configuration/,
  );
  assert.deepEqual(
    parsePortalPolicyKeyring(JSON.stringify({ currentKeyId: "k3", previousKeyIds: ["k2", "k1"], keys: { k3: "current-portal-policy-hmac-key-material-2027", k2: "previous-portal-policy-hmac-key-material-2026", k1: "oldest-portal-policy-hmac-key-material-2025" } })).previousKeyIds,
    ["k2", "k1"],
  );
});

test("sign-in reads a previous policy key and migrates it to the current key", async () => {
  const store = new InMemoryPortalStore();
  const email = "artist@xindong.com";
  const previousPolicyId = portalEmailPolicyId(email, policyKeyring, "k1");
  const currentPolicyId = portalEmailPolicyId(email, policyKeyring);
  await store.putPolicy({
    policy_id: previousPolicyId,
    kind: "email",
    value_hash: "legacy-keyed-value",
    normalized_value: email,
    role: "visitor",
    enabled: true,
    updated_at: "2026-07-23T00:00:00.000Z",
    updated_by: "admin",
  });
  const service = new PortalService(store, { companyDomains: ["xindong.com"], policyKeyring });

  assert.equal((await service.signIn(identity("artist", email))).role, "visitor");
  assert.equal((await store.getPolicy(currentPolicyId))?.policy_id, currentPolicyId);
  assert.equal(await store.getPolicy(previousPolicyId), null);
});

test("a disabled current policy blocks an enabled previous-key policy without migration", async () => {
  const store = new InMemoryPortalStore();
  const email = "artist@xindong.com";
  const previousPolicyId = portalEmailPolicyId(email, policyKeyring, "k1");
  const currentPolicyId = portalEmailPolicyId(email, policyKeyring);
  const previousPolicy = {
    policy_id: previousPolicyId,
    kind: "email" as const,
    value_hash: "previous-keyed-value",
    normalized_value: email,
    role: "admin" as const,
    enabled: true,
    updated_at: "2026-07-22T23:00:00.000Z",
    updated_by: "previous-admin",
  };
  const currentPolicy = {
    policy_id: currentPolicyId,
    kind: "email" as const,
    value_hash: "current-keyed-value",
    normalized_value: email,
    role: "visitor" as const,
    enabled: false,
    updated_at: "2026-07-23T00:00:00.000Z",
    updated_by: "current-admin",
  };
  await store.putPolicy(previousPolicy);
  await store.putPolicy(currentPolicy);
  const service = new PortalService(store, { companyDomains: ["xindong.com"], policyKeyring, now: () => new Date("2026-07-23T01:00:00.000Z") });

  await assert.rejects(
    () => service.signIn(identity("artist", email)),
    (error: unknown) => error instanceof PortalError && error.code === "portal_access_denied",
  );
  assert.equal(await store.getUser("artist"), null);
  assert.deepEqual(await store.getPolicy(currentPolicyId), currentPolicy);
  assert.deepEqual(await store.getPolicy(previousPolicyId), previousPolicy);
  const audits = store.audits.filter((audit) => audit.action === "portal_sign_in");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.actor_uid, "artist");
  assert.equal(audits[0]?.target_uid, "artist");
  assert.equal(audits[0]?.result, "denied");
});

test("an ordered three-generation keyring keeps the newest disabled tombstone authoritative under concurrency", async () => {
  const store = new InMemoryPortalStore();
  const email = "artist@xindong.com";
  const threeGenerationKeyring = {
    currentKeyId: "k3",
    previousKeyIds: ["k2", "k1"],
    keys: {
      k3: "current-portal-policy-hmac-key-material-2027",
      k2: "previous-portal-policy-hmac-key-material-2026",
      k1: "oldest-portal-policy-hmac-key-material-2025",
    },
  };
  const oldestPolicyId = portalEmailPolicyId(email, threeGenerationKeyring, "k1");
  const newestPreviousPolicyId = portalEmailPolicyId(email, threeGenerationKeyring, "k2");
  const currentPolicyId = portalEmailPolicyId(email, threeGenerationKeyring, "k3");
  const oldestPolicy = { policy_id: oldestPolicyId, kind: "email" as const, value_hash: "oldest-keyed-value", normalized_value: email, role: "admin" as const, enabled: true, updated_at: "2026-07-21T00:00:00.000Z", updated_by: "oldest-admin" };
  const tombstone = { policy_id: newestPreviousPolicyId, kind: "email" as const, value_hash: "newest-previous-keyed-value", normalized_value: email, role: "visitor" as const, enabled: false, updated_at: "2026-07-22T00:00:00.000Z", updated_by: "newest-previous-admin" };
  await store.putPolicy(oldestPolicy);
  await store.putPolicy(tombstone);
  const service = new PortalService(store, { companyDomains: ["xindong.com"], policyKeyring: threeGenerationKeyring, now: () => new Date("2026-07-23T00:00:00.000Z") });

  const attempts = await Promise.allSettled([
    service.signIn(identity("artist-a", email)),
    service.signIn(identity("artist-b", email)),
  ]);
  assert.equal(attempts.filter((result) => result.status === "rejected" && result.reason instanceof PortalError && result.reason.code === "portal_access_denied").length, 2);
  assert.equal(await store.getUser("artist-a"), null);
  assert.equal(await store.getUser("artist-b"), null);
  assert.equal((await store.getPolicy(currentPolicyId))?.enabled, false);
  assert.equal((await store.getPolicy(currentPolicyId))?.updated_by, "system:policy-key-rotation");
  assert.equal(await store.getPolicy(newestPreviousPolicyId), null);
  assert.deepEqual(await store.getPolicy(oldestPolicyId), oldestPolicy);
  assert.equal(store.audits.filter((audit) => audit.action === "portal_sign_in" && audit.result === "denied").length, 2);
});

test("controlled bootstrap creates and audits the first administrator once", async () => {
  const store = new InMemoryPortalStore();
  const service = new PortalService(store, {
    companyDomains: ["xindong.com"],
    policyKeyring,
    bootstrapAdmin: { bootstrapId: "initial-admin-v1", email: "first.admin@xindong.com" },
  } as never);

  const session = await service.signIn(identity("first-admin", "first.admin@xindong.com", "First Admin"));
  assert.equal(session.role, "admin");
  assert.equal(await store.countActiveAdmins(), 1);
  assert.equal(store.audits.filter((audit) => audit.action === "portal_first_admin_bootstrap" && audit.result === "succeeded").length, 1);

  await assert.rejects(
    () => service.signIn(identity("replay", "first.admin@xindong.com")),
    (error: unknown) => error instanceof PortalError && error.code === "portal_access_denied",
  );
  assert.equal(await store.countActiveAdmins(), 1);
});

test("bootstrap configuration rejects an email without a local part", () => {
  assert.throws(
    () => parsePortalBootstrapAdmin(JSON.stringify({ bootstrapId: "initial-admin-v1", email: "@xindong.com" }), ["xindong.com"]),
    /Invalid portal bootstrap administrator configuration/,
  );
});

test("portal sign-in requires a company account and an explicit policy", async () => {
  const store = new InMemoryPortalStore();
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  await assert.rejects(() => service.signIn(identity("outside", "outside@example.com")), (error: unknown) => error instanceof PortalError && error.code === "company_account_required");
  await assert.rejects(() => service.signIn(identity("artist", "artist@xindong.com")), (error: unknown) => error instanceof PortalError && error.code === "portal_access_denied");
  await store.putPolicy({ policy_id: portalEmailPolicyId("artist@xindong.com"), kind: "email", value_hash: "hash", normalized_value: "artist@xindong.com", role: "visitor", enabled: true, updated_at: new Date().toISOString(), updated_by: "bootstrap" });
  const session = await service.signIn(identity("artist", "artist@xindong.com", "Artist"));
  assert.equal(session.role, "visitor");
  assert.equal(session.email, "artist@xindong.com");
});

test("domain policy grants visitor only and exact email policy wins", async () => {
  const store = new InMemoryPortalStore();
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  await store.putPolicy({ policy_id: portalDomainPolicyId("xindong.com"), kind: "domain", value_hash: "domain", normalized_value: "xindong.com", role: "visitor", enabled: true, updated_at: new Date().toISOString(), updated_by: "bootstrap" });
  assert.equal((await service.signIn(identity("one", "one@xindong.com"))).role, "visitor");
  await store.putUser(user("admin", "admin"));
  const exact = await service.upsertPolicy({ identity: identity("admin", "admin@xindong.com"), kind: "email", value: "one@xindong.com", role: "admin", enabled: true, confirmation: "one@xindong.com" });
  assert.equal(exact.role, "admin");
  assert.equal((await service.signIn(identity("one", "one@xindong.com"))).role, "visitor", "existing portal role is not silently changed by a later policy");
  await assert.rejects(() => service.upsertPolicy({ identity: identity("admin", "admin@xindong.com"), kind: "domain", value: "xindong.com", role: "admin", enabled: true, confirmation: "xindong.com" }), (error: unknown) => error instanceof PortalError && error.code === "invalid_request");
});

test("first sign-in cannot use a stale exact policy after it is disabled", async () => {
  const store = new InMemoryPortalStore();
  const policy = { policy_id: portalEmailPolicyId("artist@xindong.com"), kind: "email" as const, value_hash: "email", normalized_value: "artist@xindong.com", role: "admin" as const, enabled: true, updated_at: new Date().toISOString(), updated_by: "bootstrap" };
  await store.putPolicy(policy);
  const signInUser = store.signInUser.bind(store);
  store.signInUser = async (input) => {
    await store.putPolicy({ ...policy, enabled: false });
    return signInUser(input);
  };
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  await assert.rejects(
    () => service.signIn(identity("artist", "artist@xindong.com")),
    (error: unknown) => error instanceof PortalError && error.code === "portal_access_denied",
  );
  assert.equal(await store.getUser("artist"), null);
});

test("first sign-in uses a concurrently downgraded exact policy role", async () => {
  const store = new InMemoryPortalStore();
  const policy = { policy_id: portalEmailPolicyId("artist@xindong.com"), kind: "email" as const, value_hash: "email", normalized_value: "artist@xindong.com", role: "admin" as const, enabled: true, updated_at: new Date().toISOString(), updated_by: "bootstrap" };
  await store.putPolicy(policy);
  const signInUser = store.signInUser.bind(store);
  store.signInUser = async (input) => {
    await store.putPolicy({ ...policy, role: "visitor" });
    return signInUser(input);
  };
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  const session = await service.signIn(identity("artist", "artist@xindong.com"));
  assert.equal(session.role, "visitor");
  assert.equal((await store.getUser("artist"))?.role, "visitor");
});

test("policy preview reports the final role with email rules before domain rules", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  await store.putPolicy({ policy_id: portalDomainPolicyId("xindong.com"), kind: "domain", value_hash: "domain", normalized_value: "xindong.com", role: "visitor", enabled: true, updated_at: new Date().toISOString(), updated_by: "bootstrap" });
  await store.putPolicy({ policy_id: portalEmailPolicyId("artist@xindong.com"), kind: "email", value_hash: "email", normalized_value: "artist@xindong.com", role: "admin", enabled: true, updated_at: new Date().toISOString(), updated_by: "bootstrap" });

  assert.deepEqual(
    await service.previewPolicy(identity("admin", "admin@xindong.com"), " Artist@Xindong.com "),
    {
      normalized_email: "artist@xindong.com",
      access: "granted",
      role: "admin",
      matched_by: "email",
      matched_value: "artist@xindong.com",
    },
  );

  await store.putPolicy({ policy_id: portalEmailPolicyId("artist@xindong.com"), kind: "email", value_hash: "email", normalized_value: "artist@xindong.com", role: "admin", enabled: false, updated_at: new Date().toISOString(), updated_by: "bootstrap" });
  assert.deepEqual(
    await service.previewPolicy(identity("admin", "admin@xindong.com"), "artist@xindong.com"),
    {
      normalized_email: "artist@xindong.com",
      access: "granted",
      role: "visitor",
      matched_by: "domain",
      matched_value: "xindong.com",
    },
  );

  await store.putPolicy({ policy_id: portalDomainPolicyId("xindong.com"), kind: "domain", value_hash: "domain", normalized_value: "xindong.com", role: "visitor", enabled: false, updated_at: new Date().toISOString(), updated_by: "bootstrap" });
  assert.deepEqual(
    await service.previewPolicy(identity("admin", "admin@xindong.com"), "artist@xindong.com"),
    {
      normalized_email: "artist@xindong.com",
      access: "denied",
      role: null,
      matched_by: "none",
      matched_value: null,
    },
  );
});

test("visitor data is group-protected and principal usage is admin-only", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("visitor", "visitor"));
  await store.putUser(user("admin", "admin"));
  store.teamRows = [{ tool_key: "asset.export", action_key: "run", run_started: 1, run_succeeded: 1, run_failed: 0, run_cancelled: 0, run_interrupted: 0, distinct_users: 1, last_used_at: "2026-07-23T00:00:00.000Z", last_received_at: "2026-07-23T00:00:00.000Z", time_corrected_count: 0 }, { tool_key: "asset.export", action_key: "bulk", run_started: 4, run_succeeded: 3, run_failed: 1, run_cancelled: 0, run_interrupted: 0, distinct_users: 2, last_used_at: "2026-07-23T00:00:00.000Z", last_received_at: "2026-07-23T00:00:00.000Z", time_corrected_count: 0 }];
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  assert.equal((await service.teamSummary(identity("visitor", "visitor@xindong.com"))).items.length, 1);
  await assert.rejects(() => service.principalUsage(identity("visitor", "visitor@xindong.com"), { from: "2026-07-01", to: "2026-07-24" }), (error: unknown) => error instanceof PortalError && error.code === "portal_admin_required");
  await service.principalUsage(identity("admin", "admin@xindong.com"), { from: "2026-07-01", to: "2026-07-24" });
  assert.equal(store.audits.at(-1)?.action, "principal_usage_query");
});

test("principal usage supports an exact immutable principal filter", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  const base = { tool_key: "asset.export", action_key: "run", display_name: "Artist", email: null, profile_updated_at: null, identity_changed: false, run_started: 1, run_succeeded: 1, run_failed: 0, run_cancelled: 0, run_interrupted: 0, last_used_at: "2026-07-23T00:00:00.000Z", last_received_at: "2026-07-23T00:00:00.000Z", time_corrected_count: 0, daily_trend: [{ date: "2026-07-23", run_started: 1, run_failed: 0, run_interrupted: 0 }] };
  store.principalRows = [
    { ...base, plugin_principal_id: "principal_001" },
    { ...base, plugin_principal_id: "principal_002" },
  ];
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  const result = await service.principalUsage(identity("admin", "admin@xindong.com"), { from: "2026-07-01", to: "2026-07-24", pluginPrincipalId: "principal_002" });
  assert.deepEqual(result.items.map((row) => row.plugin_principal_id), ["principal_002"]);
});

test("plugin device queries are admin-only, audited, and return allowlisted fields", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("visitor", "visitor"));
  await store.putUser(user("admin", "admin"));
  store.deviceRows = [{
    binding_id: "binding_001",
    plugin_principal_id: "principal_001",
    status: "active",
    created_at: "2026-07-23T00:00:00.000Z",
    last_seen_at: "2026-07-23T01:00:00.000Z",
    revoked_at: null,
    credentialDigest: "must-not-leak",
    deviceIdDigest: "must-not-leak",
    leaseToken: "must-not-leak",
  } as never];
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  await assert.rejects(
    () => service.pluginDevices(identity("visitor", "visitor@xindong.com")),
    (error: unknown) => error instanceof PortalError && error.code === "portal_admin_required",
  );
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0].action, "plugin_device_query");
  assert.equal(store.audits[0].result, "denied");
  assert.deepEqual(store.audits[0].query, { scope: "all_plugin_devices", limit: 100, cursor_present: false });

  const page = await service.pluginDevices(identity("admin", "admin@xindong.com"));
  assert.deepEqual(page.items, [{
    binding_id: "binding_001",
    plugin_principal_id: "principal_001",
    status: "active",
    created_at: "2026-07-23T00:00:00.000Z",
    last_seen_at: "2026-07-23T01:00:00.000Z",
    revoked_at: null,
  }]);
  assert.equal(store.audits.at(-1)?.action, "plugin_device_query");
  assert.deepEqual(store.audits.at(-1)?.query, { scope: "all_plugin_devices", limit: 100, cursor_present: false });
});

test("portal identity verification checks revocation, Google provider, and company domain", async () => {
  const request = {
    get(name: string) { return name.toLowerCase() === "authorization" ? "Bearer portal-token" : undefined; },
  };
  const calls: Array<{ token: string; checkRevoked: boolean }> = [];
  const verified = await verifyPortalIdentity(request as never, {
    companyDomains: ["xindong.com"],
    verifyIdToken: async (token, checkRevoked) => {
      calls.push({ token, checkRevoked });
      return { uid: "admin", email: "admin@xindong.com", email_verified: true, firebase: { sign_in_provider: "google.com" } } as never;
    },
  });
  assert.equal(verified.uid, "admin");
  assert.deepEqual(calls, [{ token: "portal-token", checkRevoked: true }]);

  for (const claims of [
    { uid: "password", email: "password@xindong.com", email_verified: true, firebase: { sign_in_provider: "password" } },
    { uid: "outside", email: "outside@example.com", email_verified: true, firebase: { sign_in_provider: "google.com" } },
  ]) {
    await assert.rejects(
      () => verifyPortalIdentity(request as never, { companyDomains: ["xindong.com"], verifyIdToken: async () => claims as never }),
      (error: unknown) => error instanceof PortalError && ["invalid_identity", "company_account_required"].includes(error.code),
    );
  }

  await assert.rejects(
    () => verifyPortalIdentity(request as never, { companyDomains: ["xindong.com"], verifyIdToken: async () => { throw new Error("revoked"); } }),
    (error: unknown) => error instanceof PortalError && error.code === "invalid_identity",
  );
});

test("atomic sign-in preserves concurrent role and status changes", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  await store.putUser(user("artist", "admin"));
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  const outcomes = await Promise.allSettled([
    service.signIn(identity("artist", "artist@xindong.com", "Updated Artist")),
    service.updatePerson({ identity: identity("admin", "admin@xindong.com"), targetUid: "artist", role: "visitor", status: "disabled", confirmation: "artist" }),
  ]);
  const finalUser = await store.getUser("artist");
  assert.equal(finalUser?.role, "visitor");
  assert.equal(finalUser?.status, "disabled");
  assert.ok(outcomes.some((result) => result.status === "rejected") || outcomes.every((result) => result.status === "fulfilled"));
});

test("portal store sign-in mutation preserves existing authorization fields atomically", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("artist", "visitor", "disabled"));
  assert.equal(typeof store.signInUser, "function");

  const result = await store.signInUser({
    uid: "artist",
    normalizedEmail: "artist@xindong.com",
    displayName: "Updated Artist",
    photoUrl: "https://example.com/avatar.png",
    emailPolicyCandidates: [{ policyId: portalEmailPolicyId("artist@xindong.com"), valueHash: "test-email-hash" }],
    domainPolicyCandidates: [{ policyId: portalDomainPolicyId("xindong.com"), valueHash: "test-domain-hash" }],
    auditId: "audit_sign_in",
    occurredAt: "2026-07-23T01:00:00.000Z",
  });
  assert.equal(result.status, "disabled");
  assert.equal((await store.getUser("artist"))?.role, "visitor");
  assert.equal((await store.getUser("artist"))?.status, "disabled");
});

test("team summary reports a recoverable role change when an administrator is downgraded during the query", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  store.teamRows = [{ tool_key: "private.tool", action_key: "run", run_started: 1, run_succeeded: 0, run_failed: 1, run_cancelled: 0, run_interrupted: 0, distinct_users: 1, last_used_at: null, last_received_at: null, time_corrected_count: 0 }];
  const list = store.listTeamAggregates.bind(store);
  store.listTeamAggregates = async (...args) => {
    const rows = await list(...args);
    await store.putUser(user("admin", "visitor"));
    return rows;
  };
  const service = new PortalService(store, { companyDomains: ["xindong.com"], visitorMinimumGroupSize: 2 });

  await assert.rejects(
    () => service.teamSummary(identity("admin", "admin@xindong.com")),
    (error: unknown) => error instanceof PortalError && error.code === "portal_role_changed",
  );
});

test("visitor error summaries require a minimum distinct plugin-principal group", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("visitor", "visitor"));
  await store.putUser(user("admin", "admin"));
  const base = { tool_key: "asset.export", action_key: "run", error_category: "internal", count: 1, first_seen_at: "2026-07-23T00:00:00.000Z", recent_seen_at: "2026-07-23T00:00:00.000Z", first_received_at: "2026-07-23T00:00:01.000Z", recent_received_at: "2026-07-23T00:00:01.000Z", time_corrected_count: 0, affected_versions: ["1.0.0"], summaries: [{ summary: "Safe", count: 1 }], status: "open" as const };
  store.errorRows = [
    { ...base, fingerprint: "a".repeat(64), distinct_users: 1 },
    { ...base, fingerprint: "b".repeat(64), distinct_users: 2 },
  ];
  const service = new PortalService(store, { companyDomains: ["xindong.com"], visitorMinimumGroupSize: 2 });

  assert.deepEqual((await service.errorSummary(identity("visitor", "visitor@xindong.com"), { from: "2026-07-23", to: "2026-07-23" })).items.map((row) => row.fingerprint), ["b".repeat(64)]);
  assert.equal((await service.errorSummary(identity("admin", "admin@xindong.com"), { from: "2026-07-23", to: "2026-07-23" })).items.length, 2);
});

test("principal and device query audits include bounded filters for initial denial and success", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("visitor", "visitor"));
  await store.putUser(user("admin", "admin"));
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const filter = { from: "2026-07-01", to: "2026-07-24", toolKey: "asset.export", actionKey: "run", result: "failed" as const, pluginPrincipalId: "principal_001" };

  await assert.rejects(() => service.principalUsage(identity("visitor", "visitor@xindong.com"), filter), PortalError);
  assert.deepEqual(store.audits.at(-1)?.query, { from: "2026-07-01", to: "2026-07-24", tool_key: "asset.export", action_key: "run", result: "failed", plugin_principal_id: "principal_001", limit: 100, cursor_present: false });
  await service.principalUsage(identity("admin", "admin@xindong.com"), filter);
  assert.equal(store.audits.at(-1)?.result, "succeeded");
  assert.deepEqual(store.audits.at(-1)?.query, { from: "2026-07-01", to: "2026-07-24", tool_key: "asset.export", action_key: "run", result: "failed", plugin_principal_id: "principal_001", limit: 100, cursor_present: false });
});

test("admin error details are paged, audited, allowlisted, and denied to visitors", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("visitor", "visitor"));
  await store.putUser(user("admin", "admin"));
  const targetRow = {
    event_id: "event_001",
    plugin_principal_id: "principal_001",
    display_name: "Artist",
    email: "artist@xindong.com",
    binding_id: "binding_001",
    tool_key: "asset.export",
    action_key: "run",
    event_type: "run_failed",
    plugin_version: "1.0.0",
    observed_at: "2026-07-23T00:00:00.000Z",
    received_at: "2026-07-23T00:00:01.000Z",
    fingerprint: "f".repeat(64),
    traceback: "must-not-leak",
  } as never;
  store.errorDetailRows = [
    targetRow,
    { ...targetRow, event_id: "event_other_tool", tool_key: "asset.import" },
    { ...targetRow, event_id: "event_other_action", action_key: "preview" },
    { ...targetRow, event_id: "event_other_version", plugin_version: "2.0.0" },
  ];
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const filter = { from: "2026-07-23", to: "2026-07-23", toolKey: "asset.export", actionKey: "run", fingerprint: "f".repeat(64), pluginVersion: "1.0.0" };

  await assert.rejects(() => service.errorDetails(identity("visitor", "visitor@xindong.com"), filter), (error: unknown) => error instanceof PortalError && error.code === "portal_admin_required");
  assert.equal(store.audits.at(-1)?.action, "error_detail_query");
  assert.equal(store.audits.at(-1)?.result, "denied");

  await assert.rejects(
    () => service.errorDetails(identity("admin", "admin@xindong.com"), { from: "2026-07-23", to: "2026-07-23", fingerprint: "f".repeat(64) }),
    (error: unknown) => error instanceof PortalError && error.code === "invalid_request",
  );

  const page = await service.errorDetails(identity("admin", "admin@xindong.com"), filter, 50);
  assert.deepEqual(page.items.map((row) => row.event_id), ["event_001"]);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ["action_key", "binding_id", "display_name", "email", "event_id", "event_type", "observed_at", "plugin_principal_id", "plugin_version", "received_at", "tool_key"].sort());
  assert.deepEqual(store.audits.at(-1)?.query, { from: "2026-07-23", to: "2026-07-23", tool_key: "asset.export", action_key: "run", fingerprint: "f".repeat(64), plugin_version: "1.0.0", limit: 50, cursor_present: false });
});

test("query audit metadata drops invalid and overlong filter values", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  await service.principalUsage(identity("admin", "admin@xindong.com"), {
    from: "2026-99-99",
    to: "not-a-date",
    toolKey: "x".repeat(129),
    actionKey: "contains spaces",
    result: "unexpected" as never,
    pluginPrincipalId: "p".repeat(129),
    fingerprint: "g".repeat(64),
  }, Number.POSITIVE_INFINITY, Buffer.from("opaque").toString("base64url"));

  assert.deepEqual(store.audits.at(-1)?.query, { limit: 100, cursor_present: true });
});

test("failed plugin device queries write a failed audit result", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  store.listPluginDevices = async () => { throw new Error("storage unavailable"); };
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  await assert.rejects(() => service.pluginDevices(identity("admin", "admin@xindong.com")), /storage unavailable/);
  assert.equal(store.audits.at(-1)?.action, "plugin_device_query");
  assert.equal(store.audits.at(-1)?.result, "failed");
});

test("explicit confirmation and self-administration are enforced", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  await store.putUser(user("second", "admin"));
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  await assert.rejects(() => service.updatePerson({ identity: identity("admin", "admin@xindong.com"), targetUid: "second", status: "disabled" }), (error: unknown) => error instanceof PortalError && error.code === "confirmation_required");
  await service.updatePerson({ identity: identity("admin", "admin@xindong.com"), targetUid: "second", status: "disabled", confirmation: "second" });
  await assert.rejects(() => service.updatePerson({ identity: identity("admin", "admin@xindong.com"), targetUid: "admin", status: "disabled", confirmation: "admin" }), (error: unknown) => error instanceof PortalError && error.code === "confirmation_required");
});

test("portal HTTP boundary allows only configured browser origins", async () => {
  const store = new InMemoryPortalStore();
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  let identityChecks = 0;
  const handler = createPortalHttpHandler({
    service,
    requireMethod: "POST",
    allowedOrigins: ["https://studio.example.github.io"],
    resolveIdentity: async () => { identityChecks += 1; return identity("admin", "admin@xindong.com"); },
    action: async () => ({ available: true }),
  });

  const preflight = new PortalFakeResponse();
  await handler(portalHttpRequest("OPTIONS", "https://studio.example.github.io") as never, preflight as never);
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://studio.example.github.io");
  assert.equal(preflight.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type");
  assert.equal(identityChecks, 0);

  const allowed = new PortalFakeResponse();
  await handler(portalHttpRequest("POST", "https://studio.example.github.io") as never, allowed as never);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://studio.example.github.io");
  assert.equal(identityChecks, 1);

  const denied = new PortalFakeResponse();
  await handler(portalHttpRequest("POST", "https://attacker.example") as never, denied as never);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.payload, { ok: false, error: { code: "invalid_origin", message: "Portal request origin is not allowed" } });
  assert.equal(identityChecks, 1);
  assert.notEqual(denied.headers.get("Access-Control-Allow-Origin"), "*");
});

test("portal HTTP boundary preserves invalid management input as a 400 response", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { logged.push(values); };
  try {
    const handler = createPortalHttpHandler({
      service,
      requireMethod: "POST",
      allowedOrigins: ["https://studio.example.github.io"],
      resolveIdentity: async () => identity("admin", "admin@xindong.com"),
      action: async (actor, request) => {
        const input = request.body as Record<string, unknown>;
        return service.updatePerson({
          identity: actor,
          targetUid: String(input.target_uid ?? ""),
          role: input.role === "visitor" || input.role === "admin" ? input.role : undefined,
          status: input.status === "active" || input.status === "disabled" || input.status === "removed" ? input.status : undefined,
          confirmation: typeof input.confirmation === "string" ? input.confirmation : undefined,
        });
      },
    });
    const request = portalHttpRequest("POST", "https://studio.example.github.io");
    request.body = { operation: "update" };
    const response = new PortalFakeResponse();
    await handler(request as never, response as never);

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.payload, { ok: false, error: { code: "invalid_request", message: "A person change is required" } });
    assert.notEqual((response.payload as { error: { code: string } }).error.code, "portal_access_denied");
    assert.equal(logged.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("portal HTTP boundary keeps internal failures distinct from access revocation", async () => {
  const service = new PortalService(new InMemoryPortalStore(), { companyDomains: ["xindong.com"] });
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { logged.push(values); };
  try {
    const handler = createPortalHttpHandler({
      service,
      requireMethod: "POST",
      allowedOrigins: ["https://studio.example.github.io"],
      resolveIdentity: async () => identity("admin", "admin@xindong.com"),
      action: async () => { throw new Error("firestore secret detail"); },
    });
    const response = new PortalFakeResponse();
    await handler(portalHttpRequest("POST", "https://studio.example.github.io") as never, response as never);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.payload, { ok: false, error: { code: "internal_error", message: "Portal request could not be completed" } });
    assert.equal(JSON.stringify(response.payload).includes("firestore secret detail"), false);
    assert.equal(logged.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("report HTTP handlers require a valid bounded company date range before querying", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  let queryCalls = 0;
  store.listTeamAggregates = async () => { queryCalls += 1; throw new Error("team query must not run"); };
  store.listPrincipalAggregates = async () => { queryCalls += 1; throw new Error("principal query must not run"); };
  store.listErrorAggregates = async () => { queryCalls += 1; throw new Error("error query must not run"); };
  store.listErrorDetails = async () => { queryCalls += 1; throw new Error("error detail query must not run"); };
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const cases: Array<{ report: PortalReportKind; body: Record<string, unknown> }> = [
    { report: "team", body: {} },
    { report: "principal", body: { from: "2026-02-30", to: "2026-03-01" } },
    { report: "errors", body: { from: "2026-07-24", to: "2026-07-23" } },
    { report: "error-details", body: { from: "2025-01-01", to: "2026-01-02", tool_key: "asset.export", action_key: "run", fingerprint: "f".repeat(64) } },
    { report: "error-details", body: { from: "2026-07-23", tool_key: "asset.export", action_key: "run", fingerprint: "f".repeat(64) } },
  ];
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { logged.push(values); };
  try {
    for (const current of cases) {
      const response = await requestPortalReport(service, current.report, current.body);
      assert.equal(response.statusCode, 400, `${current.report}: ${JSON.stringify(response.payload)}`);
      assert.equal((response.payload as { error?: { code?: string } }).error?.code, "invalid_request");
    }
  } finally {
    console.error = originalError;
  }
  assert.equal(queryCalls, 0);
  assert.equal(logged.length, 0);
});

test("report HTTP handlers reject malformed filters, limits, and cursors before querying", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  let queryCalls = 0;
  store.listTeamAggregates = async () => { queryCalls += 1; throw new Error("team query must not run"); };
  store.listPrincipalAggregates = async () => { queryCalls += 1; throw new Error("principal query must not run"); };
  store.listErrorAggregates = async () => { queryCalls += 1; throw new Error("error query must not run"); };
  store.listErrorDetails = async () => { queryCalls += 1; throw new Error("error detail query must not run"); };
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const dates = { from: "2026-07-01", to: "2026-07-23" };
  const detail = { ...dates, tool_key: "asset.export", action_key: "run", fingerprint: "f".repeat(64) };
  const cases: Array<{ report: PortalReportKind; body: Record<string, unknown> }> = [
    { report: "team", body: { ...dates, tool_key: "asset/export" } },
    { report: "team", body: { ...dates, action_key: "a".repeat(129) } },
    { report: "principal", body: { ...dates, plugin_principal_id: "principal/001" } },
    { report: "team", body: { ...dates, result: "unknown" } },
    { report: "errors", body: { ...dates, fingerprint: "F".repeat(64) } },
    { report: "errors", body: { ...dates, plugin_version: "01.2.3" } },
    { report: "team", body: { ...dates, limit: "100" } },
    { report: "principal", body: { ...dates, limit: 0 } },
    { report: "errors", body: { ...dates, limit: 101 } },
    { report: "error-details", body: { ...detail, limit: 1.5 } },
    { report: "team", body: { ...dates, cursor: "not+a+cursor" } },
    { report: "principal", body: { ...dates, cursor: "a".repeat(1_025) } },
    { report: "errors", body: { ...dates, cursor: "abc=" } },
    { report: "error-details", body: { ...dates, tool_key: "asset.export", action_key: "run" } },
    { report: "error-details", body: { ...dates, action_key: "run", fingerprint: "f".repeat(64) } },
    { report: "error-details", body: { ...dates, tool_key: "asset.export", fingerprint: "f".repeat(64) } },
  ];
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { logged.push(values); };
  try {
    for (const current of cases) {
      const response = await requestPortalReport(service, current.report, current.body);
      assert.equal(response.statusCode, 400, `${current.report}: ${JSON.stringify(response.payload)}`);
      assert.equal((response.payload as { error?: { code?: string } }).error?.code, "invalid_request");
    }
  } finally {
    console.error = originalError;
  }
  assert.equal(queryCalls, 0);
  assert.equal(logged.length, 0);
});

test("valid report HTTP input preserves stable cursor pagination", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  const row = { run_started: 1, run_succeeded: 1, run_failed: 0, run_cancelled: 0, run_interrupted: 0, distinct_users: 1, last_used_at: "2026-07-23T00:00:00.000Z", last_received_at: "2026-07-23T00:00:00.000Z", time_corrected_count: 0 };
  store.teamRows = [
    { ...row, tool_key: "tool.c", action_key: "run" },
    { ...row, tool_key: "tool.a", action_key: "run" },
    { ...row, tool_key: "tool.b", action_key: "run" },
  ];
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const first = await requestPortalReport(service, "team", { from: "2026-07-01", to: "2026-07-23", limit: 2 });
  assert.equal(first.statusCode, 200);
  const firstResult = (first.payload as { result: { items: Array<{ tool_key: string }>; next_cursor: string | null } }).result;
  assert.deepEqual(firstResult.items.map((item) => item.tool_key), ["tool.a", "tool.b"]);
  assert.ok(firstResult.next_cursor);

  const second = await requestPortalReport(service, "team", { from: "2026-07-01", to: "2026-07-23", limit: 2, cursor: firstResult.next_cursor });
  assert.equal(second.statusCode, 200);
  const secondResult = (second.payload as { result: { items: Array<{ tool_key: string }>; next_cursor: string | null } }).result;
  assert.deepEqual(secondResult.items.map((item) => item.tool_key), ["tool.c"]);
  assert.equal(secondResult.next_cursor, null);
});

test("management list HTTP handlers reject invalid limits and cursors before querying", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  let queryCalls = 0;
  store.listUsers = async () => { queryCalls += 1; throw new Error("people query must not run"); };
  store.listPolicies = async () => { queryCalls += 1; throw new Error("policy query must not run"); };
  store.listPluginDevices = async () => { queryCalls += 1; throw new Error("device query must not run"); };
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const cases: Array<{ management: PortalManagementKind; body: Record<string, unknown> }> = [
    { management: "people", body: { operation: "list", limit: "10" } },
    { management: "people", body: { operation: "list", limit: Number.NaN } },
    { management: "people", body: { operation: "list", limit: 0 } },
    { management: "people", body: { operation: "list", limit: 101 } },
    { management: "policies", body: { operation: "list", limit: 1.5 } },
    { management: "policies", body: { operation: "list", limit: Number.POSITIVE_INFINITY } },
    { management: "people", body: { operation: "list", cursor: "not+a+cursor" } },
    { management: "policies", body: { operation: "list", cursor: "a".repeat(1_025) } },
    { management: "policies", body: { operation: "list", cursor: "abc=" } },
    { management: "devices", body: { limit: "10" } },
    { management: "devices", body: { limit: 0 } },
    { management: "devices", body: { limit: 101 } },
    { management: "devices", body: { cursor: "not+a+cursor" } },
    { management: "devices", body: { cursor: Buffer.from("unknown", "utf8").toString("base64url") } },
  ];
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { logged.push(values); };
  try {
    for (const current of cases) {
      const response = await requestPortalManagement(service, current.management, current.body);
      assert.equal(response.statusCode, 400, `${current.management}: ${JSON.stringify(response.payload)}`);
      assert.equal((response.payload as { error?: { code?: string } }).error?.code, "invalid_request");
    }
  } finally {
    console.error = originalError;
  }
  assert.equal(queryCalls, 0);
  assert.equal(store.audits.length, 0);
  assert.equal(logged.length, 0);
});

test("management HTTP handlers reject invalid people and policy schemas before mutation", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  await store.putUser(user("member", "visitor"));
  await store.putUser(user("member_a-01:west", "visitor"));
  let personMutations = 0;
  let policyMutations = 0;
  const mutatePerson = store.mutatePerson.bind(store);
  const mutatePolicy = store.mutatePolicy.bind(store);
  store.mutatePerson = async (input) => { personMutations += 1; return mutatePerson(input); };
  store.mutatePolicy = async (input) => { policyMutations += 1; return mutatePolicy(input); };
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const cases: Array<{ management: PortalManagementKind; body: Record<string, unknown> }> = [
    { management: "people", body: { operation: "update", target_uid: "member", role: "owner", status: "disabled", confirmation: "member" } },
    { management: "people", body: { operation: "update", target_uid: "member", role: "admin", status: "paused", confirmation: "member" } },
    { management: "people", body: { operation: "update", target_uid: 123, role: "admin", confirmation: "123" } },
    { management: "people", body: { operation: "update", target_uid: "member/other", role: "admin", confirmation: "member/other" } },
    { management: "people", body: { operation: "update", target_uid: "member\\other", role: "admin", confirmation: "member\\other" } },
    { management: "people", body: { operation: "update", target_uid: ".", role: "admin", confirmation: "." } },
    { management: "people", body: { operation: "update", target_uid: "..", role: "admin", confirmation: ".." } },
    { management: "people", body: { operation: "update", target_uid: "member other", role: "admin", confirmation: "member other" } },
    { management: "people", body: { operation: "update", target_uid: "m".repeat(129), role: "admin", confirmation: "m".repeat(129) } },
    { management: "policies", body: { operation: "upsert", kind: "group", value: "artist@xindong.com", role: "visitor", enabled: true, confirmation: "artist@xindong.com" } },
    { management: "policies", body: { operation: "upsert", value: "artist@xindong.com", role: "visitor", enabled: true, confirmation: "artist@xindong.com" } },
    { management: "policies", body: { operation: "upsert", kind: "email", value: "artist@xindong.com", role: "owner", enabled: true, confirmation: "artist@xindong.com" } },
    { management: "policies", body: { operation: "upsert", kind: "email", value: "artist@xindong.com", enabled: true, confirmation: "artist@xindong.com" } },
    { management: "policies", body: { operation: "upsert", kind: "domain", value: "xindong.com", role: "admin", enabled: true, confirmation: "xindong.com" } },
    { management: "policies", body: { operation: "upsert", kind: "email", value: "artist@xindong.com", role: "visitor", enabled: "true", confirmation: "artist@xindong.com" } },
    { management: "policies", body: { operation: "upsert", kind: "email", value: "artist@xindong.com", role: "visitor", confirmation: "artist@xindong.com" } },
    { management: "policies", body: { operation: "upsert", kind: "email", value: 123, role: "visitor", enabled: true, confirmation: "123" } },
  ];
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { logged.push(values); };
  try {
    for (const current of cases) {
      const response = await requestPortalManagement(service, current.management, current.body);
      assert.equal(response.statusCode, 400, `${current.management}: ${JSON.stringify(response.payload)}`);
      assert.equal((response.payload as { error?: { code?: string } }).error?.code, "invalid_request");
    }
  } finally {
    console.error = originalError;
  }
  assert.equal(personMutations, 0);
  assert.equal(policyMutations, 0);
  assert.equal(store.audits.length, 0);
  assert.equal(logged.length, 0);

  const person = await requestPortalManagement(service, "people", { operation: "update", target_uid: "member", role: "admin", confirmation: "member" });
  assert.equal(person.statusCode, 200);
  assert.equal(personMutations, 1);
  const legalUid = await requestPortalManagement(service, "people", { operation: "update", target_uid: "member_a-01:west", status: "disabled", confirmation: "member_a-01:west" });
  assert.equal(legalUid.statusCode, 200);
  assert.equal(personMutations, 2);
  const emailPolicy = await requestPortalManagement(service, "policies", { operation: "upsert", kind: "email", value: "artist@xindong.com", role: "admin", enabled: true, confirmation: "artist@xindong.com" });
  assert.equal(emailPolicy.statusCode, 200);
  const domainPolicy = await requestPortalManagement(service, "policies", { operation: "upsert", kind: "domain", value: "xindong.com", role: "visitor", enabled: false, confirmation: "xindong.com" });
  assert.equal(domainPolicy.statusCode, 200);
  assert.equal(policyMutations, 2);
});

test("management HTTP list cursors are opaque canonical base64url and preserve pagination", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  await store.putUser(user("member_a", "visitor"));
  await store.putUser(user("member_b", "visitor"));
  for (const policyId of ["policy_a", "policy_b", "policy_c"]) {
    await store.putPolicy({ policy_id: policyId, kind: "email", value_hash: policyId, normalized_value: `${policyId}@xindong.com`, role: "visitor", enabled: true, updated_at: "2026-07-23T00:00:00.000Z", updated_by: "admin" });
  }
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  const firstPeople = await requestPortalManagement(service, "people", { operation: "list", limit: 2 });
  assert.equal(firstPeople.statusCode, 200);
  const firstPeopleResult = (firstPeople.payload as { result: { items: Array<{ uid: string }>; next_cursor: string | null } }).result;
  assert.deepEqual(firstPeopleResult.items.map((item) => item.uid), ["admin", "member_a"]);
  assert.ok(firstPeopleResult.next_cursor);
  assert.notEqual(firstPeopleResult.next_cursor, "member_a");
  assert.deepEqual(JSON.parse(Buffer.from(firstPeopleResult.next_cursor, "base64url").toString("utf8")), { v: 1, kind: "people", value: "member_a" });
  const secondPeople = await requestPortalManagement(service, "people", { operation: "list", limit: 2, cursor: firstPeopleResult.next_cursor });
  assert.deepEqual((secondPeople.payload as { result: { items: Array<{ uid: string }> } }).result.items.map((item) => item.uid), ["member_b"]);

  const firstPolicies = await requestPortalManagement(service, "policies", { operation: "list", limit: 2 });
  assert.equal(firstPolicies.statusCode, 200);
  const firstPolicyResult = (firstPolicies.payload as { result: { items: Array<{ policy_id: string }>; next_cursor: string | null } }).result;
  assert.deepEqual(firstPolicyResult.items.map((item) => item.policy_id), ["policy_a", "policy_b"]);
  assert.ok(firstPolicyResult.next_cursor);
  assert.deepEqual(JSON.parse(Buffer.from(firstPolicyResult.next_cursor, "base64url").toString("utf8")), { v: 1, kind: "policies", value: "policy_b" });
  const secondPolicies = await requestPortalManagement(service, "policies", { operation: "list", limit: 2, cursor: firstPolicyResult.next_cursor });
  assert.deepEqual((secondPolicies.payload as { result: { items: Array<{ policy_id: string }> } }).result.items.map((item) => item.policy_id), ["policy_c"]);
});

test("device management HTTP list cursors are opaque and preserve pagination", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  store.deviceRows = [
    { binding_id: "binding_c", plugin_principal_id: "principal_c", status: "active", created_at: "2026-07-23T00:00:00.000Z", last_seen_at: null, revoked_at: null },
    { binding_id: "binding_a", plugin_principal_id: "principal_a", status: "active", created_at: "2026-07-23T00:00:00.000Z", last_seen_at: null, revoked_at: null },
    { binding_id: "binding_b", plugin_principal_id: "principal_b", status: "revoked", created_at: "2026-07-23T00:00:00.000Z", last_seen_at: null, revoked_at: "2026-07-23T01:00:00.000Z" },
  ];
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const first = await requestPortalManagement(service, "devices", { limit: 2 });
  assert.equal(first.statusCode, 200);
  const firstResult = (first.payload as { result: { items: Array<{ binding_id: string }>; next_cursor: string | null } }).result;
  assert.deepEqual(firstResult.items.map((item) => item.binding_id), ["binding_a", "binding_b"]);
  assert.ok(firstResult.next_cursor);
  assert.notEqual(firstResult.next_cursor, "binding_b");
  assert.deepEqual(JSON.parse(Buffer.from(firstResult.next_cursor, "base64url").toString("utf8")), { v: 1, kind: "devices", value: "binding_b" });
  const second = await requestPortalManagement(service, "devices", { limit: 2, cursor: firstResult.next_cursor });
  assert.equal(second.statusCode, 200);
  assert.deepEqual((second.payload as { result: { items: Array<{ binding_id: string }>; next_cursor: string | null } }).result.items.map((item) => item.binding_id), ["binding_c"]);
  assert.equal((second.payload as { result: { next_cursor: string | null } }).result.next_cursor, null);
});

test("policy management HTTP responses project an allowlisted public shape", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  await store.putPolicy({ policy_id: "policy_internal", kind: "email", value_hash: "secret-hash", normalized_value: "artist@xindong.com", role: "visitor", enabled: true, updated_at: "2026-07-23T00:00:00.000Z", updated_by: "internal-actor" });
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const publicKeys = ["enabled", "kind", "normalized_value", "policy_id", "role", "updated_at"];

  const listed = await requestPortalManagement(service, "policies", { operation: "list", limit: 1 });
  assert.equal(listed.statusCode, 200);
  const listedItem = (listed.payload as { result: { items: Array<Record<string, unknown>> } }).result.items[0];
  assert.deepEqual(Object.keys(listedItem).sort(), publicKeys);
  assert.equal(listedItem.value_hash, undefined);
  assert.equal(listedItem.updated_by, undefined);

  const upserted = await requestPortalManagement(service, "policies", { operation: "upsert", kind: "email", value: "new-artist@xindong.com", role: "admin", enabled: true, confirmation: "new-artist@xindong.com" });
  assert.equal(upserted.statusCode, 200);
  const upsertedItem = (upserted.payload as { result: Record<string, unknown> }).result;
  assert.deepEqual(Object.keys(upsertedItem).sort(), publicKeys);
  assert.equal(upsertedItem.value_hash, undefined);
  assert.equal(upsertedItem.updated_by, undefined);
});

test("people and device management HTTP responses project allowlisted public shapes", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  await store.putUser(user("member", "visitor"));
  store.deviceRows = [{ binding_id: "binding_public", plugin_principal_id: "principal_public", status: "active", created_at: "2026-07-23T00:00:00.000Z", last_seen_at: null, revoked_at: null, internal_note: "must not leak" } as never];
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  const people = await requestPortalManagement(service, "people", { operation: "list", limit: 10 });
  assert.equal(people.statusCode, 200);
  const person = (people.payload as { result: { items: Array<Record<string, unknown>> } }).result.items.find((item) => item.uid === "member");
  assert.ok(person);
  assert.deepEqual(Object.keys(person).sort(), ["display_name", "first_login_at", "last_login_at", "normalized_email", "photo_url", "role", "status", "uid"]);
  assert.equal(person.updated_at, undefined);

  const devices = await requestPortalManagement(service, "devices", { limit: 10 });
  assert.equal(devices.statusCode, 200);
  const device = (devices.payload as { result: { items: Array<Record<string, unknown>> } }).result.items[0];
  assert.deepEqual(Object.keys(device).sort(), ["binding_id", "created_at", "last_seen_at", "plugin_principal_id", "revoked_at", "status"]);
  assert.equal(device.internal_note, undefined);
});

test("team and error summaries report a recoverable role change during the query", async () => {
  for (const method of ["team", "errors"] as const) {
    const store = new InMemoryPortalStore();
    await store.putUser(user("admin", "admin"));
    if (method === "team") {
      const list = store.listTeamAggregates.bind(store);
      store.listTeamAggregates = async (...args) => {
        const result = await list(...args);
        await store.putUser(user("admin", "visitor"));
        return result;
      };
    } else {
      const list = store.listErrorAggregates.bind(store);
      store.listErrorAggregates = async (...args) => {
        const result = await list(...args);
        await store.putUser(user("admin", "visitor"));
        return result;
      };
    }
    const service = new PortalService(store, { companyDomains: ["xindong.com"] });
    const operation = method === "team"
      ? service.teamSummary(identity("admin", "admin@xindong.com"), { from: "2026-07-23", to: "2026-07-23" })
      : service.errorSummary(identity("admin", "admin@xindong.com"), { from: "2026-07-23", to: "2026-07-23" });
    await assert.rejects(operation, (error: unknown) => error instanceof PortalError && (error as { code: string }).code === "portal_role_changed");
  }
});

test("portal query auditing covers public summaries and administrator reads", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  await store.putUser(user("visitor", "visitor"));
  await store.putPolicy({ policy_id: portalEmailPolicyId("artist@xindong.com"), kind: "email", value_hash: "hash", normalized_value: "artist@xindong.com", role: "visitor", enabled: true, updated_at: "2026-07-23T00:00:00.000Z", updated_by: "admin" });
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });
  const filter = { from: "2026-07-23", to: "2026-07-23", toolKey: "asset.export" };

  await service.teamSummary(identity("admin", "admin@xindong.com"), filter);
  await service.errorSummary(identity("admin", "admin@xindong.com"), filter);
  await service.listPeople(identity("admin", "admin@xindong.com"), 10, undefined, "artist@xindong.com");
  await service.listPolicies(identity("admin", "admin@xindong.com"), 10);
  await service.previewPolicy(identity("admin", "admin@xindong.com"), "artist@xindong.com");
  await assert.rejects(() => service.listPeople(identity("visitor", "visitor@xindong.com"), 10), (error: unknown) => error instanceof PortalError && error.code === "portal_admin_required");
  store.listErrorAggregates = async () => { throw new Error("firestore unavailable"); };
  await assert.rejects(() => service.errorSummary(identity("admin", "admin@xindong.com"), filter), /firestore unavailable/);

  const queryAudits = store.audits.filter((audit) => audit.action.endsWith("_query"));
  assert.deepEqual(queryAudits.map((audit) => [audit.action, audit.result]), [
    ["team_summary_query", "succeeded"],
    ["error_summary_query", "succeeded"],
    ["portal_people_query", "succeeded"],
    ["portal_policy_list_query", "succeeded"],
    ["portal_policy_preview_query", "succeeded"],
    ["portal_people_query", "denied"],
    ["error_summary_query", "failed"],
  ]);
  assert.equal(JSON.stringify(queryAudits).includes("artist@xindong.com"), false);
  assert.equal((queryAudits.at(-2) as { reason?: string }).reason, "portal_admin_required");
  assert.equal((queryAudits.at(-1) as { reason?: string }).reason, "internal_failure");
});

test("principal reports read the tool aggregate dimensions produced by ingestion", async () => {
  const aggregateDocument = {
    data: () => ({
      generation: "online",
      date: "2026-07-23",
      plugin_principal_id: "principal_001",
      tool_key: "asset.export",
      action_key: "export_selected",
      run_started: 3,
      run_succeeded: 2,
      run_failed: 1,
      run_cancelled: 0,
      run_interrupted: 0,
      last_observed_at: "2026-07-23T02:50:00.000Z",
      last_received_at: "2026-07-23T03:00:00.000Z",
      time_corrected_count: 1,
      updated_at: "2026-07-23T03:00:00.000Z",
    }),
  };
  const queriedCollections: string[] = [];
  const aggregateQuery = {
    where() { return this; },
    orderBy() { return this; },
    limit() { return this; },
    async get() { return { docs: [aggregateDocument] }; },
  };
  const firestore = {
    collection(name: string) {
      queriedCollections.push(name);
      if (name === "usageAggregatePointers") return {
        doc() { return { async get() { return { data: () => undefined }; } }; },
      };
      if (name === "toolUsageDaily") return aggregateQuery;
      if (name === "pluginPrincipals") return {
        doc(id: string) { return { id }; },
        where() {
          return {
            async get() {
              return { docs: [
                { id: "principal_001", data: () => ({ email: "artist@xindong.com" }) },
                { id: "principal_historical", data: () => ({ email: "artist@xindong.com" }) },
              ] };
            },
          };
        },
      };
      throw new Error(`unexpected collection ${name}`);
    },
    async getAll(...references: Array<{ id: string }>) {
      return references.map((reference) => ({ id: reference.id, data: () => ({ email: "artist@xindong.com", displayName: "Artist", profileUpdatedAt: { toDate: () => new Date("2026-07-22T03:00:00.000Z") } }) }));
    },
  };
  const store = new FirestorePortalStore(firestore as never);

  const page = await store.listPrincipalAggregates({ from: "2026-07-23", to: "2026-07-24" }, 100);
  assert.deepEqual(queriedCollections.slice(0, 2), ["usageAggregatePointers", "toolUsageDaily"]);
  assert.deepEqual(page, { items: [{
    plugin_principal_id: "principal_001",
    tool_key: "asset.export",
    action_key: "export_selected",
    display_name: "Artist",
    email: "artist@xindong.com",
    profile_updated_at: "2026-07-22T03:00:00.000Z",
    identity_changed: true,
    run_started: 3,
    run_succeeded: 2,
    run_failed: 1,
    run_cancelled: 0,
    run_interrupted: 0,
    last_used_at: "2026-07-23T02:50:00.000Z",
    last_received_at: "2026-07-23T03:00:00.000Z",
    time_corrected_count: 1,
    daily_trend: [{ date: "2026-07-23", run_started: 3, run_failed: 1, run_interrupted: 0 }],
  }], next_cursor: null });
});

test("admin report authorization is rechecked before sensitive rows return", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  store.principalRows = [{
    plugin_principal_id: "principal_001",
    tool_key: "asset.export",
    action_key: "export_selected",
    display_name: "Artist",
    email: "artist@xindong.com",
    profile_updated_at: "2026-07-22T03:00:00.000Z",
    identity_changed: false,
    run_started: 1,
    run_succeeded: 1,
    run_failed: 0,
    run_cancelled: 0,
    run_interrupted: 0,
    last_used_at: "2026-07-23T03:00:00.000Z",
    last_received_at: "2026-07-23T03:00:00.000Z",
    time_corrected_count: 0,
    daily_trend: [{ date: "2026-07-23", run_started: 1, run_failed: 0, run_interrupted: 0 }],
  }];
  const list = store.listPrincipalAggregates.bind(store);
  store.listPrincipalAggregates = async (filter, limit, cursor) => {
    const rows = await list(filter, limit, cursor);
    await store.putUser(user("admin", "visitor"));
    return rows;
  };
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  await assert.rejects(
    () => service.principalUsage(identity("admin", "admin@xindong.com"), { from: "2026-07-23", to: "2026-07-24" }),
    (error: unknown) => error instanceof PortalError && error.code === "portal_admin_required",
  );
  assert.equal(store.audits.at(-1)?.action, "principal_usage_query");
  assert.equal(store.audits.at(-1)?.result, "denied");
});

test("report pages use stable cursors without repeating grouped rows", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin", "admin"));
  const base = { run_started: 1, run_succeeded: 1, run_failed: 0, run_cancelled: 0, run_interrupted: 0, distinct_users: 2, last_used_at: "2026-07-23T00:00:00.000Z", last_received_at: "2026-07-23T00:00:00.000Z", time_corrected_count: 0 };
  store.teamRows = [
    { ...base, tool_key: "tool.c", action_key: "run" },
    { ...base, tool_key: "tool.a", action_key: "run" },
    { ...base, tool_key: "tool.b", action_key: "run" },
  ];
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  const first = await service.teamSummary(identity("admin", "admin@xindong.com"), { from: "2026-07-01", to: "2026-07-24" }, 2);
  assert.deepEqual(first.items.map((row) => row.tool_key), ["tool.a", "tool.b"]);
  assert.ok(first.next_cursor);
  const second = await service.teamSummary(identity("admin", "admin@xindong.com"), { from: "2026-07-01", to: "2026-07-24" }, 2, first.next_cursor ?? undefined);
  assert.deepEqual(second.items.map((row) => row.tool_key), ["tool.c"]);
  assert.equal(second.next_cursor, null);
});

test("aggregate scans do not silently stop before rows beyond two thousand documents", async () => {
  const documents = Array.from({ length: 2_001 }, (_, index) => {
    const id = `aggregate_${String(index).padStart(4, "0")}`;
    const value = {
      generation: "online",
      date: "2026-07-23",
      plugin_principal_id: `principal_${index}`,
      tool_key: index === 2_000 ? "tool.z" : "tool.a",
      action_key: "run",
      run_started: 1,
      run_succeeded: 1,
      run_failed: 0,
      run_cancelled: 0,
      run_interrupted: 0,
      corrected_observed_at: "2026-07-23T01:00:00.000Z",
      updated_at: "2026-07-23T01:01:00.000Z",
    };
    return { id, data: () => value, get: (field: string) => value[field as keyof typeof value] };
  });
  class Query {
    private take = documents.length;
    private after = "";
    where() { return this; }
    orderBy() { return this; }
    limit(value: number) { this.take = value; return this; }
    startAfter(value: { id?: string } | string) { this.after = typeof value === "string" ? value : value.id ?? ""; return this; }
    async get() {
      const position = this.after ? documents.findIndex((document) => document.id === this.after) + 1 : 0;
      return { docs: documents.slice(position, position + this.take) };
    }
  }
  const firestore = {
    collection(name: string) {
      if (name === "usageAggregatePointers") return { doc() { return { async get() { return { data: () => undefined }; } }; } };
      return new Query();
    },
  };
  const store = new FirestorePortalStore(firestore as never);

  const result = await store.listTeamAggregates({ from: "2026-07-23", to: "2026-07-24" }, 100);
  assert.deepEqual(result.items.map((row) => row.tool_key), ["tool.a", "tool.z"]);
  assert.deepEqual(result.summary, { run_started: 2_001, run_succeeded: 2_001, run_failed: 0, run_cancelled: 0, run_interrupted: 0, distinct_users: 2_001 });
  assert.deepEqual(result.failure_trend, [{ date: "2026-07-23", run_failed: 0, run_interrupted: 0 }]);
});

test("portal people search filters before reading one bounded Firestore page", async () => {
  const documents = Array.from({ length: 151 }, (_, index) => {
    const uid = `uid_${String(index).padStart(3, "0")}`;
    const value = user(uid, "visitor");
    const data = index === 150 ? { ...value, display_name: "Needle Artist", search_terms: ["needle"] } : { ...value, search_terms: [] };
    return { id: uid, data: () => data, get: (field: string) => data[field as keyof typeof data] };
  });
  let reads = 0;
  let requestedLimit = 0;
  class Query {
    private take = documents.length;
    private after = "";
    private search = "";
    where(field: string, operator: string, value: string) {
      assert.deepEqual([field, operator], ["search_terms", "array-contains"]);
      this.search = value;
      return this;
    }
    orderBy() { return this; }
    limit(value: number) { this.take = value; requestedLimit = value; return this; }
    startAfter(value: { id?: string } | string) { this.after = typeof value === "string" ? value : value.id ?? ""; return this; }
    async get() {
      reads += 1;
      const filtered = this.search ? documents.filter((document) => document.get("search_terms").includes(this.search)) : documents;
      const position = this.after ? filtered.findIndex((document) => document.id === this.after) + 1 : 0;
      return { docs: filtered.slice(position, position + this.take) };
    }
  }
  const firestore = {
    collection(name: string) {
      if (name === "usageAggregatePointers") return { doc() { return { async get() { return { data: () => undefined }; } }; } };
      return new Query();
    },
  };
  const store = new FirestorePortalStore(firestore as never);

  const result = await store.listUsers({ limit: 10, search: "needle" });
  assert.deepEqual(result.items.map((person) => person.uid), ["uid_150"]);
  assert.equal(result.next_cursor, null);
  assert.equal(Object.hasOwn(result.items[0], "search_terms"), false);
  assert.equal(reads, 1);
  assert.equal(requestedLimit, 11);
});

test("error reports merge version shards globally and restrict every metric for a version filter", async () => {
  const values = [
    { date: "2026-07-22", plugin_version: "1.0.0", count: 2, first_seen_at: "2026-07-22T01:00:00.000Z", recent_seen_at: "2026-07-22T02:00:00.000Z", first_received_at: "2026-07-22T01:05:00.000Z", recent_received_at: "2026-07-22T02:05:00.000Z", time_corrected_count: 0, affected_versions: ["1.0.0"], principal_ids: ["principal-a"], summaries: [{ summary: "Safe failure", count: 2 }] },
    { date: "2026-07-23", plugin_version: "1.0.0", count: 1, first_seen_at: "2026-07-23T01:00:00.000Z", recent_seen_at: "2026-07-23T01:00:00.000Z", first_received_at: "2026-07-23T01:05:00.000Z", recent_received_at: "2026-07-23T01:05:00.000Z", time_corrected_count: 0, affected_versions: ["1.0.0"], principal_ids: ["principal-a"], summaries: [{ summary: "Safe failure", count: 1 }] },
    { date: "2026-07-23", plugin_version: "1.1.0", count: 2, first_seen_at: "2026-07-23T02:00:00.000Z", recent_seen_at: "2026-07-23T03:00:00.000Z", first_received_at: "2026-07-23T02:05:00.000Z", recent_received_at: "2026-07-23T03:05:00.000Z", time_corrected_count: 1, affected_versions: ["1.1.0"], principal_ids: ["principal-b"], summaries: [{ summary: "Safe failure", count: 1 }, { summary: "Safe variant", count: 1 }] },
  ].map((item, index) => {
    const data = { generation: "online", tool_key: "asset.export", action_key: "export", error_category: "internal", fingerprint: "f".repeat(64), status: "open", ...item };
    return { id: `error_${index}`, data: () => data, get: (field: string) => data[field as keyof typeof data] };
  });
  class Query {
    where() { return this; }
    orderBy() { return this; }
    limit() { return this; }
    async get() { return { docs: values }; }
  }
  const firestore = {
    collection(name: string) {
      if (name === "usageAggregatePointers") return { doc() { return { async get() { return { data: () => undefined }; } }; } };
      return new Query();
    },
  };
  const store = new FirestorePortalStore(firestore as never);

  const result = await store.listErrorAggregates({ from: "2026-07-22", to: "2026-07-23", pluginVersion: "1.1.0" }, 100);
  assert.deepEqual(result, {
    items: [{
      tool_key: "asset.export",
      action_key: "export",
      error_category: "internal",
      fingerprint: "f".repeat(64),
      count: 2,
      first_seen_at: "2026-07-23T02:00:00.000Z",
      recent_seen_at: "2026-07-23T03:00:00.000Z",
      first_received_at: "2026-07-23T02:05:00.000Z",
      recent_received_at: "2026-07-23T03:05:00.000Z",
      time_corrected_count: 1,
      affected_versions: ["1.1.0"],
      summaries: [{ summary: "Safe failure", count: 1 }, { summary: "Safe variant", count: 1 }],
      status: "open",
      distinct_users: 1,
    }],
    next_cursor: null,
  });

  const allVersions = await store.listErrorAggregates({ from: "2026-07-22", to: "2026-07-23" }, 100);
  assert.deepEqual({
    count: allVersions.items[0].count,
    first_seen_at: allVersions.items[0].first_seen_at,
    recent_seen_at: allVersions.items[0].recent_seen_at,
    affected_versions: allVersions.items[0].affected_versions,
    summaries: allVersions.items[0].summaries,
    distinct_users: allVersions.items[0].distinct_users,
  }, {
    count: 5,
    first_seen_at: "2026-07-22T01:00:00.000Z",
    recent_seen_at: "2026-07-23T03:00:00.000Z",
    affected_versions: ["1.0.0", "1.1.0"],
    summaries: [{ summary: "Safe failure", count: 4 }, { summary: "Safe variant", count: 1 }],
    distinct_users: 2,
  });
});

test("portal aggregate reports follow the active generation and partition routing", async () => {
  type Value = Record<string, unknown>;
  const pointer = {
    active_generation: "shadow-global",
    write_generations: ["shadow-global", "shadow-partition", "online"],
    rollback_generation: "online",
    source_revision: 0,
    source_watermark: null,
    generation_partitions: [{
      from: "2026-07-22T16:00:00.000Z",
      to: "2026-07-23T16:00:00.000Z",
      generation: "shadow-partition",
      rollback_generation: "shadow-global",
    }],
    updated_at: "2026-07-24T00:00:00.000Z",
  };
  const aggregate = (id: string, data: Value) => ({
    id,
    data: () => data,
    get: (field: string) => data[field],
  });
  const daily = (generation: string, date: string, principal: string, count: number) => aggregate(`${generation}-${date}-${principal}`, {
    generation,
    date,
    plugin_principal_id: principal,
    tool_key: "asset.export",
    action_key: "export",
    run_started: count,
    run_succeeded: count,
    run_failed: 0,
    run_cancelled: 0,
    run_interrupted: 0,
    last_observed_at: `${date}T04:00:00.000Z`,
    last_received_at: `${date}T04:01:00.000Z`,
    time_corrected_count: 0,
  });
  const error = (generation: string, date: string, principal: string, count: number) => aggregate(`error-${generation}-${date}-${principal}`, {
    generation,
    date,
    plugin_version: "1.0.0",
    tool_key: "asset.export",
    action_key: "export",
    error_category: "internal",
    fingerprint: "f".repeat(64),
    count,
    first_seen_at: `${date}T04:00:00.000Z`,
    recent_seen_at: `${date}T04:00:00.000Z`,
    first_received_at: `${date}T04:01:00.000Z`,
    recent_received_at: `${date}T04:01:00.000Z`,
    affected_versions: ["1.0.0"],
    summaries: [{ summary: "Safe failure", count }],
    principal_ids: [principal],
    status: "open",
  });
  const documents = {
    toolUsageDaily: [
      daily("shadow-global", "2026-07-22", "principal-a", 1),
      daily("shadow-global", "2026-07-23", "wrong-global-partition", 50),
      daily("shadow-partition", "2026-07-23", "principal-b", 2),
      daily("shadow-global", "2026-07-24", "principal-c", 3),
      daily("online", "2026-07-22", "stale-online", 999),
    ],
    errorAggregates: [
      error("shadow-global", "2026-07-22", "principal-a", 1),
      error("shadow-global", "2026-07-23", "wrong-global-partition", 50),
      error("shadow-partition", "2026-07-23", "principal-b", 2),
      error("shadow-global", "2026-07-24", "principal-c", 3),
      error("online", "2026-07-22", "stale-online", 999),
    ],
  };

  class Query {
    private predicates: Array<(value: Value) => boolean> = [];
    private take = Number.MAX_SAFE_INTEGER;
    private after = "";

    public constructor(private readonly values: Array<ReturnType<typeof aggregate>>) {}
    public where(field: string, operation: string, expected: unknown) {
      this.predicates.push((value) => {
        const actual = value[field];
        if (operation === "==") return actual === expected;
        if (operation === ">=") return String(actual) >= String(expected);
        if (operation === "<=") return String(actual) <= String(expected);
        if (operation === "<") return String(actual) < String(expected);
        throw new Error(`unsupported operation ${operation}`);
      });
      return this;
    }
    public orderBy() { return this; }
    public limit(value: number) { this.take = value; return this; }
    public startAfter(value: { id: string }) { this.after = value.id; return this; }
    public async get() {
      const filtered = this.values.filter((document) => this.predicates.every((predicate) => predicate(document.data())));
      const start = this.after ? filtered.findIndex((document) => document.id === this.after) + 1 : 0;
      return { docs: filtered.slice(start, start + this.take) };
    }
  }

  const firestore = {
    collection(name: string) {
      if (name === "usageAggregatePointers") return {
        doc() {
          return { async get() { return { exists: true, data: () => pointer }; } };
        },
      };
      if (name === "pluginPrincipals") return {
        doc(id: string) { return { id }; },
        where() { return new Query([]); },
      };
      return new Query(documents[name as keyof typeof documents] ?? []);
    },
    async getAll(...references: Array<{ id: string }>) {
      return references.map((reference) => ({ id: reference.id, data: () => ({}) }));
    },
  };
  const store = new FirestorePortalStore(firestore as never);
  const filter = { from: "2026-07-22", to: "2026-07-24" };

  const team = await store.listTeamAggregates(filter, 100);
  assert.equal(team.items[0]?.run_started, 6);
  assert.equal(team.summary.run_started, 6);
  assert.deepEqual(team.failure_trend.map((point) => point.date), ["2026-07-22", "2026-07-23", "2026-07-24"]);

  const principals = await store.listPrincipalAggregates(filter, 100);
  assert.deepEqual(principals.items.map((row) => [row.plugin_principal_id, row.run_started]), [
    ["principal-a", 1],
    ["principal-b", 2],
    ["principal-c", 3],
  ]);

  const errors = await store.listErrorAggregates(filter, 100);
  assert.equal(errors.items[0]?.count, 6);
  assert.equal(errors.items[0]?.distinct_users, 3);
});

test("concurrent administrator changes cannot remove every active administrator", async () => {
  const store = new InMemoryPortalStore();
  await store.putUser(user("admin_a", "admin"));
  await store.putUser(user("admin_b", "admin"));
  const service = new PortalService(store, { companyDomains: ["xindong.com"] });

  const results = await Promise.allSettled([
    service.updatePerson({ identity: identity("admin_a", "admin_a@xindong.com"), targetUid: "admin_b", status: "disabled", confirmation: "admin_b" }),
    service.updatePerson({ identity: identity("admin_b", "admin_b@xindong.com"), targetUid: "admin_a", status: "disabled", confirmation: "admin_a" }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(await store.countActiveAdmins(), 1);
  const changeAudits = store.audits.filter((audit) => audit.action === "portal_person_updated");
  assert.equal(changeAudits.filter((audit) => audit.result === "succeeded").length, 1);
  assert.equal(changeAudits.filter((audit) => audit.result === "denied").length, 1);
});
