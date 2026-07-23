import assert from "node:assert/strict";
import test from "node:test";

import { errorFingerprint, redactSummary } from "../src/usage/redaction";
import { correctObservedTime } from "../src/usage/validation";
import { TokenBucketRateLimiter } from "../src/usage/rate-limit";
import { RetentionCleanupService } from "../src/usage/retention";
import { evaluateUsageMonitoring } from "../src/usage/monitoring";
import { ReplayService } from "../src/usage/replay";
import { deriveOperationDisplayState } from "../src/usage/operation-display";
import type { OperationState, StoredUsageEvent } from "../src/usage/types";

const at = new Date("2026-07-22T04:00:00.000Z");

function stored(eventId: string, receivedAt: string, type: StoredUsageEvent["event_type"] = "run_started"): StoredUsageEvent {
  return {
    schema_version: "1.0.0",
    registry_version: "1.0.0",
    event_id: eventId,
    binding_id: "binding-a",
    plugin_principal_id: "principal-a",
    tool_key: "asset.export",
    action_key: "export",
    event_type: type,
    client_observed_at: receivedAt,
    server_received_at: receivedAt,
    plugin_version: "1.0.0",
    ue_version: "4.26",
    ui_version: "1.0.0",
    process_instance_id: "process-a",
    session_id: "session-a",
    operation_id: eventId,
    time_correction: {
      applied: false,
      corrected_observed_at: receivedAt,
      clock_offset_ms: 0,
      reason: "within_tolerance",
    },
  };
}

test("time policy corrects bounded skew and permanently rejects hard-range skew", () => {
  const ahead = correctObservedTime("2026-07-22T05:00:01.000Z", at);
  assert.equal("ok" in ahead, false);
  if (!("ok" in ahead)) {
    assert.equal(ahead.reason, "client_clock_ahead");
    assert.equal(ahead.applied, true);
  }
  const behind = correctObservedTime("2026-06-20T04:00:00.000Z", at);
  assert.equal("ok" in behind, true);
  if ("ok" in behind) assert.equal(behind.code, "client_time_out_of_range");
});

test("server redaction removes credentials, paths and accounts before fingerprinting", () => {
  const input = "Authorization: Bearer secret C:\\Users\\artist\\asset.uasset user@xindong.com";
  const output = redactSummary(input);
  assert.doesNotMatch(output, /secret|C:\\Users|artist\\asset|user@xindong/);
  assert.equal(errorFingerprint("internal", input, "usage.ingest"), errorFingerprint("internal", "Authorization: Bearer another C:\\Users\\other\\asset.uasset foo@xindong.com", "usage.ingest"));
});

test("server redaction removes bare JWT credentials and standalone stack frames", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhcnRpc3QtMTIzIn0.invalid_signature_123456";
  const output = redactSummary(`Request failed with ${jwt}; File \"tool.py\", line 42, in run`);
  assert.equal(output, "Request failed with <credential>; <stack>");
  assert.doesNotMatch(output, /eyJ|tool\.py|line 42/);
});

test("fingerprints normalize asset identities and include the bounded producer call site", () => {
  const fingerprint = errorFingerprint as unknown as (
    category: string,
    summary: string,
    callSite: string,
  ) => string;
  const first = fingerprint("ue_runtime", "Failed to load SM_Chair_001", "asset_loader.load");
  const second = fingerprint("ue_runtime", "Failed to load SM_Table_999", "asset_loader.load");
  const differentCallSite = fingerprint("ue_runtime", "Failed to load SM_Table_999", "asset_loader.resolve");

  assert.equal(first, second);
  assert.notEqual(first, differentCallSite);
  assert.equal(redactSummary("Failed to load SM_Chair_001"), "Failed to load <asset>");
});

test("token bucket rejects overload with a bounded retry recommendation", () => {
  const limiter = new TokenBucketRateLimiter({ capacity: 2, refillPerSecond: 0 });
  assert.equal(limiter.check("principal-a", 2, 1000).allowed, true);
  const blocked = limiter.check("principal-a", 1, 1000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
});

test("operation display derives abandonment after 24 hours and a later interruption supersedes it", () => {
  const operation: OperationState = {
    id: "principal-a|binding-a|operation-a",
    plugin_principal_id: "principal-a",
    binding_id: "binding-a",
    operation_id: "operation-a",
    tool_key: "asset.export",
    action_key: "export",
    session_id: "session-a",
    started_event_id: "evt-start",
    started_at: "2026-07-21T04:00:00.000Z",
    pending_terminal: null,
    terminal_event_id: null,
    terminal_event_type: null,
    terminal_at: null,
    updated_at: "2026-07-21T04:00:00.000Z",
  };
  assert.equal(deriveOperationDisplayState(operation, new Date("2026-07-22T03:59:59.999Z")), "running");
  assert.equal(deriveOperationDisplayState(operation, new Date("2026-07-22T04:00:00.000Z")), "abandoned");
  assert.equal(deriveOperationDisplayState({
    ...operation,
    terminal_event_id: "evt-interrupted",
    terminal_event_type: "run_interrupted",
    terminal_at: "2026-07-22T04:01:00.000Z",
  }, new Date("2026-07-22T04:01:00.000Z")), "interrupted");
});

test("retention cleanup is dry-run/audited and enforces rebuild-window preservation", async () => {
  const audits: Array<{ dryRun: boolean; ids: string[] }> = [];
  const deleted: string[] = [];
  const adapter = {
    async listExpired(collection: string) {
      return [{ id: `${collection}-1`, collection, occurredAt: new Date(0) }] as never;
    },
    async deleteBatch(_collection: string, ids: string[]) { deleted.push(...ids); },
    async writeAudit(record: { dryRun: boolean; ids: string[] }) { audits.push(record); },
  };
  const service = new RetentionCleanupService(adapter, {
    rawEventRetentionMs: 11,
    deadLetterRetentionMs: 1,
    authAuditRetentionMs: 1,
    aggregateRetentionMs: 1,
    quotaRetentionMs: 1,
    operationRetentionMs: 1,
    replayMetadataRetentionMs: 1,
    retentionRunRetentionMs: 1,
    monitoringRetentionMs: 1,
    rebuildWindowMs: 10,
    lateArrivalAllowanceMs: 1,
    batchSize: 10,
  });
  const dry = await service.run({ runId: "ret-1", now: at, dryRun: true });
  assert.equal(dry.deleted, 0);
  assert.equal(deleted.length, 0);
  assert.ok(audits.every((record) => record.dryRun));
  await service.run({ runId: "ret-2", now: at, dryRun: false });
  assert.ok(deleted.length > 0);
});

test("monitoring surfaces owner-bound alerts for drift, rejects, auth and cost", () => {
  const alerts = evaluateUsageMonitoring(
    { aggregateDriftRatio: 0.2, permanentRejectRate: 0.3, authFailureRate: 0, leaseRenewFailureRate: 0, deadLetterGrowthPerHour: 0, writesPerAcceptedEvent: 8 },
    { aggregateDriftRatio: 0.01, permanentRejectRate: 0.05, authFailureRate: 0.1, leaseRenewFailureRate: 0.1, deadLetterGrowthPerHour: 10, writesPerAcceptedEvent: 4, owner: "art-tools-oncall" },
  );
  assert.deepEqual(alerts.map((alert) => alert.code), ["aggregate_drift", "permanent_reject_rate", "write_cost"]);
  assert.ok(alerts.every((alert) => alert.owner === "art-tools-oncall"));
});

test("replay uses stable timestamp/event watermark and switches generations without duplicate counts", async () => {
  const sourceEvents = [stored("evt-1", "2026-07-22T04:00:00.000Z"), stored("evt-2", "2026-07-22T04:00:00.000Z")];
  let reads = 0;
  const replay = new ReplayService({
    async listEvents() {
      reads += 1;
      return reads === 1 ? sourceEvents : [...sourceEvents, stored("evt-3", "2026-07-22T04:00:01.000Z")];
    },
  });
  const result = await replay.rebuild({ replayId: "replay-1", generation: "shadow-1", from: new Date("2026-07-22T00:00:00.000Z"), to: new Date("2026-07-23T00:00:00.000Z"), now: at });
  assert.equal(result.status, "switched");
  assert.equal(result.watermark?.event_id, "evt-2");
  assert.equal(result.late_arrivals, 1);
  assert.equal(result.shadow_count, 3);
  assert.equal(replay.activeGeneration, "shadow-1");
  assert.deepEqual(replay.getReplayAudit("replay-1").map((record) => record.action), ["started", "checkpointed", "switched"]);
});

test("replay rebuild preserves bounded distinct principals on error aggregates", async () => {
  const fingerprint = errorFingerprint("internal", "Replay failure", "usage.replay");
  const sourceEvents = Array.from({ length: 102 }, (_, index) => ({
    ...stored(`evt-error-${String(index).padStart(3, "0")}`, "2026-07-22T04:00:00.000Z", "run_failed"),
    plugin_principal_id: `principal-${String(index).padStart(3, "0")}`,
    error: { error_category: "internal" as const, summary: "Replay failure", call_site: "usage.replay", fingerprint },
  }));
  sourceEvents.push({
    ...stored("evt-error-duplicate", "2026-07-22T04:00:00.000Z", "run_failed"),
    plugin_principal_id: "principal-050",
    error: { error_category: "internal", summary: "Replay failure", call_site: "usage.replay", fingerprint },
  });
  const replay = new ReplayService({ async listEvents() { return sourceEvents; } });

  await replay.rebuild({ replayId: "replay-errors", generation: "shadow-errors", from: new Date("2026-07-22T00:00:00.000Z"), to: new Date("2026-07-23T00:00:00.000Z"), now: at });

  const aggregate = [...(replay.getGeneration("shadow-errors")?.errors.values() ?? [])][0];
  const expectedPrincipals = Array.from({ length: 100 }, (_, index) => `principal-${String(index).padStart(3, "0")}`);
  assert.equal(aggregate.count, 103);
  assert.deepEqual(aggregate.principal_ids, expectedPrincipals);
  assert.equal(new Set(aggregate.principal_ids).size, 100);
});

test("replay rebuild creates independent error aggregates for each plugin version", async () => {
  const fingerprint = errorFingerprint("internal", "Replay version failure", "usage.replay");
  const sourceEvents = [
    {
      ...stored("evt-error-v1", "2026-07-22T04:00:00.000Z", "run_failed"),
      plugin_version: "1.0.0",
      error: { error_category: "internal" as const, summary: "Replay version failure", call_site: "usage.replay", fingerprint },
    },
    {
      ...stored("evt-error-v2", "2026-07-22T04:01:00.000Z", "run_failed"),
      plugin_version: "2.0.0",
      error: { error_category: "internal" as const, summary: "Replay version failure", call_site: "usage.replay", fingerprint },
    },
  ];
  const replay = new ReplayService({ async listEvents() { return sourceEvents; } });

  await replay.rebuild({ replayId: "replay-error-versions", generation: "shadow-error-versions", from: new Date("2026-07-22T00:00:00.000Z"), to: new Date("2026-07-23T00:00:00.000Z"), now: at });

  const aggregates = [...(replay.getGeneration("shadow-error-versions")?.errors.values() ?? [])]
    .map((aggregate) => ({
      plugin_version: (aggregate as typeof aggregate & { plugin_version?: string }).plugin_version,
      count: aggregate.count,
      affected_versions: aggregate.affected_versions,
    }))
    .sort((left, right) => String(left.plugin_version).localeCompare(String(right.plugin_version)));
  assert.deepEqual(aggregates, [
    { plugin_version: "1.0.0", count: 1, affected_versions: ["1.0.0"] },
    { plugin_version: "2.0.0", count: 1, affected_versions: ["2.0.0"] },
  ]);
});
