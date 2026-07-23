import assert from "node:assert/strict";
import test from "node:test";

import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { FirestorePortalStore } from "../src/portal/firestore-store";
import { PortalError, PortalService as RuntimePortalService, portalEmailPolicyId as createPortalEmailPolicyId } from "../src/portal/service";
import { UsageIngestionService } from "../src/usage/ingestion";
import { FirestoreUsageStore } from "../src/usage/store";
import type { ToolRegistry } from "../src/usage/types";

const projectId = "demo-tl-art-tool-usage-analytics-portal";
const now = new Date("2026-07-23T04:00:00.000Z");
const collections = [
  "portalUsers",
  "portalAccessPolicies",
  "portalAuthAudit",
  "portalBootstrapState",
  "portalQueryAudit",
  "usageEvents",
  "usageEventReservations",
  "usageOperations",
  "usageAggregatePointers",
  "usageAggregateSourceRevisions",
  "pluginPrincipals",
  "toolUsageDaily",
  "principalUsageDaily",
  "errorAggregates",
];

const policyKeyring = {
  currentKeyId: "k2",
  previousKeyIds: ["k1"],
  keys: {
    k2: "current-portal-policy-hmac-key-material-2026",
    k1: "previous-portal-policy-hmac-key-material-2025",
  },
};

const portalEmailPolicyId = (email: string, keyring = policyKeyring, keyId?: string) => createPortalEmailPolicyId(email, keyring, keyId);

class PortalService extends RuntimePortalService {
  public constructor(store: ConstructorParameters<typeof RuntimePortalService>[0], options: Omit<ConstructorParameters<typeof RuntimePortalService>[1], "policyKeyring"> & { policyKeyring?: typeof policyKeyring }) {
    super(store, { policyKeyring, ...options });
  }
}

const registry: ToolRegistry = {
  schema_version: "1.0.0",
  registry_version: "1.0.0",
  registry_status: "active",
  tools: [{
    tool_key: "asset.export",
    display_name: "Asset Export",
    page: "asset",
    introduced_version: "1.0.0",
    retired_version: null,
    accept_until: null,
    display_state: "active",
    actions: [{
      action_key: "export",
      display_name: "Export",
      page: "asset",
      introduced_version: "1.0.0",
      retired_version: null,
      accept_until: null,
      display_state: "active",
    }],
  }],
};

function identity(uid: string) {
  return { uid, email: `${uid}@xindong.com`, emailVerified: true, displayName: uid };
}

function portalUser(uid: string) {
  return {
    uid,
    normalized_email: `${uid}@xindong.com`,
    display_name: uid,
    photo_url: null,
    role: "admin" as const,
    status: "active" as const,
    first_login_at: now.toISOString(),
    last_login_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

function usageEvent(eventId: string, eventType: "run_started" | "run_succeeded") {
  return {
    schema_version: "1.0.0",
    registry_version: "1.0.0",
    event_id: eventId,
    binding_id: "binding-portal",
    tool_key: "asset.export",
    action_key: "export",
    event_type: eventType,
    client_observed_at: now.toISOString(),
    plugin_version: "1.0.0",
    ue_version: "4.26",
    ui_version: "1.0.0",
    process_instance_id: "process-portal",
    session_id: "session-portal",
    operation_id: "operation-portal",
  };
}

test("Firestore portal transactions and production aggregate queries", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must be provided by firebase emulators:exec");
  const app = initializeApp({ projectId }, `portal-emulator-${Date.now()}`);
  const firestore = getFirestore(app);
  const clear = async () => Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  suite.after(async () => {
    await clear();
    await deleteApp(app);
  });

  await suite.test("concurrent administrators cannot disable every administrator and both outcomes are audited", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    await Promise.all([store.putUser(portalUser("admin_a")), store.putUser(portalUser("admin_b"))]);
    const service = new PortalService(store, { companyDomains: ["xindong.com"], now: () => new Date(now) });

    const results = await Promise.allSettled([
      service.updatePerson({ identity: identity("admin_a"), targetUid: "admin_b", status: "disabled", confirmation: "admin_b" }),
      service.updatePerson({ identity: identity("admin_b"), targetUid: "admin_a", status: "disabled", confirmation: "admin_a" }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(await store.countActiveAdmins(), 1);
    const audits = await firestore.collection("portalAuthAudit").where("action", "==", "portal_person_updated").get();
    assert.equal(audits.size, 2);
    assert.deepEqual(audits.docs.map((document) => document.get("result")).sort(), ["denied", "succeeded"]);
  });

  await suite.test("first administrator bootstrap is atomic under concurrency and cannot be replayed", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    const options = {
      companyDomains: ["xindong.com"],
      now: () => new Date(now),
      bootstrapAdmin: { bootstrapId: "initial-admin-v1", email: "first.admin@xindong.com" },
    };
    const service = new PortalService(store, options);
    const attempts = await Promise.allSettled([
      service.signIn({ ...identity("bootstrap-a"), email: "first.admin@xindong.com" }),
      service.signIn({ ...identity("bootstrap-b"), email: "first.admin@xindong.com" }),
    ]);

    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(await store.countActiveAdmins(), 1);
    assert.equal((await firestore.collection("portalBootstrapState").doc("initial-admin-v1").get()).get("status"), "consumed");
    const bootstrapAudits = await firestore.collection("portalAuthAudit").where("action", "==", "portal_first_admin_bootstrap").get();
    assert.equal(bootstrapAudits.docs.filter((document) => document.get("result") === "succeeded").length, 1);
    assert.equal(bootstrapAudits.docs.filter((document) => document.get("result") === "denied").length, 1);

    await assert.rejects(
      () => service.signIn({ ...identity("bootstrap-replay"), email: "first.admin@xindong.com" }),
      (error: unknown) => error instanceof PortalError && error.code === "portal_access_denied",
    );
    assert.equal(await store.countActiveAdmins(), 1);
  });

  await suite.test("bootstrap closes when an administrator exists and audit failure rolls back all writes", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    await store.putUser(portalUser("existing-admin"));
    const service = new PortalService(store, {
      companyDomains: ["xindong.com"],
      now: () => new Date(now),
      bootstrapAdmin: { bootstrapId: "existing-admin-v1", email: "first.admin@xindong.com" },
    });
    await assert.rejects(
      () => service.signIn({ ...identity("bootstrap-candidate"), email: "first.admin@xindong.com" }),
      (error: unknown) => error instanceof PortalError && error.code === "portal_access_denied",
    );
    assert.equal((await firestore.collection("portalBootstrapState").doc("existing-admin-v1").get()).get("reason"), "active_admin_exists");
    assert.equal(await store.countActiveAdmins(), 1);

    await clear();
    const failingFirestore = new Proxy(firestore, {
      get(target, property, receiver) {
        if (property !== "runTransaction") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (operation: (transaction: unknown) => unknown) => target.runTransaction(async (transaction) => operation(new Proxy(transaction, {
          get(transactionTarget, transactionProperty, transactionReceiver) {
            if (transactionProperty !== "set") {
              const value = Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
              return typeof value === "function" ? value.bind(transactionTarget) : value;
            }
            return (reference: { parent: { id: string } }, ...args: unknown[]) => {
              if (reference.parent.id === "portalAuthAudit") throw new Error("simulated bootstrap audit failure");
              return (transaction.set as (...values: unknown[]) => unknown)(reference, ...args);
            };
          },
        }) as never));
      },
    });
    const failingStore = new FirestorePortalStore(failingFirestore as never);
    await assert.rejects(
      () => failingStore.bootstrapFirstAdmin({ bootstrapId: "rollback-v1", uid: "rollback-admin", normalizedEmail: "rollback.admin@xindong.com", displayName: "Rollback Admin", photoUrl: null, auditId: "audit-rollback", occurredAt: now.toISOString() }),
      /simulated bootstrap audit failure/,
    );
    assert.equal((await firestore.collection("portalUsers").doc("rollback-admin").get()).exists, false);
    assert.equal((await firestore.collection("portalBootstrapState").doc("rollback-v1").get()).exists, false);
  });

  await suite.test("portal people use indexed cursor pages and normalized name or email prefix search", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    await Promise.all([
      store.putUser({ ...portalUser("user_a"), normalized_email: "alpha.artist@xindong.com", display_name: "Lighting Artist" }),
      store.putUser({ ...portalUser("user_b"), normalized_email: "beta.artist@xindong.com", display_name: "Environment Artist" }),
      store.putUser({ ...portalUser("user_c"), normalized_email: "gamma.artist@xindong.com", display_name: "Character Artist" }),
    ]);

    const first = await store.listUsers({ limit: 2 });
    assert.deepEqual(first.items.map((item) => item.uid), ["user_a", "user_b"]);
    assert.ok(first.next_cursor);
    const second = await store.listUsers({ limit: 2, cursor: first.next_cursor ?? undefined });
    assert.deepEqual(second.items.map((item) => item.uid), ["user_c"]);
    assert.equal(second.next_cursor, null);

    const byEmail = await store.listUsers({ limit: 10, search: "  ALPHA.ART  " });
    assert.deepEqual(byEmail.items.map((item) => item.uid), ["user_a"]);
    const byName = await store.listUsers({ limit: 10, search: "lightING ar" });
    assert.deepEqual(byName.items.map((item) => item.uid), ["user_a"]);
    assert.equal(Object.hasOwn(byName.items[0], "search_terms"), false);

    const stored = await firestore.collection("portalUsers").doc("user_a").get();
    assert.ok(Array.isArray(stored.get("search_terms")));
    assert.ok((stored.get("search_terms") as string[]).includes("alpha.art"));
    assert.ok((stored.get("search_terms") as string[]).includes("lighting ar"));
  });

  await suite.test("portal summary, people and policy queries persist Firestore audits", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    await store.putUser(portalUser("admin"));
    await store.putPolicy({ policy_id: portalEmailPolicyId("artist@xindong.com"), kind: "email", value_hash: "email", normalized_value: "artist@xindong.com", role: "visitor", enabled: true, updated_at: now.toISOString(), updated_by: "admin" });
    const service = new PortalService(store, { companyDomains: ["xindong.com"], now: () => new Date(now) });
    const admin = identity("admin");
    const filter = { from: "2026-07-23", to: "2026-07-23" };

    await service.teamSummary(admin, filter);
    await service.errorSummary(admin, filter);
    await service.listPeople(admin, 10, undefined, "artist");
    await service.listPolicies(admin, 10);
    await service.previewPolicy(admin, "artist@xindong.com");

    const audits = await firestore.collection("portalQueryAudit").orderBy("occurred_at").get();
    assert.deepEqual(audits.docs.map((document) => document.get("action")).sort(), [
      "error_summary_query",
      "portal_people_query",
      "portal_policy_list_query",
      "portal_policy_preview_query",
      "team_summary_query",
    ].sort());
    assert.ok(audits.docs.every((document) => document.get("result") === "succeeded"));
  });

  await suite.test("sign-in migrates a previous HMAC policy ID inside the Firestore transaction", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    const email = "artist@xindong.com";
    const previousPolicyId = portalEmailPolicyId(email, policyKeyring, "k1");
    const currentPolicyId = portalEmailPolicyId(email);
    await store.putPolicy({ policy_id: previousPolicyId, kind: "email", value_hash: "previous-keyed-hash", normalized_value: email, role: "visitor", enabled: true, updated_at: now.toISOString(), updated_by: "admin" });
    const service = new PortalService(store, { companyDomains: ["xindong.com"], now: () => new Date(now) });

    assert.equal((await service.signIn(identity("artist"))).role, "visitor");
    assert.equal((await store.getPolicy(currentPolicyId))?.updated_by, "system:policy-key-rotation");
    assert.equal(await store.getPolicy(previousPolicyId), null);
  });

  await suite.test("a disabled current policy blocks an enabled previous-key policy without migration", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    const email = "artist@xindong.com";
    const previousPolicyId = portalEmailPolicyId(email, policyKeyring, "k1");
    const currentPolicyId = portalEmailPolicyId(email);
    const previousPolicy = { policy_id: previousPolicyId, kind: "email" as const, value_hash: "previous-keyed-hash", normalized_value: email, role: "admin" as const, enabled: true, updated_at: new Date(now.getTime() - 1_000).toISOString(), updated_by: "previous-admin" };
    const currentPolicy = { policy_id: currentPolicyId, kind: "email" as const, value_hash: "current-keyed-hash", normalized_value: email, role: "visitor" as const, enabled: false, updated_at: now.toISOString(), updated_by: "current-admin" };
    await Promise.all([store.putPolicy(previousPolicy), store.putPolicy(currentPolicy)]);
    const service = new PortalService(store, { companyDomains: ["xindong.com"], now: () => new Date(now) });

    await assert.rejects(
      () => service.signIn(identity("artist")),
      (error: unknown) => error instanceof PortalError && error.code === "portal_access_denied",
    );
    assert.equal(await store.getUser("artist"), null);
    assert.deepEqual(await store.getPolicy(currentPolicyId), currentPolicy);
    assert.deepEqual(await store.getPolicy(previousPolicyId), previousPolicy);
    const audits = await firestore.collection("portalAuthAudit").where("action", "==", "portal_sign_in").get();
    assert.equal(audits.size, 1);
    assert.equal(audits.docs[0]?.get("actor_uid"), "artist");
    assert.equal(audits.docs[0]?.get("target_uid"), "artist");
    assert.equal(audits.docs[0]?.get("result"), "denied");
  });

  await suite.test("an ordered three-generation keyring keeps the newest disabled tombstone authoritative under concurrency", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
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
    const oldestPolicy = { policy_id: oldestPolicyId, kind: "email" as const, value_hash: "oldest-keyed-hash", normalized_value: email, role: "admin" as const, enabled: true, updated_at: new Date(now.getTime() - 2_000).toISOString(), updated_by: "oldest-admin" };
    const tombstone = { policy_id: newestPreviousPolicyId, kind: "email" as const, value_hash: "newest-previous-keyed-hash", normalized_value: email, role: "visitor" as const, enabled: false, updated_at: new Date(now.getTime() - 1_000).toISOString(), updated_by: "newest-previous-admin" };
    await Promise.all([store.putPolicy(oldestPolicy), store.putPolicy(tombstone)]);
    const service = new PortalService(store, { companyDomains: ["xindong.com"], policyKeyring: threeGenerationKeyring, now: () => new Date(now) });

    const attempts = await Promise.allSettled([
      service.signIn({ ...identity("artist-a"), email }),
      service.signIn({ ...identity("artist-b"), email }),
    ]);
    assert.equal(attempts.filter((result) => result.status === "rejected" && result.reason instanceof PortalError && result.reason.code === "portal_access_denied").length, 2);
    assert.equal(await store.getUser("artist-a"), null);
    assert.equal(await store.getUser("artist-b"), null);
    assert.equal((await store.getPolicy(currentPolicyId))?.enabled, false);
    assert.equal((await store.getPolicy(currentPolicyId))?.updated_by, "system:policy-key-rotation");
    assert.equal(await store.getPolicy(newestPreviousPolicyId), null);
    assert.deepEqual(await store.getPolicy(oldestPolicyId), oldestPolicy);
    const audits = await firestore.collection("portalAuthAudit").where("action", "==", "portal_sign_in").get();
    assert.equal(audits.docs.filter((document) => document.get("result") === "denied").length, 2);
  });

  await suite.test("sign-in cannot reactivate or re-promote a previously changed portal user", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    await Promise.all([store.putUser(portalUser("admin")), store.putUser(portalUser("artist"))]);
    const service = new PortalService(store, { companyDomains: ["xindong.com"], now: () => new Date(now) });

    await service.updatePerson({ identity: identity("admin"), targetUid: "artist", role: "visitor", status: "disabled", confirmation: "artist" });
    await assert.rejects(
      () => service.signIn(identity("artist")),
      (error: unknown) => error instanceof PortalError && error.code === "portal_disabled",
    );

    const artist = await store.getUser("artist");
    assert.equal(artist?.role, "visitor");
    assert.equal(artist?.status, "disabled");
  });

  await suite.test("first sign-in atomically observes an exact policy disabled during the request", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    const policy = { policy_id: portalEmailPolicyId("artist@xindong.com"), kind: "email" as const, value_hash: "email", normalized_value: "artist@xindong.com", role: "admin" as const, enabled: true, updated_at: now.toISOString(), updated_by: "bootstrap" };
    await store.putPolicy(policy);
    const signInUser = store.signInUser.bind(store);
    store.signInUser = async (input) => {
      await store.putPolicy({ ...policy, enabled: false, updated_at: new Date(now.getTime() + 1_000).toISOString() });
      return signInUser(input);
    };
    const service = new PortalService(store, { companyDomains: ["xindong.com"], now: () => new Date(now) });

    await assert.rejects(
      () => service.signIn(identity("artist")),
      (error: unknown) => error instanceof PortalError && error.code === "portal_access_denied",
    );
    assert.equal(await store.getUser("artist"), null);
  });

  await suite.test("first sign-in atomically observes an exact policy downgraded during the request", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    const policy = { policy_id: portalEmailPolicyId("artist@xindong.com"), kind: "email" as const, value_hash: "email", normalized_value: "artist@xindong.com", role: "admin" as const, enabled: true, updated_at: now.toISOString(), updated_by: "bootstrap" };
    await store.putPolicy(policy);
    const signInUser = store.signInUser.bind(store);
    store.signInUser = async (input) => {
      await store.putPolicy({ ...policy, role: "visitor", updated_at: new Date(now.getTime() + 1_000).toISOString() });
      return signInUser(input);
    };
    const service = new PortalService(store, { companyDomains: ["xindong.com"], now: () => new Date(now) });

    const session = await service.signIn(identity("artist"));
    assert.equal(session.role, "visitor");
    assert.equal((await store.getUser("artist"))?.role, "visitor");
  });

  await suite.test("portal principal reports consume toolUsageDaily documents produced by ingestion", async () => {
    await clear();
    const usage = new UsageIngestionService({
      auth: {
        async authorizeEvent() {
          return { bindingId: "binding-portal", pluginPrincipalId: "principal-portal", expiresAtSeconds: Math.floor(now.getTime() / 1000) + 3_600 };
        },
      },
      store: new FirestoreUsageStore(firestore),
      clock: { now: () => new Date(now) },
      registry,
    });
    const result = await usage.ingestBatch({
      queue_binding_id: "binding-portal",
      lease_token: "fixture-lease",
      events: [usageEvent("evt-portal-start", "run_started"), usageEvent("evt-portal-success", "run_succeeded")],
    });
    assert.deepEqual(result.results.map((item) => item.status), ["confirmed", "confirmed"]);
    await firestore.collection("pluginPrincipals").doc("principal-portal").set({
      email: "artist@xindong.com",
      displayName: "Artist",
      profileUpdatedAt: now.toISOString(),
    });

    const page = await new FirestorePortalStore(firestore).listPrincipalAggregates({ from: "2026-07-23", to: "2026-07-23" }, 100);
    assert.equal(page.items.length, 1);
    assert.deepEqual({
      principal: page.items[0].plugin_principal_id,
      tool: page.items[0].tool_key,
      action: page.items[0].action_key,
      started: page.items[0].run_started,
      succeeded: page.items[0].run_succeeded,
    }, {
      principal: "principal-portal",
      tool: "asset.export",
      action: "export",
      started: 1,
      succeeded: 1,
    });
  });

  await suite.test("error details paginate stably and isolate fingerprint, tool, action, version and company date", async () => {
    await clear();
    const fingerprint = "a".repeat(64);
    const otherFingerprint = "b".repeat(64);
    const events = [
      { id: "event-b", principal: "principal-b", fingerprint, observedAt: "2026-07-23T03:00:00.000Z", tool: "asset.export", action: "export", version: "1.0.0" },
      { id: "event-a", principal: "principal-a", fingerprint, observedAt: "2026-07-23T02:00:00.000Z", tool: "asset.export", action: "export", version: "1.0.0" },
      { id: "event-other-fingerprint", principal: "principal-other", fingerprint: otherFingerprint, observedAt: "2026-07-23T01:00:00.000Z", tool: "asset.export", action: "export", version: "1.0.0" },
      { id: "event-other-tool", principal: "principal-other", fingerprint, observedAt: "2026-07-23T01:00:00.000Z", tool: "asset.import", action: "export", version: "1.0.0" },
      { id: "event-other-action", principal: "principal-other", fingerprint, observedAt: "2026-07-23T01:00:00.000Z", tool: "asset.export", action: "preview", version: "1.0.0" },
      { id: "event-other-version", principal: "principal-other", fingerprint, observedAt: "2026-07-23T01:00:00.000Z", tool: "asset.export", action: "export", version: "2.0.0" },
      { id: "event-outside", principal: "principal-outside", fingerprint, observedAt: "2026-07-22T01:00:00.000Z", tool: "asset.export", action: "export", version: "1.0.0" },
    ];
    await Promise.all(events.map((event) => firestore.collection("usageEvents").doc(event.id).set({
      plugin_principal_id: event.principal,
      binding_id: `binding-${event.id}`,
      tool_key: event.tool,
      action_key: event.action,
      event_type: "run_failed",
      plugin_version: event.version,
      client_observed_at: event.observedAt,
      server_received_at: event.observedAt,
      time_correction: { corrected_observed_at: event.observedAt },
      error: { fingerprint: event.fingerprint },
    })));
    await Promise.all([
      firestore.collection("pluginPrincipals").doc("principal-a").set({ email: "artist-a@xindong.com", displayName: "Artist A" }),
      firestore.collection("pluginPrincipals").doc("principal-b").set({ email: "artist-b@xindong.com", displayName: "Artist B" }),
    ]);

    const store = new FirestorePortalStore(firestore);
    const filter = { from: "2026-07-23", to: "2026-07-23", toolKey: "asset.export", actionKey: "export", fingerprint, pluginVersion: "1.0.0" };
    const first = await store.listErrorDetails(filter, 1);
    assert.deepEqual(first.items.map((row) => ({ id: row.event_id, name: row.display_name, email: row.email })), [
      { id: "event-a", name: "Artist A", email: "artist-a@xindong.com" },
    ]);
    assert.ok(first.next_cursor);

    const second = await store.listErrorDetails(filter, 1, first.next_cursor ?? undefined);
    assert.deepEqual(second.items.map((row) => ({ id: row.event_id, name: row.display_name, email: row.email })), [
      { id: "event-b", name: "Artist B", email: "artist-b@xindong.com" },
    ]);
    assert.equal(second.next_cursor, null);
  });

  await suite.test("portal aggregate queries follow default, global, partition, rollback and finalized pointer states", async () => {
    await clear();
    const store = new FirestorePortalStore(firestore);
    const filter = { from: "2026-07-22", to: "2026-07-24" };
    const putDaily = (id: string, generation: string, date: string, principal: string, count: number) => firestore.collection("toolUsageDaily").doc(id).set({
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
    const putError = (id: string, generation: string, date: string, principal: string, count: number) => firestore.collection("errorAggregates").doc(id).set({
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
      time_corrected_count: 0,
      affected_versions: ["1.0.0"],
      summaries: [{ summary: "Safe failure", count }],
      principal_ids: [principal],
      status: "open",
    });
    const pointer = (activeGeneration: string, rollbackGeneration: string | null, generationPartitions: Array<Record<string, unknown>> = []) => ({
      active_generation: activeGeneration,
      write_generations: ["online", "shadow-global", "shadow-partition"],
      rollback_generation: rollbackGeneration,
      source_revision: 0,
      source_watermark: null,
      generation_partitions: generationPartitions,
      updated_at: now.toISOString(),
    });
    const partition = {
      from: "2026-07-22T16:00:00.000Z",
      to: "2026-07-23T16:00:00.000Z",
      generation: "shadow-partition",
      rollback_generation: "shadow-global",
    };

    await Promise.all([
      putDaily("online-22", "online", "2026-07-22", "online-a", 10),
      putDaily("online-23", "online", "2026-07-23", "online-b", 20),
      putDaily("online-24", "online", "2026-07-24", "online-c", 30),
      putDaily("global-22", "shadow-global", "2026-07-22", "global-a", 1),
      putDaily("global-23", "shadow-global", "2026-07-23", "global-b", 50),
      putDaily("global-24", "shadow-global", "2026-07-24", "global-c", 3),
      putDaily("partition-23", "shadow-partition", "2026-07-23", "partition-b", 2),
      putError("error-global-22", "shadow-global", "2026-07-22", "global-a", 1),
      putError("error-global-23", "shadow-global", "2026-07-23", "global-b", 50),
      putError("error-global-24", "shadow-global", "2026-07-24", "global-c", 3),
      putError("error-partition-23", "shadow-partition", "2026-07-23", "partition-b", 2),
    ]);

    assert.equal((await store.listTeamAggregates(filter, 100)).summary.run_started, 60, "missing pointer defaults to online");

    const pointerReference = firestore.collection("usageAggregatePointers").doc("active");
    await pointerReference.set(pointer("shadow-global", "online"));
    assert.equal((await store.listTeamAggregates(filter, 100)).summary.run_started, 54, "global cutover reads the active generation during rollback window");

    await pointerReference.set(pointer("shadow-global", null));
    assert.equal((await store.listTeamAggregates(filter, 100)).summary.run_started, 54, "finalized global cutover keeps the active generation");

    await pointerReference.set(pointer("online", "shadow-global"));
    assert.equal((await store.listTeamAggregates(filter, 100)).summary.run_started, 60, "global rollback reads the restored generation");

    await pointerReference.set(pointer("shadow-global", "online", [partition]));
    const partitionTeam = await store.listTeamAggregates(filter, 1);
    assert.equal(partitionTeam.summary.run_started, 6);
    assert.equal(partitionTeam.items[0]?.run_started, 6);
    assert.equal(partitionTeam.next_cursor, null);
    assert.deepEqual(partitionTeam.failure_trend.map((point) => point.date), ["2026-07-22", "2026-07-23", "2026-07-24"]);
    const principalPage = await store.listPrincipalAggregates(filter, 100);
    assert.deepEqual(principalPage.items.map((row) => [row.plugin_principal_id, row.run_started]), [["global-a", 1], ["global-c", 3], ["partition-b", 2]]);
    const errorPage = await store.listErrorAggregates(filter, 100);
    assert.equal(errorPage.items[0]?.count, 6);
    assert.equal(errorPage.items[0]?.distinct_users, 3);

    await pointerReference.set(pointer("shadow-global", "online", [{ ...partition, rollback_generation: null }]));
    assert.equal((await store.listTeamAggregates(filter, 100)).summary.run_started, 6, "finalized partition keeps its routed generation");

    await pointerReference.set(pointer("shadow-global", "online"));
    assert.equal((await store.listTeamAggregates(filter, 100)).summary.run_started, 54, "partition rollback removes the partition route");
  });
});
