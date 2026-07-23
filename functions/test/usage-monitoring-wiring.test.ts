import assert from "node:assert/strict";
import test from "node:test";

import { createUsageIngestionEndpointHandler } from "../src/usage/endpoints";

test("ingestion monitoring does not mirror accepted events into both sides of aggregate drift", async () => {
  const counters: Array<{ name: string; delta: number }> = [];
  const handler = createUsageIngestionEndpointHandler({
    async ingestBatch() {
      return {
        results: [
          { event_id: "evt-a", status: "confirmed" },
          { event_id: "evt-b", status: "confirmed" },
        ],
        accepted: 2,
        duplicates: 0,
        retryable: 0,
        permanent_rejected: 0,
      };
    },
  } as never, {
    monitoring: {
      async incrementCounter(name: string, delta: number) {
        counters.push({ name, delta });
        return delta;
      },
    } as never,
    clock: () => new Date("2026-07-22T04:00:00.000Z"),
  });
  let status = 0;
  await handler({
    method: "POST",
    protocol: "https",
    headers: {},
    ip: "127.0.0.1",
    rawBody: Buffer.from("{}"),
    body: { queue_binding_id: "binding", lease_token: "lease", events: [] },
    get: () => undefined,
    is: (name: string) => name === "application/json",
  } as never, {
    set() { return this; },
    status(value: number) { status = value; return this; },
    json() { return this; },
  } as never);

  assert.equal(status, 200);
  assert.deepEqual(counters, [
    { name: "ingestion_requests", delta: 1 },
    { name: "accepted_events", delta: 2 },
  ]);
});
