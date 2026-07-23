import assert from "node:assert/strict";
import test from "node:test";

import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { FirestoreUsageStore } from "../src/usage/store";
import { UsageIngestionService } from "../src/usage/ingestion";
import { errorFingerprint } from "../src/usage/redaction";
import { ReplayService } from "../src/usage/replay";
import { FirestoreRetentionAdapter, FirestoreRetentionCleanupService } from "../src/usage/retention-firestore";
import type { ToolRegistry } from "../src/usage/types";

const projectId = "demo-tl-art-tool-usage-analytics-ingestion";
const receivedAt = new Date("2026-07-22T04:00:00.000Z");
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

function event(eventId: string, eventType: "run_started" | "run_succeeded" | "run_failed", duration?: number, operationId = "operation-emulator") {
  return {
    schema_version: "1.0.0",
    registry_version: "1.0.0",
    event_id: eventId,
    binding_id: "binding-emulator",
    tool_key: "asset.export",
    action_key: "export",
    event_type: eventType,
    client_observed_at: receivedAt.toISOString(),
    plugin_version: "1.0.0",
    ue_version: "4.26",
    ui_version: "1.0.0",
    process_instance_id: "process-emulator",
    session_id: "session-emulator",
    operation_id: operationId,
    ...(eventType === "run_failed" ? { error: { error_category: "internal", summary: "Safe failure", call_site: "usage_emulator.event", fingerprint: errorFingerprint("internal", "Safe failure", "usage_emulator.event") } } : {}),
    ...(duration === undefined ? {} : { duration_ms: duration }),
  };
}

test("Firestore usage ingestion transaction, idempotency, aggregation and replay", async (suite) => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must be provided by firebase emulators:exec");
  const app = initializeApp({ projectId }, `usage-emulator-${Date.now()}`);
  const firestore = getFirestore(app);
  const collections = ["usageEvents", "usageEventReservations", "toolUsageDaily", "principalUsageDaily", "errorAggregates", "deadLetters", "usageOperations", "usageAggregatePointers", "usageRetentionRuns", "usageRetentionAudit"];
  suite.after(async () => {
    await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
    await deleteApp(app);
  });
  await Promise.all(collections.map((name) => firestore.recursiveDelete(firestore.collection(name))));
  const service = new UsageIngestionService({
    auth: {
      async authorizeEvent() {
        return { bindingId: "binding-emulator", pluginPrincipalId: "principal-emulator", expiresAtSeconds: Math.floor(Date.now() / 1000) + 3600 };
      },
    },
    store: new FirestoreUsageStore(firestore),
    clock: { now: () => new Date(receivedAt) },
    registry,
  });

  const events = [
    event("evt-emulator-start", "run_started"),
    event("evt-emulator-terminal-first", "run_succeeded", 120, "operation-terminal-first"),
    event("evt-emulator-terminal-start", "run_started", undefined, "operation-terminal-first"),
    event("evt-emulator-failed-start", "run_started", undefined, "operation-emulator-failed"),
    event("evt-emulator-failed", "run_failed", undefined, "operation-emulator-failed"),
  ];
  const first = await service.ingestBatch({ queue_binding_id: "binding-emulator", lease_token: "fixture-lease", events });
  const retry = await service.ingestBatch({ queue_binding_id: "binding-emulator", lease_token: "fixture-lease", events });
  assert.deepEqual(first.results.map((item) => item.status), ["confirmed", "confirmed", "confirmed", "confirmed", "confirmed"]);
  assert.deepEqual(retry.results.map((item) => item.code), ["duplicate", "duplicate", "duplicate", "duplicate", "duplicate"]);

  const raw = await firestore.collection("usageEvents").get();
  const daily = await firestore.collection("toolUsageDaily").get();
  const principal = await firestore.collection("principalUsageDaily").get();
  const errors = await firestore.collection("errorAggregates").get();
  assert.equal(raw.size, 5);
  assert.equal(daily.size, 1);
  assert.equal(principal.size, 1);
  assert.equal(daily.docs[0].data().run_started, 3);
  assert.equal(daily.docs[0].data().run_succeeded, 1);
  assert.equal(daily.docs[0].data().run_failed, 1);
  assert.equal(daily.docs[0].data().duration_total_ms, 120);
  assert.equal(errors.size, 1);

  const replay = new ReplayService({
    async listEvents() {
      const snapshot = await firestore.collection("usageEvents").get();
      return snapshot.docs.map((document) => document.data()) as never;
    },
  });
  const rebuilt = await replay.rebuild({ replayId: "replay-emulator", generation: "shadow-emulator", from: new Date("2026-07-22T00:00:00.000Z"), to: new Date("2026-07-23T00:00:00.000Z"), now: receivedAt });
  assert.equal(rebuilt.source_count, 5);
  assert.equal(rebuilt.shadow_count, 5);
  assert.equal(rebuilt.comparison.run_started, 3);
  assert.equal(rebuilt.comparison.error_count, 1);
  assert.equal(replay.activeGeneration, "shadow-emulator");

  const retention = new FirestoreRetentionCleanupService(new FirestoreRetentionAdapter(firestore), {
    rawEventRetentionMs: 1,
    deadLetterRetentionMs: 1,
    authAuditRetentionMs: 1,
    aggregateRetentionMs: 1,
    quotaRetentionMs: 1,
    operationRetentionMs: 1,
    replayMetadataRetentionMs: 1,
    retentionRunRetentionMs: 1,
    monitoringRetentionMs: 1,
    rebuildWindowMs: 0,
    lateArrivalAllowanceMs: 0,
    batchSize: 10,
  });
  const cleanup = await retention.run({ runId: "ingestion-retention", now: new Date(receivedAt.getTime() + 2_000), dryRun: false });
  assert.equal(cleanup.status, "completed");
  assert.equal((await firestore.collection("usageEvents").get()).size, 0);
});
