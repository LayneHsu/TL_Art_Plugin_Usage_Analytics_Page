import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { createHash, randomUUID } from "node:crypto";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { defineString } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";

import {
  createScheduledUsageMonitoringHandler,
  type MonitoringScheduleConfig,
} from "./monitoring-firestore";
import {
  createScheduledRetentionCleanupHandler,
  type RetentionCleanupRuntimeConfig,
} from "./retention-firestore";

const retentionSchedule = defineString("USAGE_RETENTION_SCHEDULE", {
  default: "0 2 * * *",
});
const retentionTimeZone = defineString("USAGE_RETENTION_TIME_ZONE", {
  default: "Asia/Shanghai",
});
const retentionPolicyJson = defineString("USAGE_RETENTION_POLICY_JSON", {
  default: "",
});
const retentionRunIdPrefix = defineString("USAGE_RETENTION_RUN_ID_PREFIX", {
  default: "scheduled-retention",
});
const retentionDryRun = defineString("USAGE_RETENTION_DRY_RUN", {
  default: "true",
});
const retentionMaxPages = defineString("USAGE_RETENTION_MAX_PAGES", {
  default: "20",
});
const retentionOwnerId = defineString("USAGE_RETENTION_OWNER_ID", {
  default: "scheduled-retention-worker",
});
const retentionLeaseMs = defineString("USAGE_RETENTION_LEASE_MS", {
  default: "300000",
});
const monitoringSchedule = defineString("USAGE_MONITORING_SCHEDULE", {
  default: "*/15 * * * *",
});
const monitoringTimeZone = defineString("USAGE_MONITORING_TIME_ZONE", {
  default: "Asia/Shanghai",
});
const monitoringConfigJson = defineString("USAGE_MONITORING_CONFIG_JSON", {
  default: "",
});

function firestore() {
  const app = getApps().length > 0 ? getApp() : initializeApp();
  return getFirestore(app);
}

function parseObject(value: string, label: string): Record<string, unknown> {
  if (!value.trim()) throw new Error(`${label} configuration is required`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} configuration is invalid`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} configuration is invalid`);
  }
  return parsed as Record<string, unknown>;
}

export function buildScheduledRetentionRunId(prefix: string, scheduleTime: string, jobName = ""): string {
  const normalized = prefix.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(normalized)) {
    throw new Error("Retention run ID prefix is invalid");
  }
  const timestamp = new Date(scheduleTime);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Retention schedule time is invalid");
  const digest = createHash("sha256")
    .update(`${jobName}\u0000${timestamp.toISOString()}`)
    .digest("hex")
    .slice(0, 24);
  return `${normalized}_${digest}`;
}

export async function resolveScheduledRetentionRunId(input: {
  firestore: Firestore;
  prefix: string;
  scheduleTime: string;
  jobName?: string;
  now: Date;
}): Promise<string> {
  if (Number.isNaN(input.now.getTime())) throw new Error("Retention schedule clock is invalid");
  const candidate = buildScheduledRetentionRunId(input.prefix, input.scheduleTime, input.jobName);
  const scheduleKey = createHash("sha256")
    .update(`${input.prefix.trim()}\u0000${input.jobName ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  const pointerReference = input.firestore.collection("usageRetentionSchedules").doc(scheduleKey);
  return input.firestore.runTransaction(async (transaction) => {
    const pointerSnapshot = await transaction.get(pointerReference);
    const pointer = pointerSnapshot.data();
    const activeRunId = typeof pointer?.active_run_id === "string" ? pointer.active_run_id : null;
    if (activeRunId) {
      const activeRunSnapshot = await transaction.get(input.firestore.collection("usageRetentionRuns").doc(activeRunId));
      if (activeRunSnapshot.data()?.status === "running") return activeRunId;
      const reservedUntil = Date.parse(String(pointer?.reserved_until ?? ""));
      if (!activeRunSnapshot.exists && Number.isFinite(reservedUntil) && reservedUntil > input.now.getTime()) {
        return activeRunId;
      }
    }
    transaction.set(pointerReference, {
      schedule_key: scheduleKey,
      active_run_id: candidate,
      active_schedule_time: new Date(input.scheduleTime).toISOString(),
      reserved_until: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
      updated_at: input.now.toISOString(),
    });
    return candidate;
  });
}

function scheduledOwnerId(prefix: string): string {
  const normalized = prefix.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(normalized)) {
    throw new Error("Retention owner ID is invalid");
  }
  return `${normalized}:${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function positiveInteger(value: string, label: string, maximum: number): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} is invalid`);
  return parsed;
}

function readRetentionConfig(runId: string): RetentionCleanupRuntimeConfig {
  const parsed = parseObject(retentionPolicyJson.value(), "Retention policy");
  const dryRunValue = retentionDryRun.value().trim().toLowerCase();
  if (dryRunValue !== "true" && dryRunValue !== "false") {
    throw new Error("Retention dry-run configuration is invalid");
  }
  return {
    ...(parsed as Omit<RetentionCleanupRuntimeConfig, "runId" | "dryRun">),
    runId,
    dryRun: dryRunValue === "true",
    maxPages: positiveInteger(retentionMaxPages.value(), "Retention max pages", 1000),
    ownerId: scheduledOwnerId(retentionOwnerId.value()),
    leaseMs: positiveInteger(retentionLeaseMs.value(), "Retention lease", 900000),
  };
}

function readMonitoringConfig(): MonitoringScheduleConfig {
  const parsed = parseObject(monitoringConfigJson.value(), "Monitoring");
  if ("metrics" in parsed || !("thresholds" in parsed)) {
    throw new Error("Monitoring configuration is invalid");
  }
  return parsed as unknown as MonitoringScheduleConfig;
}

function scheduleValue(value: string, label: string): string {
  const schedule = value.trim();
  if (!schedule) throw new Error(`${label} schedule is required`);
  return schedule;
}

function timeZoneValue(value: string, label: string): string {
  const timeZone = value.trim();
  if (!timeZone) throw new Error(`${label} time zone is required`);
  return timeZone;
}

export const retentionCleanupScheduled = onSchedule(
  {
    schedule: scheduleValue(retentionSchedule.value() || "0 2 * * *", "Retention"),
    timeZone: timeZoneValue(retentionTimeZone.value() || "Asia/Shanghai", "Retention"),
    timeoutSeconds: 540,
    memory: "256MiB",
  },
  async (event) => {
    const now = new Date();
    const database = firestore();
    const runId = await resolveScheduledRetentionRunId({
      firestore: database,
      prefix: retentionRunIdPrefix.value(),
      scheduleTime: event.scheduleTime || now.toISOString(),
      jobName: event.jobName,
      now,
    });
    await createScheduledRetentionCleanupHandler({
      firestore: database,
      readConfig: () => readRetentionConfig(runId),
    })();
  },
);

export const usageMonitoringScheduled = onSchedule(
  {
    schedule: scheduleValue(monitoringSchedule.value() || "*/15 * * * *", "Monitoring"),
    timeZone: timeZoneValue(monitoringTimeZone.value() || "Asia/Shanghai", "Monitoring"),
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    const now = new Date();
    const snapshotId = `scheduled_${now.toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 24)}`;
    await createScheduledUsageMonitoringHandler({
      firestore: firestore(),
      readConfig: () => ({ ...readMonitoringConfig(), snapshotId }),
      clock: () => now,
    })();
  },
);
