import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildScheduledRetentionRunId,
  retentionCleanupScheduled,
  usageMonitoringScheduled,
} from "../src/usage/scheduled";

test("exports maintenance schedules as Firebase Functions", () => {
  assert.equal(typeof retentionCleanupScheduled, "function");
  assert.equal(typeof usageMonitoringScheduled, "function");
});

test("scheduled retention run IDs are retry-stable and distinct per schedule time", () => {
  const first = buildScheduledRetentionRunId(
    "scheduled-retention",
    "2026-07-23T02:00:00.000Z",
    "projects/demo/locations/asia-east1/jobs/retention",
  );
  const retry = buildScheduledRetentionRunId(
    "scheduled-retention",
    "2026-07-23T02:00:00.000Z",
    "projects/demo/locations/asia-east1/jobs/retention",
  );
  const second = buildScheduledRetentionRunId(
    "scheduled-retention",
    "2026-07-23T14:00:00.000Z",
    "projects/demo/locations/asia-east1/jobs/retention",
  );
  assert.equal(first, retry);
  assert.notEqual(first, second);
  assert.match(first, /^scheduled-retention_[a-f0-9]{24}$/);
});

test("production retention scheduler leaves lease time on the live handler clock", () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(testDirectory, "..", "src", "usage", "scheduled.ts"), "utf8");
  const retentionHandler = source.match(/createScheduledRetentionCleanupHandler\(\{([\s\S]*?)\}\)\(\);/)?.[1];
  assert.ok(retentionHandler, "Scheduled retention handler wiring was not found");
  assert.doesNotMatch(retentionHandler, /clock\s*:/, "Production retention must not freeze its lease clock at trigger time");
});
