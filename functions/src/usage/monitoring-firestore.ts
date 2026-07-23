import { FieldPath, type Firestore } from "firebase-admin/firestore";

import {
  evaluateUsageMonitoring,
  validateUsageMonitoringThresholds,
  type UsageAlert,
  type UsageMonitoringMetrics,
  type UsageMonitoringThresholds,
} from "./monitoring";

export interface MonitoringScheduleConfig {
  thresholds: UsageMonitoringThresholds;
  snapshotId: string;
  windowMs?: number;
  routes?: string[];
}

export interface PersistedMonitoringResult {
  snapshotId: string;
  alerts: UsageAlert[];
  recovered: string[];
  notifications: string[];
}

interface MonitoringAlertDocument {
  code: string;
  status: "active" | "recovered";
  owner: string;
  severity: "warning" | "critical";
  value: number;
  threshold: number;
  first_seen_at: string;
  last_seen_at: string;
  recovered_at: string | null;
  occurrences: number;
}

const ALERT_CODES = [
  "aggregate_drift",
  "permanent_reject_rate",
  "auth_failure_rate",
  "lease_renew_failure_rate",
  "dead_letter_growth",
  "write_cost",
] as const;
const COUNTER_BUCKET_MS = 5 * 60_000;
const DEFAULT_WINDOW_MS = 60 * 60_000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`Invalid ${label}`);
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class FirestoreMonitoringService {
  public constructor(public readonly firestore: Firestore) {}

  public async incrementCounter(name: string, delta: number, now: Date): Promise<number> {
    assertIdentifier(name, "monitoring counter");
    if (!Number.isFinite(delta) || delta < 0) throw new Error("Invalid monitoring counter delta");
    const bucketStartMs = Math.floor(now.getTime() / COUNTER_BUCKET_MS) * COUNTER_BUCKET_MS;
    const bucketStart = new Date(bucketStartMs);
    const reference = this.firestore.collection("usageMonitoringCounters").doc(`${bucketStart.toISOString().replace(/[^0-9A-Za-z]/g, "")}_${name}`);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const current = snapshot.exists ? Number(snapshot.data()?.value ?? 0) : 0;
      const value = current + delta;
      transaction.set(reference, {
        name,
        value,
        bucket_start: bucketStart,
        expires_at: new Date(bucketStartMs + COUNTER_BUCKET_MS),
        updated_at: now.toISOString(),
      }, { merge: true });
      return value;
    });
  }

  public async deriveMetrics(input: { now: Date; windowMs?: number }): Promise<UsageMonitoringMetrics> {
    const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
    if (!Number.isSafeInteger(windowMs) || windowMs < COUNTER_BUCKET_MS || windowMs > MAX_WINDOW_MS) {
      throw new Error("Invalid monitoring window");
    }
    const windowStart = new Date(input.now.getTime() - windowMs);
    const counterSnapshot = await this.firestore.collection("usageMonitoringCounters")
      .where("bucket_start", ">=", new Date(Math.floor(windowStart.getTime() / COUNTER_BUCKET_MS) * COUNTER_BUCKET_MS))
      .where("bucket_start", "<=", input.now)
      .orderBy("bucket_start", "asc")
      .orderBy(FieldPath.documentId(), "asc")
      .get();
    const counters = new Map<string, number>();
    for (const document of counterSnapshot.docs) {
      const data = document.data();
      const name = typeof data.name === "string" ? data.name : "";
      const value = Number(data.value ?? 0);
      if (name && Number.isFinite(value) && value >= 0) counters.set(name, (counters.get(name) ?? 0) + value);
    }
    const deadLetters = await this.firestore.collection("deadLetters")
      .where("server_received_at", ">=", windowStart.toISOString())
      .where("server_received_at", "<=", input.now.toISOString())
      .get();
    const replayValidations = await this.firestore.collection("usageReplayJobs")
      .where("validation.validated_at", ">=", windowStart.toISOString())
      .where("validation.validated_at", "<=", input.now.toISOString())
      .get();
    const accepted = counters.get("accepted_events") ?? 0;
    const permanentRejected = counters.get("permanent_rejections") ?? 0;
    const ingestionRequests = counters.get("ingestion_requests") ?? 0;
    const authFailures = counters.get("auth_failures") ?? 0;
    const leaseAttempts = counters.get("lease_renew_attempts") ?? 0;
    const leaseFailures = counters.get("lease_renew_failures") ?? 0;
    let aggregateExpected = 0;
    let aggregateDrift = 0;
    for (const document of replayValidations.docs) {
      const validation = document.data().validation;
      const expected = Number(validation?.source?.event_count ?? 0);
      const observed = Number(validation?.shadow?.event_count ?? 0);
      if (!Number.isFinite(expected) || expected < 0 || !Number.isFinite(observed) || observed < 0) continue;
      aggregateExpected += expected;
      const validationMismatch = validation?.matched === false
        || canonicalValue(validation?.source ?? {}) !== canonicalValue(validation?.shadow ?? {});
      aggregateDrift += validationMismatch && expected === observed
        ? Math.max(expected, 1)
        : Math.abs(expected - observed);
    }
    const writes = counters.get("firestore_writes") ?? 0;
    const aggregateDriftRatio = aggregateExpected > 0 ? aggregateDrift / aggregateExpected : aggregateDrift > 0 ? 1 : 0;
    return {
      aggregateDriftRatio,
      permanentRejectRate: permanentRejected / Math.max(1, accepted + permanentRejected),
      authFailureRate: authFailures / Math.max(1, ingestionRequests),
      leaseRenewFailureRate: leaseFailures / Math.max(1, leaseAttempts),
      deadLetterGrowthPerHour: deadLetters.size / (windowMs / 3_600_000),
      writesPerAcceptedEvent: writes / Math.max(1, accepted),
    };
  }

  public async evaluateAndPersist(input: {
    metrics: UsageMonitoringMetrics;
    thresholds: UsageMonitoringThresholds;
    now: Date;
    snapshotId: string;
    routes?: string[];
  }): Promise<PersistedMonitoringResult> {
    assertIdentifier(input.snapshotId, "monitoring snapshot");
    validateUsageMonitoringThresholds(input.thresholds);
    if (input.routes !== undefined && !Array.isArray(input.routes)) throw new Error("Monitoring routes are invalid");
    const routes = [...new Set(input.routes ?? [])];
    if (routes.length > 20) throw new Error("Monitoring routes exceed the maximum");
    for (const route of routes) assertIdentifier(route, "monitoring route");
    const alerts = evaluateUsageMonitoring(input.metrics, input.thresholds);
    const currentByCode = new Map(alerts.map((alert) => [alert.code, alert]));
    const alertReferences = ALERT_CODES.map((code) => this.firestore.collection("usageMonitoringAlerts").doc(code));
    const snapshotReference = this.firestore.collection("usageMonitoringSnapshots").doc(input.snapshotId);
    const recovered: string[] = [];
    const notifications = alerts.flatMap((alert) => routes.map((route) => ({
      id: `${input.snapshotId}_${alert.code}_${route}`,
      route,
      alert,
    })));
    await this.firestore.runTransaction(async (transaction) => {
      // Firestore transactions require all reads before their writes.
      const snapshots = await Promise.all(alertReferences.map((reference) => transaction.get(reference)));
      transaction.set(snapshotReference, {
        snapshot_id: input.snapshotId,
        metrics: input.metrics,
        thresholds: input.thresholds,
        alert_codes: alerts.map((alert) => alert.code),
        recorded_at: input.now.toISOString(),
      });
      for (let index = 0; index < alertReferences.length; index += 1) {
        const code = ALERT_CODES[index];
        const reference = alertReferences[index];
        const existing = snapshots[index].exists ? snapshots[index].data() as MonitoringAlertDocument : undefined;
        const alert = currentByCode.get(code);
        if (alert) {
          transaction.set(reference, {
            code,
            status: "active",
            owner: alert.owner,
            severity: alert.severity,
            value: alert.value,
            threshold: alert.threshold,
            first_seen_at: existing?.status === "active" ? existing.first_seen_at : input.now.toISOString(),
            last_seen_at: input.now.toISOString(),
            recovered_at: null,
            occurrences: existing?.status === "active" ? (existing.occurrences ?? 0) + 1 : 1,
          } satisfies MonitoringAlertDocument);
        } else if (existing?.status === "active") {
          recovered.push(code);
          transaction.set(reference, {
            ...existing,
            status: "recovered",
            recovered_at: input.now.toISOString(),
            last_seen_at: input.now.toISOString(),
          } satisfies MonitoringAlertDocument);
        }
      }
      for (const notification of notifications) {
        transaction.set(this.firestore.collection("usageMonitoringNotifications").doc(notification.id), {
          notification_id: notification.id,
          snapshot_id: input.snapshotId,
          route: notification.route,
          status: "pending",
          alert: notification.alert,
          created_at: input.now.toISOString(),
        });
      }
    });
    return { snapshotId: input.snapshotId, alerts, recovered, notifications: notifications.map((item) => item.id) };
  }
}

export function createScheduledUsageMonitoringHandler(input: {
  firestore: Firestore;
  readConfig?: () => MonitoringScheduleConfig | undefined;
  config?: MonitoringScheduleConfig;
  clock?: () => Date;
}): () => Promise<PersistedMonitoringResult> {
  return async () => {
    const config = input.readConfig ? input.readConfig() : input.config;
    if (!config) throw new Error("Monitoring configuration is required");
    if (Object.hasOwn(config as object, "metrics")) throw new Error("Monitoring configuration must not include metrics");
    const service = new FirestoreMonitoringService(input.firestore);
    const now = input.clock?.() ?? new Date();
    return service.evaluateAndPersist({
      metrics: await service.deriveMetrics({ now, windowMs: config.windowMs }),
      thresholds: config.thresholds,
      snapshotId: config.snapshotId,
      routes: config.routes,
      now,
    });
  };
}

export const createUsageMonitoringScheduledHandler = createScheduledUsageMonitoringHandler;
