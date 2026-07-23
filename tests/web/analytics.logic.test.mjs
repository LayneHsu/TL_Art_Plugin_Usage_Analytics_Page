import assert from "node:assert/strict";
import test from "node:test";

const { aggregateUsage, companyDateFromTimestamp, dedupeEvents } = await import("../../web/src/portal/analytics.ts");

const filter = { dateFrom: "2026-07-23", dateTo: "2026-07-23" };

function event(overrides = {}) {
  return {
    event_id: "evt-1",
    operation_id: "op-1",
    tool_key: "asset.image_exporter",
    action_key: "asset.image_exporter.run",
    event_type: "run_started",
    occurred_at: "2026-07-22T16:30:00.000Z",
    result: "started",
    plugin_version: "8.0.0",
    ...overrides,
  };
}

test("analytics uses the Asia/Shanghai company date at UTC day boundaries", () => {
  assert.equal(companyDateFromTimestamp("2026-07-22T16:30:00.000Z"), "2026-07-23");
  assert.equal(companyDateFromTimestamp("not-a-timestamp"), "");
  const analytics = aggregateUsage([
    {
      company_date: "2026-07-23", uid: "user-a", tool_key: "asset.image_exporter", shard: "01",
      events: [event(), event({ event_id: "evt-2", event_type: "run_succeeded", result: "succeeded", duration_ms: 100, occurred_at: "2026-07-22T16:30:01.000Z" })],
      first_occurred_at: "2026-07-22T16:30:00.000Z", last_occurred_at: "2026-07-22T16:30:01.000Z", last_result: "succeeded", plugin_version: "8.0.0",
    },
  ], [{ uid: "user-a", email: "a@xindong.com", display_name: "A", avatar_url: "", last_login_at: "", last_active_at: "", plugin_version: "8.0.0", updated_at: "" }], filter);
  assert.equal(analytics.total, 1);
  assert.equal(analytics.dailyTrend[0].date, "2026-07-23");
  assert.equal(analytics.events[0].result, "succeeded");
});

test("unexpected exceptions do not replace a real operation terminal state", () => {
  const started = event({ event_id: "start", operation_id: "operation" });
  const succeeded = event({
    event_id: "succeeded",
    operation_id: "operation",
    event_type: "run_succeeded",
    result: "succeeded",
    duration_ms: 100,
    occurred_at: "2026-07-23T01:00:01.000Z",
  });
  const unexpected = event({
    event_id: "unexpected",
    operation_id: "operation",
    event_type: "unexpected_exception",
    result: "unexpected",
    occurred_at: "2026-07-23T01:00:02.000Z",
  });
  const analytics = aggregateUsage([
    {
      company_date: "2026-07-23", uid: "uid-a", tool_key: started.tool_key, shard: "01",
      events: [started, succeeded, unexpected],
    },
  ], [], { dateFrom: "2026-07-23", dateTo: "2026-07-23" });

  assert.equal(analytics.events[0].result, "succeeded");
  assert.equal(analytics.events[0].duration_ms, 100);
});

test("dedupe and terminal correlation are scoped to the Firebase UID", () => {
  const first = { ...event(), event_id: "same-event", operation_id: "same-operation" };
  const second = { ...event(), event_id: "same-event", operation_id: "same-operation" };
  const terminalA = { ...event({ event_id: "terminal-a", event_type: "run_failed", result: "failed", duration_ms: 1 }), operation_id: "same-operation" };
  const terminalB = { ...event({ event_id: "terminal-b", event_type: "run_succeeded", result: "succeeded", duration_ms: 2 }), operation_id: "same-operation" };
  const shards = [
    { uid: "user-a", tool_key: first.tool_key, events: [first, terminalA] },
    { uid: "user-a", tool_key: first.tool_key, events: [first] },
    { uid: "user-b", tool_key: second.tool_key, events: [second, terminalB] },
  ];
  assert.equal(dedupeEvents(shards).length, 4);
  const analytics = aggregateUsage(shards, [], { dateFrom: "2026-07-22", dateTo: "2026-07-23" });
  assert.equal(analytics.total, 2);
  assert.deepEqual(analytics.events.map((item) => [item.uid, item.result]).sort(), [["user-a", "failed"], ["user-b", "succeeded"]]);
});
