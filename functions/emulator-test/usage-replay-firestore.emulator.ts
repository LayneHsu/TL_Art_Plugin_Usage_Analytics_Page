import assert from "node:assert/strict";
import test from "node:test";

import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import {
  FirestoreReplayService,
  FirestoreAggregateGenerationReader,
  ReplayOperationError,
  type FirestoreReplayRunResult,
} from "../src/usage/firestore-replay";
import { UsageIngestionService } from "../src/usage/ingestion";
import { FirestoreUsageStore } from "../src/usage/store";
import type { StoredUsageEvent, ToolRegistry } from "../src/usage/types";
import { createReplayAdminEndpointHandler, FirestoreReplayApprovalService } from "../src/usage/replay-admin";
import { PluginAuthError } from "../src/plugin-auth/errors";
import { dateBucket } from "../src/usage/aggregation";

const projectId = "demo-tl-art-tool-usage-analytics-replay";
const receivedAt = "2026-07-22T04:00:00.000Z";
const collections = [
  "usageEvents",
  "toolUsageDaily",
  "principalUsageDaily",
  "errorAggregates",
  "usageReplayAppliedEvents",
  "usageReplayJobs",
  "usageReplayLocks",
  "usageReplayGenerations",
  "usageReplayValidationGroups",
  "usageAggregateSourceRevisions",
  "usageAggregatePointers",
  "usageReplayApprovals",
];

const registry: ToolRegistry = {
  schema_version: "1.0.0",
  registry_version: "1.0.0",
  registry_status: "active",
  tools: [
    {
      tool_key: "asset.export",
      display_name: "Asset Export",
      page: "asset",
      introduced_version: "1.0.0",
      retired_version: null,
      accept_until: null,
      display_state: "active",
      actions: [
        {
          action_key: "export",
          display_name: "Export",
          page: "asset",
          introduced_version: "1.0.0",
          retired_version: null,
          accept_until: null,
          display_state: "active",
        },
      ],
    },
  ],
};

function stored(
  eventId: string,
  serverReceivedAt = receivedAt,
  eventType: StoredUsageEvent["event_type"] = "run_started",
): StoredUsageEvent {
  return {
    schema_version: "1.0.0",
    registry_version: "1.0.0",
    event_id: eventId,
    binding_id: "binding-replay",
    plugin_principal_id: "principal-replay",
    tool_key: "asset.export",
    action_key: "export",
    event_type: eventType,
    client_observed_at: serverReceivedAt,
    server_received_at: serverReceivedAt,
    plugin_version: "1.0.0",
    ue_version: "4.26",
    ui_version: "1.0.0",
    process_instance_id: "process-replay",
    session_id: "session-replay",
    operation_id: eventId,
    time_correction: {
      applied: false,
      corrected_observed_at: serverReceivedAt,
      clock_offset_ms: 0,
      reason: "within_tolerance",
    },
  };
}

function clientEvent(eventId: string): Record<string, unknown> {
  const source = stored(eventId);
  return {
    schema_version: source.schema_version,
    registry_version: source.registry_version,
    event_id: source.event_id,
    binding_id: source.binding_id,
    tool_key: source.tool_key,
    action_key: source.action_key,
    event_type: source.event_type,
    client_observed_at: source.client_observed_at,
    plugin_version: source.plugin_version,
    ue_version: source.ue_version,
    ui_version: source.ui_version,
    process_instance_id: source.process_instance_id,
    session_id: source.session_id,
    operation_id: source.operation_id,
  };
}

async function insertSourceEvent(firestore: Firestore, event: StoredUsageEvent): Promise<void> {
  const eventReference = firestore.collection("usageEvents").doc(event.event_id);
  const pointerReference = firestore.collection("usageAggregatePointers").doc("active");
  const sourceDate = dateBucket(event.time_correction.corrected_observed_at);
  const revisionReference = firestore.collection("usageAggregateSourceRevisions").doc(sourceDate);
  await firestore.runTransaction(async (transaction) => {
    const [existingEvent, pointer, revision] = await Promise.all([
      transaction.get(eventReference),
      transaction.get(pointerReference),
      transaction.get(revisionReference),
    ]);
    if (existingEvent.exists) return;
    const pointerData = pointer.data() ?? {};
    transaction.create(eventReference, event);
    transaction.set(revisionReference, {
      date: sourceDate,
      revision: Number(revision.data()?.revision ?? 0) + 1,
      updated_at: event.server_received_at,
    });
    transaction.set(pointerReference, {
      ...pointerData,
      active_generation: pointerData.active_generation ?? "online",
      write_generations: pointerData.write_generations ?? ["online"],
      rollback_generation: pointerData.rollback_generation ?? null,
      source_revision: Number(pointerData.source_revision ?? 0) + 1,
      source_watermark: {
        corrected_observed_at: event.time_correction.corrected_observed_at,
        server_received_at: event.server_received_at,
        event_id: event.event_id,
      },
      updated_at: event.server_received_at,
    });
  });
}

async function runUntilTerminal(
  service: FirestoreReplayService,
  input: Parameters<FirestoreReplayService["run"]>[0],
): Promise<FirestoreReplayRunResult> {
  let result = await service.run(input);
  for (let attempt = 0; result.status === "running" && attempt < 100; attempt += 1) {
    result = await service.run(input);
  }
  assert.notEqual(result.status, "running", "replay did not reach a terminal state");
  return result;
}

test("Firestore replay persists stable same-timestamp checkpoints and resumes idempotently", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must be provided by firebase emulators:exec");
  const app = initializeApp({ projectId }, `usage-replay-order-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));

  await insertSourceEvent(firestore, stored("evt-b"));
  await insertSourceEvent(firestore, stored("evt-a"));
  await insertSourceEvent(firestore, stored("evt-c"));
  const input = {
    replayId: "replay-order",
    generation: "shadow-order",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-order",
    pageSize: 1,
    maxPages: 1,
  };
  const first = await new FirestoreReplayService({ firestore }).run(input);
  assert.equal(first.status, "running");
  assert.deepEqual(first.checkpoint, {
    corrected_observed_at: receivedAt,
    server_received_at: receivedAt,
    event_id: "evt-a",
  });

  const resumed = await runUntilTerminal(new FirestoreReplayService({ firestore }), input);
  assert.equal(resumed.status, "switched");
  assert.equal(resumed.validation?.matched, true);
  assert.equal(resumed.validation?.source.event_count, 3);
  assert.equal(resumed.validation?.shadow.event_count, 3);
  assert.equal(resumed.validation?.source.group_digest, resumed.validation?.shadow.group_digest);

  const markerSnapshot = await firestore.collection("usageReplayAppliedEvents").where("generation", "==", "shadow-order").get();
  assert.equal(markerSnapshot.size, 3);
  const dailySnapshot = await firestore.collection("toolUsageDaily").where("generation", "==", "shadow-order").get();
  assert.equal(dailySnapshot.size, 1);
  assert.equal(dailySnapshot.docs[0].data().run_started, 3);

  const repeated = await new FirestoreReplayService({ firestore }).run(input);
  assert.equal(repeated.status, "switched");
  const repeatedDaily = await firestore.collection("toolUsageDaily").where("generation", "==", "shadow-order").get();
  assert.equal(repeatedDaily.docs[0].data().run_started, 3);
});

test("replay validation rejects a changed error fingerprint with the same total count", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-fingerprint-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));

  await insertSourceEvent(firestore, {
    ...stored("evt-error"),
    event_type: "run_failed",
    error: {
      error_category: "internal",
      summary: "safe failure summary",
      fingerprint: "a".repeat(64),
    },
  });
  const input = {
    replayId: "replay-fingerprint",
    generation: "shadow-fingerprint",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-fingerprint",
    pageSize: 1,
    maxPages: 1,
  };
  const first = await new FirestoreReplayService({ firestore }).run(input);
  assert.equal(first.status, "running");
  const errors = await firestore.collection("errorAggregates").where("generation", "==", "shadow-fingerprint").get();
  assert.equal(errors.size, 1);
  await errors.docs[0].ref.update({ fingerprint: "tampered-fingerprint" });

  let rejected = false;
  for (let attempt = 0; attempt < 30 && !rejected; attempt += 1) {
    try {
      await new FirestoreReplayService({ firestore }).run(input);
    } catch (error) {
      assert.ok(error instanceof ReplayOperationError && error.code === "replay_validation_failed");
      rejected = true;
    }
  }
  assert.equal(rejected, true);
});

test("Firestore replay rebuilds and validates separate error aggregates for each plugin version", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-error-versions-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));

  const error = {
    error_category: "internal" as const,
    summary: "safe version failure",
    fingerprint: "a".repeat(64),
  };
  await insertSourceEvent(firestore, { ...stored("evt-error-version-1"), event_type: "run_failed", plugin_version: "1.0.0", error });
  await insertSourceEvent(firestore, { ...stored("evt-error-version-2", "2026-07-22T04:01:00.000Z"), event_type: "run_failed", plugin_version: "2.0.0", error });
  const input = {
    replayId: "replay-error-versions",
    generation: "shadow-error-versions",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-error-versions",
    pageSize: 10,
    maxPages: 10,
  };

  const result = await runUntilTerminal(new FirestoreReplayService({ firestore }), input);
  assert.equal(result.status, "switched");
  assert.equal(result.validation?.matched, true);
  const errors = await firestore.collection("errorAggregates").where("generation", "==", "shadow-error-versions").get();
  assert.deepEqual(errors.docs.map((document) => ({
    plugin_version: document.data().plugin_version,
    count: document.data().count,
    affected_versions: document.data().affected_versions,
  })).sort((left, right) => String(left.plugin_version).localeCompare(String(right.plugin_version))), [
    { plugin_version: "1.0.0", count: 1, affected_versions: ["1.0.0"] },
    { plugin_version: "2.0.0", count: 1, affected_versions: ["2.0.0"] },
  ]);
});

test("global rollback restores the date partitions that global cutover replaced", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-global-partitions-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await insertSourceEvent(firestore, stored("evt-global-partition"));
  await firestore.collection("usageAggregatePointers").doc("active").set({
    active_generation: "online",
    write_generations: ["online", "old-partition"],
    rollback_generation: null,
    source_revision: 1,
    source_watermark: null,
    generation_partitions: [{
      from: "2026-07-21T16:00:00.000Z",
      to: "2026-07-22T16:00:00.000Z",
      generation: "old-partition",
      rollback_generation: null,
    }],
    updated_at: receivedAt,
  });
  const input = {
    replayId: "replay-global-partitions",
    generation: "shadow-global-partitions",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-global-partitions",
    pageSize: 10,
    maxPages: 10,
  };
  const switched = await runUntilTerminal(new FirestoreReplayService({ firestore }), input);
  assert.equal(switched.status, "switched");
  const rolledBack = await new FirestoreReplayService({ firestore }).rollback({ replayId: input.replayId, ownerId: input.ownerId });
  assert.equal(rolledBack.status, "rolled_back");
  const pointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.deepEqual(pointer?.generation_partitions, [{
    from: "2026-07-21T16:00:00.000Z",
    to: "2026-07-22T16:00:00.000Z",
    generation: "old-partition",
    rollback_generation: "shadow-global-partitions",
  }]);
  assert.equal((await new FirestoreReplayService({ firestore }).finalize({ replayId: input.replayId, ownerId: input.ownerId })).status, "finalized");
  const finalizedPointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.deepEqual(finalizedPointer?.generation_partitions, [{
    from: "2026-07-21T16:00:00.000Z",
    to: "2026-07-22T16:00:00.000Z",
    generation: "old-partition",
    rollback_generation: null,
  }]);
  assert.deepEqual(finalizedPointer?.write_generations, ["online", "old-partition"]);
});

test("bounded global replay refuses to hide readable aggregate history outside its window", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-global-coverage-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await insertSourceEvent(firestore, stored("evt-global-window"));
  await firestore.collection("toolUsageDaily").doc("online|2026-07-20|principal-a|asset.export|export").set({
    id: "online|2026-07-20|principal-a|asset.export|export",
    generation: "online",
    date: "2026-07-20",
    plugin_principal_id: "principal-a",
    tool_key: "asset.export",
    action_key: "export",
    event_count: 1,
    run_started: 1,
    run_succeeded: 1,
    run_failed: 0,
    run_cancelled: 0,
    run_interrupted: 0,
    duration_total_ms: 100,
    duration_count: 1,
    duration_max_ms: 100,
    updated_at: "2026-07-20T04:00:00.000Z",
  });
  const input = {
    replayId: "replay-global-incomplete",
    generation: "shadow-global-incomplete",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-global-incomplete",
    pageSize: 10,
    maxPages: 10,
  };

  await assert.rejects(
    () => runUntilTerminal(new FirestoreReplayService({ firestore }), input),
    (error: unknown) => error instanceof ReplayOperationError && error.code === "replay_global_window_incomplete",
  );
  const pointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(pointer?.active_generation, "online");
});

test("validation mismatch moves a replay to a terminal failed state", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-validation-failed-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await insertSourceEvent(firestore, stored("evt-validation-failed"));
  const input = {
    replayId: "replay-validation-failed",
    generation: "shadow-validation-failed",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-validation-failed",
    pageSize: 10,
    maxPages: 1,
  };
  await new FirestoreReplayService({ firestore }).run(input);
  await firestore.collection("toolUsageDaily").where("generation", "==", input.generation).get().then(async (snapshot) => {
    await Promise.all(snapshot.docs.map((document) => document.ref.update({ event_count: 99 })));
  });
  await assert.rejects(
    () => runUntilTerminal(new FirestoreReplayService({ firestore }), input),
    (error: unknown) => error instanceof ReplayOperationError && error.code === "replay_validation_failed",
  );
  const job = (await firestore.collection("usageReplayJobs").doc(input.replayId).get()).data();
  assert.equal(job?.status, "failed");
  assert.equal(job?.phase, "failed");
});

test("a second cutover is rejected while an earlier rollback window is open", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-rollback-window-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await insertSourceEvent(firestore, stored("evt-rollback-window"));
  const firstInput = {
    replayId: "replay-rollback-window-first",
    generation: "shadow-rollback-window-first",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-rollback-window-first",
    pageSize: 10,
    maxPages: 10,
  };
  assert.equal((await runUntilTerminal(new FirestoreReplayService({ firestore }), firstInput)).status, "switched");
  const secondInput = { ...firstInput, replayId: "replay-rollback-window-second", generation: "shadow-rollback-window-second", ownerId: "worker-rollback-window-second" };
  await assert.rejects(
    () => runUntilTerminal(new FirestoreReplayService({ firestore }), secondInput),
    (error: unknown) => error instanceof ReplayOperationError && error.code === "replay_rollback_window_active",
  );
});

test("aggregate reader returns non-overlapping generation segments across partition gaps", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-reader-segments-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await firestore.collection("usageAggregatePointers").doc("active").set({
    active_generation: "online",
    write_generations: ["online", "partition-a", "partition-b"],
    rollback_generation: null,
    source_revision: 0,
    source_watermark: null,
    generation_partitions: [
      { from: "2026-07-22T00:00:00.000Z", to: "2026-07-23T00:00:00.000Z", generation: "partition-a", rollback_generation: null },
      { from: "2026-07-24T00:00:00.000Z", to: "2026-07-25T00:00:00.000Z", generation: "partition-b", rollback_generation: null },
    ],
    updated_at: receivedAt,
  });
  const reader = new FirestoreAggregateGenerationReader(firestore);
  assert.deepEqual(
    await reader.getActiveGenerationSegmentsForRange(
      new Date("2026-07-21T00:00:00.000Z"),
      new Date("2026-07-26T00:00:00.000Z"),
    ),
    [
      { from: "2026-07-21T00:00:00.000Z", to: "2026-07-22T00:00:00.000Z", generation: "online" },
      { from: "2026-07-22T00:00:00.000Z", to: "2026-07-23T00:00:00.000Z", generation: "partition-a" },
      { from: "2026-07-23T00:00:00.000Z", to: "2026-07-24T00:00:00.000Z", generation: "online" },
      { from: "2026-07-24T00:00:00.000Z", to: "2026-07-25T00:00:00.000Z", generation: "partition-b" },
      { from: "2026-07-25T00:00:00.000Z", to: "2026-07-26T00:00:00.000Z", generation: "online" },
    ],
  );
});

test("replay renews its lock while processing a slow page", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-page-heartbeat-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await insertSourceEvent(firestore, stored("evt-heartbeat-a"));
  await insertSourceEvent(firestore, stored("evt-heartbeat-b"));
  await insertSourceEvent(firestore, stored("evt-heartbeat-c"));
  let tick = Date.parse(receivedAt);
  const service = new FirestoreReplayService({
    firestore,
    lockLeaseMs: 1_000,
    clock: () => {
      const value = new Date(tick);
      tick += 120;
      return value;
    },
  });
  const result = await service.run({
    replayId: "replay-page-heartbeat",
    generation: "shadow-page-heartbeat",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global",
    ownerId: "worker-page-heartbeat",
    pageSize: 3,
    maxPages: 1,
  });
  assert.equal(result.status, "running");
  assert.equal(result.processed, 3);
});

test("replay admin endpoint requires service-account OIDC and separate approval", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-admin-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  let runCalls = 0;
  let finalizeCalls = 0;
  const handler = createReplayAdminEndpointHandler({
    approvals: new FirestoreReplayApprovalService(firestore, () => new Date(receivedAt)),
    verifier: {
      async verify(token: string) {
        if (token === "portal-token") throw new PluginAuthError("OPS_IDENTITY_REQUIRED", "Plugin operations identity is required");
        const email = token === "approver-token" ? "approver@project.iam.gserviceaccount.com" : "requester@project.iam.gserviceaccount.com";
        return { actorId: `serviceAccount:${email}`, issuer: "https://accounts.google.com", subject: email, email };
      },
    },
    replay: {
      async run() { runCalls += 1; return { status: "switched" }; },
      async rollback() { return { status: "rolled_back" }; },
      async finalize() { finalizeCalls += 1; return { status: "finalized" }; },
    } as never,
  });
  const invoke = async (token: string, body: Record<string, unknown>) => {
    let status = 0;
    let responseBody: any;
    await handler({ method: "POST", protocol: "https", headers: { authorization: `Bearer ${token}` }, body, rawBody: Buffer.from(JSON.stringify(body)), is: (name: string) => name === "application/json", get: () => undefined } as never, {
      status(value: number) { status = value; return this; },
      json(value: unknown) { responseBody = value; return this; },
    } as never);
    return { status, body: responseBody };
  };
  const payload = { replay_id: "replay-admin", generation: "shadow-admin", from: "2026-07-21T16:00:00.000Z", to: "2026-07-22T16:00:00.000Z", cutover_scope: "global", page_size: 10, max_pages: 1 };
  const { cutover_scope: _cutoverScope, ...ambiguousPayload } = payload;
  assert.equal((await invoke("requester-token", { operation: "request", action: "run", payload: ambiguousPayload })).status, 400);
  const requested = await invoke("requester-token", { operation: "request", action: "run", payload });
  assert.equal(requested.status, 200);
  const reviewId = requested.body.result.review_id;
  assert.equal((await invoke("requester-token", { operation: "approve", review_id: reviewId })).status, 403);
  assert.equal((await invoke("approver-token", { operation: "approve", review_id: reviewId })).status, 200);
  assert.equal((await invoke("requester-token", {
    operation: "run",
    review_id: reviewId,
    payload: { ...payload, generation: "shadow-substituted" },
  })).status, 409);
  assert.equal((await invoke("portal-token", { operation: "run", review_id: reviewId, payload })).status, 401);
  assert.equal((await invoke("requester-token", { operation: "run", review_id: reviewId, payload })).status, 200);
  assert.equal(runCalls, 1);
  assert.equal((await invoke("requester-token", { operation: "run", review_id: reviewId, payload })).status, 409);

  const finalizePayload = { replay_id: "replay-admin" };
  const finalizeRequest = await invoke("requester-token", { operation: "request", action: "finalize", payload: finalizePayload });
  assert.equal(finalizeRequest.status, 200);
  const finalizeReviewId = finalizeRequest.body.result.review_id;
  assert.equal((await invoke("approver-token", { operation: "approve", review_id: finalizeReviewId })).status, 200);
  const finalized = await invoke("requester-token", { operation: "finalize", review_id: finalizeReviewId, payload: finalizePayload });
  assert.equal(finalized.status, 200);
  assert.equal(finalized.body.result.status, "finalized");
  assert.equal(finalizeCalls, 1);
});

test("a failed replay execution consumes its approval exactly once", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-admin-failed-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  const approvals = new FirestoreReplayApprovalService(firestore, () => new Date(receivedAt));
  const requesterEmail = "requester@project.iam.gserviceaccount.com";
  const approverEmail = "approver@project.iam.gserviceaccount.com";
  const requester = { actorId: `serviceAccount:${requesterEmail}`, issuer: "https://accounts.google.com", subject: requesterEmail, email: requesterEmail };
  const approver = { actorId: `serviceAccount:${approverEmail}`, issuer: "https://accounts.google.com", subject: approverEmail, email: approverEmail };
  const payload = {
    replay_id: "replay-admin-failed",
    generation: "shadow-admin-failed",
    from: "2026-07-21T16:00:00.000Z",
    to: "2026-07-22T16:00:00.000Z",
    cutover_scope: "global",
    page_size: 10,
    max_pages: 1,
  };
  const requested = await approvals.request({ identity: requester, action: "run", payload });
  await approvals.approve({ identity: approver, reviewId: requested.review_id });
  const replay = {
    async run() { throw new Error("replay failed"); },
    async rollback() { return { status: "rolled_back" }; },
    async finalize() { return { status: "finalized" }; },
  };
  await assert.rejects(approvals.execute({ identity: requester, reviewId: requested.review_id, action: "run", payload, replay }));
  await assert.rejects(
    approvals.execute({ identity: requester, reviewId: requested.review_id, action: "run", payload, replay }),
    /unavailable/i,
  );
  const review = (await firestore.collection("usageReplayApprovals").doc(requested.review_id).get()).data();
  assert.equal(review?.status, "failed");
});

test("Firestore replay lock lease rejects a competing worker and permits takeover after expiry", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-lock-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await firestore.collection("usageReplayLocks").doc("aggregate-rebuild").set({
    owner_id: "worker-other",
    replay_id: "replay-other",
    acquired_at: "2026-07-22T03:59:00.000Z",
    expires_at: "2026-07-22T04:05:00.000Z",
    released_at: null,
  });

  const service = new FirestoreReplayService({
    firestore,
    clock: () => new Date("2026-07-22T04:00:00.000Z"),
  });
  await assert.rejects(
    service.run({
      replayId: "replay-lock",
      generation: "shadow-lock",
      from: new Date("2026-07-21T16:00:00.000Z"),
      to: new Date("2026-07-22T16:00:00.000Z"),
      cutoverScope: "global",
      ownerId: "worker-lock",
      pageSize: 10,
      maxPages: 1,
    }),
    (error: unknown) => error instanceof ReplayOperationError && error.code === "replay_lock_busy",
  );

  const afterExpiry = new FirestoreReplayService({
    firestore,
    clock: () => new Date("2026-07-22T04:06:00.000Z"),
  });
  const result = await runUntilTerminal(afterExpiry, {
    replayId: "replay-lock",
    generation: "shadow-lock",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global",
    ownerId: "worker-lock",
    pageSize: 10,
    maxPages: 1,
  } as never);
  assert.equal(result.status, "switched");
});

test("Firestore replay rescans behind its checkpoint for late commits, cuts over atomically, and rolls back", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-catchup-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));

  await insertSourceEvent(firestore, stored("evt-a"));
  await insertSourceEvent(firestore, stored("evt-c"));
  const input = {
    replayId: "replay-catchup",
    generation: "shadow-catchup",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-catchup",
    pageSize: 1,
    maxPages: 1,
  };
  const first = await new FirestoreReplayService({ firestore }).run(input);
  assert.equal(first.checkpoint?.event_id, "evt-a");

  // Simulates an ingestion transaction that commits after the replay page but
  // sorts before its persisted checkpoint.
  await insertSourceEvent(firestore, stored("evt-0"));
  const switched = await runUntilTerminal(new FirestoreReplayService({ firestore }), input);
  assert.equal(switched.status, "switched");
  assert.equal(switched.validation?.source.event_count, 3);
  assert.ok((switched.catchup_passes ?? 0) >= 2);

  const active = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(active?.active_generation, "shadow-catchup");
  assert.deepEqual(active?.write_generations, ["shadow-catchup", "online"]);
  assert.equal(active?.rollback_generation, "online");

  const rolledBack = await new FirestoreReplayService({ firestore }).rollback({
    replayId: "replay-catchup",
    ownerId: "worker-rollback",
  });
  assert.equal(rolledBack.status, "rolled_back");
  const pointerAfterRollback = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(pointerAfterRollback?.active_generation, "online");
  assert.deepEqual(pointerAfterRollback?.write_generations, ["online", "shadow-catchup"]);
  assert.equal(pointerAfterRollback?.rollback_generation, "shadow-catchup");
  assert.equal((await new FirestoreReplayService({ firestore }).finalize({
    replayId: "replay-catchup",
    ownerId: "worker-rollback-finalize",
  })).status, "finalized");
  const pointerAfterFinalize = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.deepEqual(pointerAfterFinalize?.write_generations, ["online"]);
  assert.equal(pointerAfterFinalize?.rollback_generation, null);
});

test("Firestore replay claims a generation once and permits only the original replay to resume", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-generation-claim-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await insertSourceEvent(firestore, stored("evt-claim"));
  const request = {
    generation: "shadow-claimed",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-claim",
    pageSize: 10,
    maxPages: 10,
  };
  const first = new FirestoreReplayService({ firestore });
  assert.equal((await first.run({ ...request, replayId: "replay-claim-a" })).status, "switched");
  await assert.rejects(
    new FirestoreReplayService({ firestore }).run({ ...request, replayId: "replay-claim-b" }),
    (error: unknown) => error instanceof ReplayOperationError && error.code === "replay_generation_claimed",
  );
  assert.equal((await new FirestoreReplayService({ firestore }).run({ ...request, replayId: "replay-claim-a" })).status, "switched");
});

test("Firestore replay catches an event accepted by the live ingestion transaction after the first page", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-live-ingestion-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));

  const usageStore = new FirestoreUsageStore(firestore);
  const ingestion = new UsageIngestionService({
    auth: {
      authorizeEvent: async () => ({
        bindingId: "binding-replay",
        pluginPrincipalId: "principal-replay",
        expiresAtSeconds: Math.floor(Date.parse("2026-07-22T05:00:00.000Z") / 1000),
      }),
    },
    store: usageStore,
    registry,
    clock: { now: () => new Date(receivedAt) },
  });
  const ingest = async (eventId: string) => ingestion.ingestBatch({
    queue_binding_id: "binding-replay",
    lease_token: "fixture-lease",
    events: [clientEvent(eventId)],
  });

  assert.equal((await ingest("evt-a")).results[0].status, "confirmed");
  assert.equal((await ingest("evt-c")).results[0].status, "confirmed");
  const input = {
    replayId: "replay-live-ingestion",
    generation: "shadow-live-ingestion",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-live-ingestion",
    pageSize: 1,
    maxPages: 1,
  };
  const first = await new FirestoreReplayService({
    firestore,
    clock: () => new Date(receivedAt),
  }).run(input);
  assert.equal(first.status, "running");
  assert.equal(first.checkpoint?.event_id, "evt-a");

  assert.equal((await ingest("evt-b")).results[0].status, "confirmed");
  const switched = await runUntilTerminal(new FirestoreReplayService({
    firestore,
    clock: () => new Date(receivedAt),
  }), input);
  assert.equal(switched.status, "switched");
  assert.equal(switched.validation?.source.event_count, 3);
  assert.equal(switched.validation?.shadow.event_count, 3);
  assert.ok(switched.catchup_passes >= 2);
  const pointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(pointer?.source_revision, 3);
  assert.equal(pointer?.active_generation, "shadow-live-ingestion");
});

test("outside-window writes do not starve replay and partial cutover preserves outside history", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-partition-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await insertSourceEvent(firestore, stored("evt-inside"));
  const input = {
    replayId: "replay-partition",
    generation: "shadow-partition",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "partition" as const,
    ownerId: "worker-partition",
    pageSize: 1,
    maxPages: 1,
  };
  assert.equal((await new FirestoreReplayService({ firestore }).run(input)).status, "running");
  await insertSourceEvent(firestore, stored("evt-at-exclusive-end", "2026-07-22T16:00:00.000Z"));
  await insertSourceEvent(firestore, stored("evt-outside-a", "2026-07-24T04:00:00.000Z"));
  await new FirestoreReplayService({ firestore }).run(input);
  await insertSourceEvent(firestore, stored("evt-outside-b", "2026-07-24T04:00:01.000Z"));
  const switched = await runUntilTerminal(new FirestoreReplayService({ firestore }), input);
  assert.equal(switched.status, "switched");
  assert.equal(switched.validation?.source.event_count, 1);
  const pointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(pointer?.active_generation, "online");
  assert.equal(pointer?.generation_partitions?.[0]?.generation, "shadow-partition", JSON.stringify(pointer));
  const reader = new FirestoreAggregateGenerationReader(firestore);
  assert.deepEqual(await reader.getActiveGenerationsForRange(new Date("2026-07-22T01:00:00.000Z"), new Date("2026-07-22T02:00:00.000Z")), ["shadow-partition"]);
  assert.deepEqual(await reader.getActiveGenerationsForRange(new Date("2026-07-24T00:00:00.000Z"), new Date("2026-07-25T00:00:00.000Z")), ["online"]);
  assert.equal((await new FirestoreReplayService({ firestore }).finalize({
    replayId: "replay-partition",
    ownerId: "worker-partition-finalize",
  })).status, "finalized");
  const finalizedPointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(finalizedPointer?.generation_partitions?.[0]?.rollback_generation, null);
});

test("replay selects the aggregate window by corrected observed time", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-corrected-time-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));

  await insertSourceEvent(firestore, {
    ...stored("evt-late-arrival", "2026-07-25T04:00:00.000Z"),
    client_observed_at: receivedAt,
    time_correction: {
      applied: false,
      corrected_observed_at: receivedAt,
      clock_offset_ms: 0,
      reason: "within_tolerance",
    },
  });
  await insertSourceEvent(firestore, {
    ...stored("evt-received-inside", receivedAt),
    client_observed_at: "2026-07-23T04:00:00.000Z",
    time_correction: {
      applied: false,
      corrected_observed_at: "2026-07-23T04:00:00.000Z",
      clock_offset_ms: 0,
      reason: "within_tolerance",
    },
  });

  const result = await runUntilTerminal(new FirestoreReplayService({ firestore }), {
    replayId: "replay-corrected-time",
    generation: "shadow-corrected-time",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "partition",
    ownerId: "worker-corrected-time",
    pageSize: 10,
    maxPages: 1,
  } as never);
  assert.equal(result.status, "switched");
  assert.equal(result.validation?.source.event_count, 1);
  const markers = await firestore.collection("usageReplayAppliedEvents").where("generation", "==", "shadow-corrected-time").get();
  assert.deepEqual(markers.docs.map((document) => document.data().event_id), ["evt-late-arrival"]);
});

test("explicit partition replay preserves aggregate history after raw-event retention", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-retained-history-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await firestore.collection("toolUsageDaily").doc("online|2026-06-01|principal-old|asset.export|export").set({
    id: "online|2026-06-01|principal-old|asset.export|export",
    date: "2026-06-01",
    plugin_principal_id: "principal-old",
    tool_key: "asset.export",
    action_key: "export",
    run_started: 7,
    run_succeeded: 7,
    run_failed: 0,
    run_cancelled: 0,
    run_interrupted: 0,
    duration_total_ms: 0,
    duration_count: 0,
    duration_max_ms: 0,
    event_count: 14,
    generation: "online",
    updated_at: "2026-06-01T04:00:00.000Z",
  });
  await insertSourceEvent(firestore, stored("evt-current"));

  const result = await runUntilTerminal(new FirestoreReplayService({ firestore }), {
    replayId: "replay-retained-history",
    generation: "shadow-retained-history",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "partition",
    ownerId: "worker-retained-history",
    pageSize: 10,
    maxPages: 1,
  } as never);
  assert.equal(result.status, "switched");
  const pointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(pointer?.active_generation, "online");
  assert.equal(pointer?.generation_partitions?.[0]?.generation, "shadow-retained-history");
  const reader = new FirestoreAggregateGenerationReader(firestore);
  assert.deepEqual(
    await reader.getActiveGenerationsForRange(new Date("2026-06-01T00:00:00.000Z"), new Date("2026-06-02T00:00:00.000Z")),
    ["online"],
  );
});

test("validation checkpoints bounded pages and catches a commit after validation", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-validation-resume-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  for (let index = 0; index < 4; index += 1) {
    await insertSourceEvent(firestore, {
      ...stored(`evt-validation-${index}`),
      plugin_principal_id: `principal-validation-${index}`,
    });
  }
  const input = {
    replayId: "replay-validation-resume",
    generation: "shadow-validation-resume",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-validation-resume",
    pageSize: 1,
    maxPages: 1,
  };

  let sawPersistedValidationCheckpoint = false;
  let validationCompletedBeforeCutover = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await new FirestoreReplayService({ firestore }).run(input as never);
    const job = (await firestore.collection("usageReplayJobs").doc(input.replayId).get()).data();
    const progress = job?.validation_progress;
    if (result.status === "running" && progress?.cursor) sawPersistedValidationCheckpoint = true;
    if (result.status === "running" && progress?.stage === "complete") {
      validationCompletedBeforeCutover = true;
      break;
    }
  }
  assert.equal(sawPersistedValidationCheckpoint, true);
  assert.equal(validationCompletedBeforeCutover, true);

  await insertSourceEvent(firestore, {
    ...stored("evt-after-validation"),
    plugin_principal_id: "principal-after-validation",
  });
  const switched = await runUntilTerminal(new FirestoreReplayService({ firestore }), input as never);
  assert.equal(switched.status, "switched");
  assert.equal(switched.validation?.source.event_count, 5);
  assert.equal(switched.validation?.shadow.event_count, 5);
  assert.ok(switched.catchup_passes >= 2);
});

test("finalize ends the rollback window and collapses obsolete global writes", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-finalize-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await insertSourceEvent(firestore, stored("evt-finalize"));
  const input = {
    replayId: "replay-finalize",
    generation: "shadow-finalize",
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "global" as const,
    ownerId: "worker-finalize",
    pageSize: 10,
    maxPages: 10,
  };
  assert.equal((await runUntilTerminal(new FirestoreReplayService({ firestore }), input as never)).status, "switched");

  const service = new FirestoreReplayService({ firestore });
  const finalize = (service as unknown as {
    finalize(value: { replayId: string; ownerId: string }): Promise<FirestoreReplayRunResult>;
  }).finalize;
  assert.equal(typeof finalize, "function");
  const finalized = await finalize.call(service, { replayId: input.replayId, ownerId: "worker-finalize-close" });
  assert.equal(finalized.status, "finalized");
  const pointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(pointer?.active_generation, "shadow-finalize");
  assert.deepEqual(pointer?.write_generations, ["shadow-finalize"]);
  assert.equal(pointer?.rollback_generation, null);
});

test("a finalized date partition can be replaced, rolled back, and finalized again", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const app = initializeApp({ projectId }, `usage-replay-partition-replacement-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  await insertSourceEvent(firestore, stored("evt-partition-replacement"));
  const baseInput = {
    from: new Date("2026-07-21T16:00:00.000Z"),
    to: new Date("2026-07-22T16:00:00.000Z"),
    cutoverScope: "partition" as const,
    pageSize: 10,
    maxPages: 10,
  };
  const firstInput = {
    ...baseInput,
    replayId: "replay-partition-first",
    generation: "shadow-partition-first",
    ownerId: "worker-partition-first",
  };
  assert.equal((await runUntilTerminal(new FirestoreReplayService({ firestore }), firstInput as never)).status, "switched");
  await new FirestoreReplayService({ firestore }).finalize({
    replayId: firstInput.replayId,
    ownerId: "worker-partition-first-finalize",
  });

  const secondInput = {
    ...baseInput,
    replayId: "replay-partition-second",
    generation: "shadow-partition-second",
    ownerId: "worker-partition-second",
  };
  assert.equal((await runUntilTerminal(new FirestoreReplayService({ firestore }), secondInput as never)).status, "switched");
  let pointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(pointer?.generation_partitions?.length, 1);
  assert.equal(pointer?.generation_partitions?.[0]?.generation, "shadow-partition-second");
  assert.equal(pointer?.generation_partitions?.[0]?.rollback_generation, "shadow-partition-first");

  assert.equal((await new FirestoreReplayService({ firestore }).rollback({
    replayId: secondInput.replayId,
    ownerId: "worker-partition-second-rollback",
  })).status, "rolled_back");
  pointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(pointer?.generation_partitions?.length, 1);
  assert.equal(pointer?.generation_partitions?.[0]?.generation, "shadow-partition-first");
  assert.equal(pointer?.generation_partitions?.[0]?.rollback_generation, "shadow-partition-second");

  await new FirestoreReplayService({ firestore }).finalize({
    replayId: secondInput.replayId,
    ownerId: "worker-partition-second-finalize",
  });
  pointer = (await firestore.collection("usageAggregatePointers").doc("active").get()).data();
  assert.equal(pointer?.generation_partitions?.length, 1);
  assert.equal(pointer?.generation_partitions?.[0]?.generation, "shadow-partition-first");
  assert.equal(pointer?.generation_partitions?.[0]?.rollback_generation, null);
  assert.deepEqual(pointer?.write_generations, ["online", "shadow-partition-first"]);
});
