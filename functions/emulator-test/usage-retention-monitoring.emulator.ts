import assert from "node:assert/strict";
import test from "node:test";

import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import { PluginAuthError } from "../src/plugin-auth/errors";
import { createUsageIngestionEndpointHandler } from "../src/usage/endpoints";
import {
  FirestoreRetentionAdapter,
  FirestoreRetentionCleanupService,
  type RetentionCleanupRuntimeConfig,
  createScheduledRetentionCleanupHandler,
} from "../src/usage/retention-firestore";
import {
  FirestoreMonitoringService,
  createScheduledUsageMonitoringHandler,
} from "../src/usage/monitoring-firestore";
import {
  buildScheduledRetentionRunId,
  resolveScheduledRetentionRunId,
} from "../src/usage/scheduled";

const projectId = "demo-tl-art-tool-usage-analytics-maintenance";
const now = new Date("2026-07-22T04:00:00.000Z");
const collectionNames = [
  "usageEvents",
  "deadLetters",
  "pluginAuthAudit",
  "toolUsageDaily",
  "principalUsageDaily",
  "errorAggregates",
  "usageRetentionRuns",
  "usageRetentionSchedules",
  "usageRetentionAudit",
  "usageMonitoringCounters",
  "usageMonitoringSnapshots",
  "usageMonitoringAlerts",
  "usageMonitoringNotifications",
  "usageQuotas",
  "usageOperations",
  "usageEventReservations",
  "usageReplayApprovals",
  "usageReplayJobs",
  "usageReplayLocks",
  "usageAggregatePointers",
  "usageReplayValidationGroups",
  "usageAggregateSourceRevisions",
];

async function clean(firestore: Firestore): Promise<void> {
  await Promise.all(collectionNames.map((name) => firestore.recursiveDelete(firestore.collection(name))));
}

function app(name: string) {
  // Each emulator test app gets its own project namespace so parallel suites
  // cannot delete another suite's fixtures during cleanup.
  return initializeApp({ projectId: `${projectId}-${name}` }, `${name}-${Date.now()}-${Math.random()}`);
}

function policy(): RetentionCleanupRuntimeConfig {
  return {
    rawEventRetentionMs: 10,
    deadLetterRetentionMs: 10,
    authAuditRetentionMs: 10,
    aggregateRetentionMs: 10,
    quotaRetentionMs: 10,
    operationRetentionMs: 10,
    replayMetadataRetentionMs: 10,
    retentionRunRetentionMs: 10,
    monitoringRetentionMs: 10,
    rebuildWindowMs: 5,
    lateArrivalAllowanceMs: 5,
    batchSize: 2,
  };
}

test("Firestore retention pages stably, resumes, audits before deleting, and is idempotent", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const old = new Date(now.getTime() - 1000);
  await Promise.all(
    ["evt-b", "evt-a", "evt-c"].map((id) => firestore.collection("usageEvents").doc(id).set({
      event_id: id,
      server_received_at: old.toISOString(),
      summary: "must not be copied to audit",
    })),
  );
  const adapter = new FirestoreRetentionAdapter(firestore);
  const service = new FirestoreRetentionCleanupService(adapter, policy());
  const first = await service.run({ runId: "retention-resume", now, dryRun: false, maxPages: 1 });
  assert.equal(first.status, "running");
  assert.equal(first.deleted, 2);
  assert.equal((await firestore.collection("usageEvents").get()).size, 1);
  const audit = await firestore.collection("usageRetentionAudit").get();
  assert.equal(audit.size, 1);
  assert.ok(!JSON.stringify(audit.docs[0].data()).includes("must not be copied"));
  const resumed = await service.run({ runId: "retention-resume", now, dryRun: false });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.deleted, 1);
  assert.equal(resumed.totalDeleted, 3);
  const repeated = await service.run({ runId: "retention-resume", now, dryRun: false });
  assert.equal(repeated.deleted, 0);
  assert.equal(repeated.totalDeleted, 3);
  assert.equal((await firestore.collection("usageEvents").get()).size, 0);
});

test("Firestore retention uses the collection-specific expiry field", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-fields");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const oldTimestamp = new Date(now.getTime() - 1_000);
  await firestore.collection("usageEvents").doc("events-old").set({ server_received_at: oldTimestamp.toISOString() });
  await firestore.collection("deadLetters").doc("dead-old").set({ server_received_at: oldTimestamp.toISOString() });
  await firestore.collection("pluginAuthAudit").doc("audit-old").set({ occurredAt: oldTimestamp });
  await firestore.collection("usageQuotas").doc("quota-old").set({ expires_at: oldTimestamp });
  await firestore.collection("usageOperations").doc("operation-old").set({ pending_terminal: null, updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageReplayApprovals").doc("approval-old").set({ expires_at: oldTimestamp });
  await firestore.collection("usageReplayJobs").doc("replay-job-old").set({ status: "finalized", updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageReplayJobs").doc("replay-job-active").set({ status: "running", updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageRetentionRuns").doc("retention-run-old").set({ status: "completed", updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageRetentionRuns").doc("retention-run-active").set({ status: "running", updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageReplayValidationGroups").doc("validation-old").set({ updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageAggregateSourceRevisions").doc("revision-old").set({ updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageMonitoringCounters").doc("counter-old").set({ expires_at: oldTimestamp });
  await firestore.collection("usageMonitoringSnapshots").doc("snapshot-old").set({ recorded_at: oldTimestamp.toISOString() });
  await firestore.collection("usageMonitoringNotifications").doc("notification-old").set({ created_at: oldTimestamp.toISOString() });
  for (const collection of ["toolUsageDaily", "principalUsageDaily", "errorAggregates"]) {
    await firestore.collection(collection).doc(`${collection}-old`).set({ date: "2026-07-21" });
  }
  const adapter = new FirestoreRetentionAdapter(firestore);
  const expected: Record<string, string> = {
    usageEvents: "events-old",
    deadLetters: "dead-old",
    pluginAuthAudit: "audit-old",
    usageQuotas: "quota-old",
    usageOperations: "operation-old",
    usageReplayApprovals: "approval-old",
    usageReplayJobs: "replay-job-old",
    usageRetentionRuns: "retention-run-old",
    usageReplayValidationGroups: "validation-old",
    usageAggregateSourceRevisions: "revision-old",
    usageMonitoringCounters: "counter-old",
    usageMonitoringSnapshots: "snapshot-old",
    usageMonitoringNotifications: "notification-old",
    toolUsageDaily: "toolUsageDaily-old",
    principalUsageDaily: "principalUsageDaily-old",
    errorAggregates: "errorAggregates-old",
  };
  for (const [collection, id] of Object.entries(expected)) {
    const before = collection === "toolUsageDaily" || collection === "principalUsageDaily" || collection === "errorAggregates"
      ? now.toISOString().slice(0, 10)
      : now;
    const page = await adapter.listExpiredPage(collection as keyof typeof expected, before, 10);
    assert.deepEqual(page.records.map((record) => record.id), [id]);
  }
  assert.deepEqual(
    (await adapter.listExpiredPage("usageReplayJobs", now, 10)).records.map((record) => record.id),
    ["replay-job-old"],
  );
  assert.deepEqual(
    (await adapter.listExpiredPage("usageRetentionRuns", now, 10)).records.map((record) => record.id),
    ["retention-run-old"],
  );
});

test("retention deletes only terminal replay metadata and completed cleanup runs", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-terminal-metadata");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const oldTimestamp = new Date(now.getTime() - 1_000);
  await firestore.collection("usageReplayJobs").doc("terminal-job").set({ status: "failed", updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageReplayJobs").doc("active-job").set({ status: "switched", updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageReplayJobs").doc("rolled-back-job").set({ status: "rolled_back", updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageAggregatePointers").doc("active").set({
    active_generation: "online",
    rollback_generation: "shadow-rolled-back",
    generation_partitions: [],
    updated_at: oldTimestamp.toISOString(),
  });
  await firestore.collection("usageRetentionRuns").doc("completed-run").set({ status: "completed", updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageRetentionRuns").doc("active-run").set({ status: "running", updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageOperations").doc("completed-operation").set({ pending_terminal: null, updated_at: oldTimestamp.toISOString() });
  await firestore.collection("usageOperations").doc("pending-operation").set({
    pending_terminal: { event_id: "evt-pending-retention" },
    updated_at: oldTimestamp.toISOString(),
  });
  const service = new FirestoreRetentionCleanupService(new FirestoreRetentionAdapter(firestore), policy());
  const result = await service.run({ runId: "retention-terminal-metadata", now, dryRun: false, maxPages: 20 });
  assert.equal(result.status, "completed");
  assert.equal((await firestore.collection("usageReplayJobs").doc("terminal-job").get()).exists, false);
  assert.equal((await firestore.collection("usageReplayJobs").doc("active-job").get()).exists, true);
  assert.equal((await firestore.collection("usageReplayJobs").doc("rolled-back-job").get()).exists, true);
  assert.equal((await firestore.collection("usageAggregatePointers").doc("active").get()).exists, true);
  assert.equal((await firestore.collection("usageRetentionRuns").doc("completed-run").get()).exists, false);
  assert.equal((await firestore.collection("usageRetentionRuns").doc("active-run").get()).exists, true);
  assert.equal((await firestore.collection("usageOperations").doc("completed-operation").get()).exists, false);
  assert.equal((await firestore.collection("usageOperations").doc("pending-operation").get()).exists, true);
});

test("retention rechecks terminal-first state inside the deletion transaction", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-operation-race");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  await firestore.collection("usageRetentionRuns").doc("operation-race").set({
    run_id: "operation-race",
    status: "running",
    lease_owner: "retention-worker",
    lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
  });
  await firestore.collection("usageOperations").doc("pending-after-list").set({
    pending_terminal: { event_id: "evt-pending-after-list" },
    updated_at: new Date(now.getTime() - 1_000).toISOString(),
  });
  const adapter = new FirestoreRetentionAdapter(firestore);
  await assert.rejects(
    adapter.deleteBatchIfLeaseHeld({
      collection: "usageOperations",
      ids: ["pending-after-list"],
      runId: "operation-race",
      ownerId: "retention-worker",
      now,
    }),
    /deferred.*pending terminal/i,
  );
  assert.equal((await firestore.collection("usageOperations").doc("pending-after-list").get()).exists, true);
});

test("Firestore retention pins its cutoff and policy across resume", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-pinned");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const pinnedPolicy = { ...policy(), rawEventRetentionMs: 1_000, rebuildWindowMs: 500, lateArrivalAllowanceMs: 500, batchSize: 1 };
  await firestore.collection("usageEvents").doc("old-a").set({ server_received_at: new Date(now.getTime() - 2_000).toISOString() });
  await firestore.collection("usageEvents").doc("old-b").set({ server_received_at: new Date(now.getTime() - 2_000).toISOString() });
  await firestore.collection("usageEvents").doc("after-cutoff").set({ server_received_at: new Date(now.getTime() + 500).toISOString() });
  const service = new FirestoreRetentionCleanupService(new FirestoreRetentionAdapter(firestore), pinnedPolicy);
  await service.run({ runId: "retention-pinned", now, dryRun: false, maxPages: 1 });
  await service.run({ runId: "retention-pinned", now: new Date(now.getTime() + 10_000), dryRun: false });
  assert.equal((await firestore.collection("usageEvents").doc("after-cutoff").get()).exists, true);
  await assert.rejects(
    new FirestoreRetentionCleanupService(new FirestoreRetentionAdapter(firestore), { ...pinnedPolicy, aggregateRetentionMs: 11 })
      .run({ runId: "retention-pinned", now, dryRun: false }),
    /Retention run policy cannot change/,
  );
});

test("scheduled retention fails closed without an explicit policy and supports configured dry-run", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-schedule");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const handler = createScheduledRetentionCleanupHandler({
    firestore,
    clock: () => now,
    readConfig: () => ({ ...policy(), dryRun: true, runId: "scheduled-dry" }),
  });
  const result = await handler();
  assert.equal(result.dryRun, true);
  assert.equal(result.deleted, 0);
  await assert.rejects(
    createScheduledRetentionCleanupHandler({ firestore, readConfig: () => undefined })(),
    /Retention policy configuration is required/,
  );
});

test("scheduled retention resumes an unfinished run before opening a new schedule cycle", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-schedule-resume");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const prefix = "scheduled-retention";
  const jobName = "projects/demo/locations/asia-east1/jobs/retention";
  const firstSchedule = "2026-07-22T02:00:00.000Z";
  const secondSchedule = "2026-07-23T02:00:00.000Z";
  const firstRunId = await resolveScheduledRetentionRunId({
    firestore,
    prefix,
    jobName,
    scheduleTime: firstSchedule,
    now,
  });
  assert.equal(firstRunId, buildScheduledRetentionRunId(prefix, firstSchedule, jobName));
  await firestore.collection("usageRetentionRuns").doc(firstRunId).set({ status: "running" });

  const resumedRunId = await resolveScheduledRetentionRunId({
    firestore,
    prefix,
    jobName,
    scheduleTime: secondSchedule,
    now: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  });
  assert.equal(resumedRunId, firstRunId);

  await firestore.collection("usageRetentionRuns").doc(firstRunId).set({ status: "completed" }, { merge: true });
  const completedRetryId = await resolveScheduledRetentionRunId({
    firestore,
    prefix,
    jobName,
    scheduleTime: firstSchedule,
    now: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  });
  assert.equal(completedRetryId, firstRunId);
  const nextRunId = await resolveScheduledRetentionRunId({
    firestore,
    prefix,
    jobName,
    scheduleTime: secondSchedule,
    now: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  });
  assert.notEqual(nextRunId, firstRunId);
  assert.equal(nextRunId, buildScheduledRetentionRunId(prefix, secondSchedule, jobName));
});

test("scheduled retention reservation expiry permits a later schedule after a missing run", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-schedule-reservation-expiry");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const prefix = "scheduled-retention";
  const jobName = "projects/demo/locations/asia-east1/jobs/retention";
  const firstSchedule = "2026-07-22T02:00:00.000Z";
  const laterSchedule = "2026-07-23T02:00:00.000Z";
  const firstRunId = await resolveScheduledRetentionRunId({
    firestore,
    prefix,
    jobName,
    scheduleTime: firstSchedule,
    now,
  });
  const laterRunId = await resolveScheduledRetentionRunId({
    firestore,
    prefix,
    jobName,
    scheduleTime: laterSchedule,
    now: new Date(now.getTime() + 5 * 60_000 + 1),
  });
  assert.notEqual(laterRunId, firstRunId);
  assert.equal(laterRunId, buildScheduledRetentionRunId(prefix, laterSchedule, jobName));
  const pointer = await firestore.collection("usageRetentionSchedules").get();
  assert.equal(pointer.size, 1);
  assert.equal(pointer.docs[0].data()?.active_run_id, laterRunId);
});

test("scheduled retention uses the injected clock for lease timestamps", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-schedule-clock");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const scheduledNow = new Date("2001-01-01T00:00:00.000Z");
  const handler = createScheduledRetentionCleanupHandler({
    firestore,
    clock: () => scheduledNow,
    readConfig: () => ({ ...policy(), dryRun: true, runId: "scheduled-clock" }),
  });
  const result = await handler();
  assert.equal(result.status, "completed");
  const run = await firestore.collection("usageRetentionRuns").doc("scheduled-clock").get();
  assert.equal(run.data()?.updated_at, scheduledNow.toISOString());
  assert.equal(run.data()?.lease_owner, null);
});

test("retention advances lease fencing time while preserving its fixed cutoff", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-advancing-clock");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const cutoffNow = new Date("2026-07-22T04:00:00.000Z");
  await firestore.collection("usageEvents").doc("before-cutoff").set({
    server_received_at: new Date(cutoffNow.getTime() - 1_000).toISOString(),
  });
  await firestore.collection("usageEvents").doc("after-cutoff").set({
    server_received_at: cutoffNow.toISOString(),
  });
  let clockCalls = 0;
  const handler = createScheduledRetentionCleanupHandler({
    firestore,
    clock: () => new Date(cutoffNow.getTime() + clockCalls++ * 30_000),
    readConfig: () => ({
      ...policy(),
      dryRun: false,
      runId: "scheduled-advancing-clock",
      leaseMs: 300_000,
    }),
  });

  const result = await handler();
  assert.equal(result.status, "completed");
  assert.equal((await firestore.collection("usageEvents").doc("before-cutoff").get()).exists, false);
  assert.equal((await firestore.collection("usageEvents").doc("after-cutoff").get()).exists, true);
  const run = await firestore.collection("usageRetentionRuns").doc("scheduled-advancing-clock").get();
  assert.equal(run.data()?.cutoff_at, cutoffNow.toISOString());
  const lock = await firestore.collection("usageReplayLocks").doc("aggregate-rebuild").get();
  assert.ok(Date.parse(String(lock.data()?.acquired_at)) > cutoffNow.getTime());
});

test("retention run lease blocks concurrent resume and resumes a bounded checkpoint", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-lease");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const cutoff = new Date(now.getTime() - 1_000).toISOString();
  await firestore.collection("usageEvents").doc("lease-old-a").set({ server_received_at: cutoff });
  await firestore.collection("usageEvents").doc("lease-old-b").set({ server_received_at: cutoff });
  const service = new FirestoreRetentionCleanupService(new FirestoreRetentionAdapter(firestore), { ...policy(), batchSize: 1 });
  const first = await service.run({ runId: "retention-lease", now, dryRun: false, maxPages: 1, ownerId: "owner-a" });
  assert.equal(first.status, "running");
  const saved = await firestore.collection("usageRetentionRuns").doc("retention-lease").get();
  assert.equal(saved.data()?.lease_owner, null);
  await firestore.collection("usageRetentionRuns").doc("retention-lease").set({
    lease_owner: "owner-other",
    lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
  }, { merge: true });
  await assert.rejects(service.run({ runId: "retention-lease", now, dryRun: false, ownerId: "owner-a" }), /locked/);
  const resumed = await service.run({ runId: "retention-lease", now: new Date(now.getTime() + 61_000), dryRun: false, ownerId: "owner-b" });
  assert.equal(resumed.status, "completed");
  assert.equal((await firestore.collection("usageEvents").get()).size, 0);
});

test("retention rechecks run ownership after page selection before deleting", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-owner-fence");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  await firestore.collection("usageEvents").doc("owner-fenced").set({
    event_id: "owner-fenced",
    server_received_at: new Date(now.getTime() - 1_000).toISOString(),
  });

  class OwnershipStolenAfterAuditAdapter extends FirestoreRetentionAdapter {
    public override async writePageAudit(input: Parameters<FirestoreRetentionAdapter["writePageAudit"]>[0]): Promise<void> {
      await super.writePageAudit(input);
      if (input.collection === "usageEvents") {
        await firestore.collection("usageRetentionRuns").doc(input.runId).set({
          lease_owner: "owner-b",
          lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
        }, { merge: true });
      }
    }
  }

  const service = new FirestoreRetentionCleanupService(
    new OwnershipStolenAfterAuditAdapter(firestore),
    policy(),
    () => now,
  );
  await assert.rejects(
    service.run({
      runId: "retention-owner-fence",
      now,
      dryRun: false,
      ownerId: "owner-a",
      leaseMs: 60_000,
    }),
    /lease.*lost|locked/i,
  );
  assert.equal((await firestore.collection("usageEvents").doc("owner-fenced").get()).exists, true);
});

test("raw event retention defers while an overlapping replay is running", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-replay-lock");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  await firestore.collection("usageEvents").doc("replay-protected").set({ server_received_at: new Date(now.getTime() - 1_000).toISOString() });
  await firestore.collection("usageReplayJobs").doc("replay-active").set({
    replay_id: "replay-active",
    status: "running",
    from: new Date(now.getTime() - 2_000).toISOString(),
    to: new Date(now.getTime() + 2_000).toISOString(),
  });
  const service = new FirestoreRetentionCleanupService(new FirestoreRetentionAdapter(firestore), policy());
  await assert.rejects(service.run({ runId: "retention-replay-protected", now, dryRun: false }), /replay is active/);
  assert.equal((await firestore.collection("usageEvents").doc("replay-protected").get()).exists, true);
});

test("raw event deletion rechecks replay state atomically after page selection", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-retention-replay-race");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  await firestore.collection("usageEvents").doc("race-protected").set({
    event_id: "race-protected",
    server_received_at: new Date(now.getTime() - 1_000).toISOString(),
  });

  class ReplayStartsAfterListingAdapter extends FirestoreRetentionAdapter {
    public override async writePageAudit(input: Parameters<FirestoreRetentionAdapter["writePageAudit"]>[0]): Promise<void> {
      await super.writePageAudit(input);
      if (input.collection === "usageEvents") {
        await firestore.collection("usageReplayJobs").doc("replay-raced").set({
          replay_id: "replay-raced",
          status: "running",
          from: new Date(now.getTime() - 2_000).toISOString(),
          to: new Date(now.getTime() + 2_000).toISOString(),
        });
      }
    }
  }

  const service = new FirestoreRetentionCleanupService(new ReplayStartsAfterListingAdapter(firestore), policy());
  await assert.rejects(
    service.run({ runId: "retention-replay-race", now, dryRun: false }),
    /replay is active/,
  );
  assert.equal((await firestore.collection("usageEvents").doc("race-protected").get()).exists, true);
});

test("monitoring persists counters and snapshots, deduplicates active alerts, and records recovery", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-monitoring");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const service = new FirestoreMonitoringService(firestore);
  await service.incrementCounter("accepted_events", 2, now);
  await service.incrementCounter("accepted_events", 3, now);
  const thresholds = {
    aggregateDriftRatio: 0.01,
    permanentRejectRate: 0.05,
    authFailureRate: 0.1,
    leaseRenewFailureRate: 0.1,
    deadLetterGrowthPerHour: 10,
    writesPerAcceptedEvent: 4,
    owner: "art-tools-oncall",
  };
  const metrics = {
    aggregateDriftRatio: 0.2,
    permanentRejectRate: 0,
    authFailureRate: 0,
    leaseRenewFailureRate: 0,
    deadLetterGrowthPerHour: 0,
    writesPerAcceptedEvent: 0,
  };
  await service.evaluateAndPersist({ metrics, thresholds, now, snapshotId: "snapshot-1" });
  await service.evaluateAndPersist({ metrics, thresholds, now: new Date(now.getTime() + 1000), snapshotId: "snapshot-2" });
  const active = await firestore.collection("usageMonitoringAlerts").doc("aggregate_drift").get();
  assert.equal(active.data()?.status, "active");
  assert.equal(active.data()?.occurrences, 2);
  assert.equal((await firestore.collection("usageMonitoringAlerts").get()).size, 1);
  await service.evaluateAndPersist({
    metrics: { ...metrics, aggregateDriftRatio: 0 },
    thresholds,
    now: new Date(now.getTime() + 2000),
    snapshotId: "snapshot-3",
  });
  const recovered = await firestore.collection("usageMonitoringAlerts").doc("aggregate_drift").get();
  assert.equal(recovered.data()?.status, "recovered");
  const counterBuckets = await firestore.collection("usageMonitoringCounters").where("name", "==", "accepted_events").get();
  assert.equal(counterBuckets.docs.reduce((total, document) => total + Number(document.data().value ?? 0), 0), 5);
  assert.equal((await firestore.collection("usageMonitoringSnapshots").get()).size, 3);
});

function thresholds() {
  return {
    aggregateDriftRatio: 0.01,
    permanentRejectRate: 0.05,
    authFailureRate: 0.1,
    leaseRenewFailureRate: 0.1,
    deadLetterGrowthPerHour: 10,
    writesPerAcceptedEvent: 4,
    owner: "art-tools-oncall",
  };
}

test("scheduled monitoring derives metrics from Firestore counters instead of configuration", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-monitoring-schedule");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const service = new FirestoreMonitoringService(firestore);
  const config = { thresholds: thresholds(), snapshotId: "scheduled-monitor", windowMs: 60 * 60 * 1000 };
  const firstHandler = createScheduledUsageMonitoringHandler({
    firestore,
    clock: () => now,
    readConfig: () => config,
  });
  assert.equal((await firstHandler()).alerts.length, 0);
  await service.incrementCounter("ingestion_requests", 10, now);
  await service.incrementCounter("auth_failures", 3, now);
  const secondHandler = createScheduledUsageMonitoringHandler({
    firestore,
    clock: () => new Date(now.getTime() + 1000),
    readConfig: () => ({ ...config, snapshotId: "scheduled-monitor-2" }),
  });
  assert.ok((await secondHandler()).alerts.some((alert) => alert.code === "auth_failure_rate"));
  const snapshot = await firestore.collection("usageMonitoringSnapshots").doc("scheduled-monitor-2").get();
  assert.equal(snapshot.data()?.metrics.authFailureRate, 0.3);

  await assert.rejects(
    createScheduledUsageMonitoringHandler({
      firestore,
      readConfig: () => ({ ...config, metrics: { authFailureRate: 0 } } as never),
    })(),
    /metrics.*configuration|configuration.*metrics/i,
  );
  await assert.rejects(
    createScheduledUsageMonitoringHandler({ firestore, readConfig: () => undefined })(),
    /Monitoring configuration is required/,
  );
});

test("aggregate drift is derived from persisted replay validation rather than mirrored ingestion counters", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-monitoring-replay-validation");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  await firestore.collection("usageMonitoringCounters").doc("mirrored-expected").set({
    name: "aggregate_expected",
    value: 100,
    bucket_start: now,
    expires_at: new Date(now.getTime() + 60_000),
  });
  await firestore.collection("usageMonitoringCounters").doc("mirrored-observed").set({
    name: "aggregate_observed",
    value: 100,
    bucket_start: now,
    expires_at: new Date(now.getTime() + 60_000),
  });
  await firestore.collection("usageReplayJobs").doc("replay-drifted").set({
    replay_id: "replay-drifted",
    status: "running",
    validation: {
      matched: false,
      source: { event_count: 10 },
      shadow: { event_count: 8 },
      validated_at: now.toISOString(),
    },
    validation_recorded_at: now,
  });

  const metrics = await new FirestoreMonitoringService(firestore).deriveMetrics({ now, windowMs: 60 * 60 * 1000 });
  assert.equal(metrics.aggregateDriftRatio, 0.2);
});

test("aggregate drift detects validation digest changes when event counts match", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-monitoring-replay-digest");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  await firestore.collection("usageReplayJobs").doc("replay-digest-drift").set({
    replay_id: "replay-digest-drift",
    status: "failed",
    validation: {
      matched: false,
      source: { event_count: 1000, group_count: 1, group_digest: "source-digest" },
      shadow: { event_count: 1000, group_count: 1, group_digest: "shadow-digest" },
      validated_at: now.toISOString(),
    },
  });
  const metrics = await new FirestoreMonitoringService(firestore).deriveMetrics({ now, windowMs: 60 * 60 * 1000 });
  assert.equal(metrics.aggregateDriftRatio, 1);
});

test("monitoring routes persist an alert notification outbox", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-monitoring-routes");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const handler = createScheduledUsageMonitoringHandler({
    firestore,
    clock: () => now,
    readConfig: () => ({ thresholds: thresholds(), snapshotId: "route-snapshot", routes: ["oncall", "metrics"] }),
  });
  await new FirestoreMonitoringService(firestore).incrementCounter("accepted_events", 1, now);
  await new FirestoreMonitoringService(firestore).incrementCounter("auth_failures", 1, now);
  const result = await handler();
  assert.ok(result.alerts.some((alert) => alert.code === "auth_failure_rate"));
  const notifications = await firestore.collection("usageMonitoringNotifications").get();
  assert.equal(notifications.size, 2);
  assert.deepEqual(notifications.docs.map((document) => document.data().route).sort(), ["metrics", "oncall"]);
});

test("usage endpoint authentication denial increments the counter consumed by scheduled monitoring", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  const firebaseApp = app("usage-auth-monitoring");
  const firestore = getFirestore(firebaseApp);
  suite.after(async () => {
    await clean(firestore);
    await deleteApp(firebaseApp);
  });
  await clean(firestore);
  const monitoring = new FirestoreMonitoringService(firestore);
  const handler = createUsageIngestionEndpointHandler({
    async ingestBatch() {
      throw new PluginAuthError("AUTH_DOMAIN_MISMATCH", "Portal sessions are not accepted by plugin endpoints");
    },
  } as never, { monitoring, clock: () => now });
  let status = 0;
  await handler({
    method: "POST",
    protocol: "https",
    headers: { authorization: "Bearer portal-firebase-token" },
    ip: "127.0.0.1",
    rawBody: Buffer.from("{}"),
    body: { queue_binding_id: "binding", lease_token: "lease", events: [] },
    get: (name: string) => name.toLowerCase() === "authorization" ? "Bearer portal-firebase-token" : undefined,
    is: (name: string) => name === "application/json",
  } as never, {
    set() { return this; },
    status(value: number) { status = value; return this; },
    json() { return this; },
  } as never);
  assert.equal(status, 401);

  const result = await createScheduledUsageMonitoringHandler({
    firestore,
    clock: () => new Date(now.getTime() + 1000),
    readConfig: () => ({ thresholds: { ...thresholds(), authFailureRate: 0 }, snapshotId: "auth-denial", windowMs: 60 * 60 * 1000 }),
  })();
  assert.ok(result.alerts.some((alert) => alert.code === "auth_failure_rate"));
  const snapshot = await firestore.collection("usageMonitoringSnapshots").doc("auth-denial").get();
  assert.equal(snapshot.data()?.metrics.authFailureRate, 1);
  assert.equal((await firestore.collection("pluginAuthAudit").get()).size, 0);
});
