import { createHash } from "node:crypto";

import {
  FieldPath,
  type DocumentReference,
  type DocumentData,
  type Firestore,
  type Query,
} from "firebase-admin/firestore";

import type {
  RetentionPolicy,
  RetentionRecord,
} from "./retention";

export type RetentionCollection = RetentionRecord["collection"];

export interface RetentionCleanupRuntimeConfig extends RetentionPolicy {
  runId: string;
  dryRun: boolean;
  maxPages?: number;
  ownerId?: string;
  leaseMs?: number;
}

export interface RetentionCursor {
  value: string;
  id: string;
}

export interface RetentionPage {
  records: RetentionRecord[];
  nextCursor: RetentionCursor | null;
}

interface RetentionRunDocument {
  run_id: string;
  status: "running" | "completed";
  dry_run: boolean;
  cutoff_at: string;
  policy_digest: string;
  collection_index: number;
  cursors: Partial<Record<RetentionCollection, RetentionCursor>>;
  candidates: number;
  deleted: number;
  pages: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  updated_at: string;
}

const COLLECTIONS: readonly RetentionCollection[] = [
  "usageEvents",
  "deadLetters",
  "pluginAuthAudit",
  "toolUsageDaily",
  "principalUsageDaily",
  "errorAggregates",
  "usageQuotas",
  "usageOperations",
  "usageReplayApprovals",
  "usageReplayJobs",
  "usageRetentionRuns",
  "usageAggregateSourceRevisions",
  "usageMonitoringCounters",
  "usageMonitoringSnapshots",
  "usageMonitoringNotifications",
];

const TIME_FIELDS: Record<RetentionCollection, { field: string; kind: "timestamp" | "iso" | "date" }> = {
  usageEvents: { field: "server_received_at", kind: "iso" },
  deadLetters: { field: "server_received_at", kind: "iso" },
  pluginAuthAudit: { field: "occurredAt", kind: "timestamp" },
  toolUsageDaily: { field: "date", kind: "date" },
  principalUsageDaily: { field: "date", kind: "date" },
  errorAggregates: { field: "date", kind: "date" },
  usageQuotas: { field: "expires_at", kind: "timestamp" },
  usageOperations: { field: "updated_at", kind: "iso" },
  usageReplayApprovals: { field: "expires_at", kind: "timestamp" },
  usageReplayJobs: { field: "updated_at", kind: "iso" },
  usageRetentionRuns: { field: "updated_at", kind: "iso" },
  usageReplayValidationGroups: { field: "updated_at", kind: "iso" },
  usageAggregateSourceRevisions: { field: "updated_at", kind: "iso" },
  usageMonitoringCounters: { field: "expires_at", kind: "timestamp" },
  usageMonitoringSnapshots: { field: "recorded_at", kind: "iso" },
  usageMonitoringNotifications: { field: "created_at", kind: "iso" },
};

const RETENTION_FIELDS: Record<RetentionCollection, keyof RetentionPolicy> = {
  usageEvents: "rawEventRetentionMs",
  deadLetters: "deadLetterRetentionMs",
  pluginAuthAudit: "authAuditRetentionMs",
  toolUsageDaily: "aggregateRetentionMs",
  principalUsageDaily: "aggregateRetentionMs",
  errorAggregates: "aggregateRetentionMs",
  usageQuotas: "quotaRetentionMs",
  usageOperations: "operationRetentionMs",
  usageReplayApprovals: "operationRetentionMs",
  usageReplayJobs: "replayMetadataRetentionMs",
  usageRetentionRuns: "retentionRunRetentionMs",
  usageReplayValidationGroups: "operationRetentionMs",
  usageAggregateSourceRevisions: "rawEventRetentionMs",
  usageMonitoringCounters: "monitoringRetentionMs",
  usageMonitoringSnapshots: "monitoringRetentionMs",
  usageMonitoringNotifications: "monitoringRetentionMs",
};

const STATUS_FILTERS: Partial<Record<RetentionCollection, { field: string; values: string[] }>> = {
  usageReplayJobs: { field: "status", values: ["failed", "finalized"] },
  usageRetentionRuns: { field: "status", values: ["completed"] },
};

const SAFE_DELETE_STATUSES: Partial<Record<RetentionCollection, ReadonlySet<string>>> = {
  usageReplayJobs: new Set(["failed", "finalized"]),
  usageRetentionRuns: new Set(["completed"]),
};

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate();
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid retention timestamp");
  return parsed;
}

function validateCursor(cursor: RetentionCursor | undefined): void {
  if (!cursor) return;
  if (!cursor.id || !cursor.value || cursor.id.length > 256 || cursor.value.length > 128) {
    throw new Error("Invalid retention cursor");
  }
}

function validatePolicy(policy: RetentionPolicy): void {
  for (const key of [
    "rawEventRetentionMs",
    "deadLetterRetentionMs",
    "authAuditRetentionMs",
    "aggregateRetentionMs",
    "quotaRetentionMs",
    "operationRetentionMs",
    "replayMetadataRetentionMs",
    "retentionRunRetentionMs",
    "monitoringRetentionMs",
    "rebuildWindowMs",
    "lateArrivalAllowanceMs",
  ] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) throw new Error(`Invalid retention policy: ${key}`);
  }
  if (policy.rawEventRetentionMs < policy.rebuildWindowMs + policy.lateArrivalAllowanceMs) {
    throw new Error("Raw event retention must cover the rebuild window and late arrivals");
  }
  if (policy.batchSize !== undefined && (!Number.isSafeInteger(policy.batchSize) || policy.batchSize < 1 || policy.batchSize > 500)) {
    throw new Error("Retention batch size must be between 1 and 500");
  }
}

function idHash(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function policyDigest(policy: RetentionPolicy): string {
  return createHash("sha256").update(JSON.stringify({
    rawEventRetentionMs: policy.rawEventRetentionMs,
    deadLetterRetentionMs: policy.deadLetterRetentionMs,
    authAuditRetentionMs: policy.authAuditRetentionMs,
    aggregateRetentionMs: policy.aggregateRetentionMs,
    quotaRetentionMs: policy.quotaRetentionMs,
    operationRetentionMs: policy.operationRetentionMs,
    replayMetadataRetentionMs: policy.replayMetadataRetentionMs,
    retentionRunRetentionMs: policy.retentionRunRetentionMs,
    monitoringRetentionMs: policy.monitoringRetentionMs,
    rebuildWindowMs: policy.rebuildWindowMs,
    lateArrivalAllowanceMs: policy.lateArrivalAllowanceMs,
    batchSize: policy.batchSize ?? 200,
  })).digest("hex");
}

function retentionBefore(collection: RetentionCollection, now: Date, policy: RetentionPolicy): Date | string {
  const duration = policy[RETENTION_FIELDS[collection]] as number;
  const before = new Date(now.getTime() - duration);
  const kind = TIME_FIELDS[collection].kind;
  return kind === "date" ? before.toISOString().slice(0, 10) : kind === "iso" ? before.toISOString() : before;
}

export class FirestoreRetentionAdapter {
  public constructor(public readonly firestore: Firestore) {}

  public async listExpiredPage(
    collection: RetentionCollection,
    before: Date | string,
    limit: number,
    cursor?: RetentionCursor,
  ): Promise<RetentionPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Retention page size must be between 1 and 500");
    validateCursor(cursor);
    const definition = TIME_FIELDS[collection];
    const normalizedBefore = definition.kind === "date"
      ? (before instanceof Date ? before.toISOString().slice(0, 10) : before.slice(0, 10))
      : definition.kind === "iso"
        ? (before instanceof Date ? before.toISOString() : new Date(before).toISOString())
        : (before instanceof Date ? before : new Date(before));
    const statusFilter = STATUS_FILTERS[collection];
    let query: Query = this.firestore.collection(collection);
    if (statusFilter) query = query.where(statusFilter.field, "in", statusFilter.values);
    if (collection === "usageOperations") query = query.where("pending_terminal", "==", null);
    query = query
      .where(definition.field, "<", normalizedBefore)
      .orderBy(definition.field, "asc")
      .orderBy(FieldPath.documentId(), "asc")
      .limit(limit);
    if (cursor) {
      query = query.startAfter(definition.kind === "timestamp" ? new Date(cursor.value) : cursor.value, cursor.id);
    }
    const snapshot = await query.get();
    const records = snapshot.docs.map((document) => {
      const raw = document.data();
      return {
        id: document.id,
        collection,
        occurredAt: definition.kind === "date"
          ? new Date(`${String(raw[definition.field])}T00:00:00.000Z`)
          : toDate(raw[definition.field]),
      } satisfies RetentionRecord;
    });
    const last = records[records.length - 1];
    return {
      records,
      nextCursor: last
        ? { value: definition.kind === "date" ? last.occurredAt.toISOString().slice(0, 10) : last.occurredAt.toISOString(), id: last.id }
        : null,
    };
  }

  public async listExpired(collection: RetentionCollection, before: Date, limit: number): Promise<RetentionRecord[]> {
    return (await this.listExpiredPage(collection, retentionBefore(collection, before, {
      rawEventRetentionMs: 0,
      deadLetterRetentionMs: 0,
      authAuditRetentionMs: 0,
      aggregateRetentionMs: 0,
      quotaRetentionMs: 0,
      operationRetentionMs: 0,
      replayMetadataRetentionMs: 0,
      retentionRunRetentionMs: 0,
      monitoringRetentionMs: 0,
      rebuildWindowMs: 0,
      lateArrivalAllowanceMs: 0,
    }), limit)).records;
  }

  public async deleteBatch(collection: RetentionCollection, ids: string[]): Promise<void> {
    if (ids.length > 500) throw new Error("Retention delete batch exceeds Firestore limit");
    if (!ids.length) return;
    const batch = this.firestore.batch();
    for (const id of ids) batch.delete(this.firestore.collection(collection).doc(id));
    await batch.commit();
  }

  public async deleteBatchIfLeaseHeld(input: {
    collection: RetentionCollection;
    ids: string[];
    runId: string;
    ownerId: string;
    now: Date;
  }): Promise<void> {
    if (input.ids.length > 500) throw new Error("Retention lease delete batch exceeds Firestore transaction limit");
    if (!input.ids.length) return;
    const run = runReference(this.firestore, input.runId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(run);
      assertRetentionLease(snapshot.data(), input.ownerId, input.now);
      const references = input.ids.map((id) => this.firestore.collection(input.collection).doc(id));
      const documents = await Promise.all(references.map((reference) => transaction.get(reference)));
      const safeStatuses = SAFE_DELETE_STATUSES[input.collection];
      for (let index = 0; index < references.length; index += 1) {
        const document = documents[index];
        if (!document.exists) continue;
        if (safeStatuses && !safeStatuses.has(String(document.data()?.status ?? ""))) {
          throw new Error(`Retention deletion deferred for active ${input.collection} record`);
        }
        if (input.collection === "usageOperations" && document.data()?.pending_terminal != null) {
          throw new Error("Retention deletion deferred for operation with pending terminal");
        }
        transaction.delete(references[index]);
      }
    });
  }

  public async deleteRawEventBatchIfReplayIdle(input: {
    ids: string[];
    before: Date;
    runId: string;
    ownerId: string;
    now: Date;
  }): Promise<void> {
    if (input.ids.length > 499) throw new Error("Raw-event retention delete batch exceeds Firestore transaction limit");
    if (!input.ids.length) return;
    const lockReference = this.firestore.collection("usageReplayLocks").doc("aggregate-rebuild");
    const runningReplayQuery = this.firestore.collection("usageReplayJobs").where("status", "==", "running");
    const run = runReference(this.firestore, input.runId);
    await this.firestore.runTransaction(async (transaction) => {
      const [runSnapshot, lockSnapshot, replaySnapshot] = await Promise.all([
        transaction.get(run),
        transaction.get(lockReference),
        transaction.get(runningReplayQuery),
      ]);
      assertRetentionLease(runSnapshot.data(), input.ownerId, input.now);
      const lock = lockSnapshot.data();
      if (lock && lock.released_at === null && Date.parse(String(lock.expires_at ?? "")) > input.now.getTime()) {
        throw new Error("Raw event retention is deferred while replay is active");
      }
      for (const replay of replaySnapshot.docs) {
        const from = Date.parse(String(replay.data().from ?? ""));
        if (Number.isFinite(from) && from < input.before.getTime()) {
          throw new Error("Raw event retention is deferred while replay is active");
        }
      }
      const timestamp = input.now.toISOString();
      transaction.set(lockReference, {
        owner_id: input.ownerId,
        replay_id: `retention:${input.runId}`,
        acquired_at: timestamp,
        expires_at: timestamp,
        released_at: timestamp,
      });
      for (const id of input.ids) transaction.delete(this.firestore.collection("usageEvents").doc(id));
    });
  }

  public async writeAudit(record: { runId: string; dryRun: boolean; collection: string; ids: string[]; occurredAt: Date }): Promise<void> {
    const digest = createHash("sha256").update(record.ids.join("\u0000")).digest("hex").slice(0, 24);
    const id = `${record.runId}_${record.collection}_${digest}`.slice(0, 1_500);
    await this.firestore.collection("usageRetentionAudit").doc(id).set({
      run_id: record.runId,
      dry_run: record.dryRun,
      collection: record.collection,
      candidate_count: record.ids.length,
      id_hashes: record.ids.map(idHash),
      occurred_at: record.occurredAt,
    }, { merge: true });
  }

  public async writePageAudit(input: {
    runId: string;
    dryRun: boolean;
    collection: RetentionCollection;
    page: number;
    records: RetentionRecord[];
    occurredAt: Date;
  }): Promise<void> {
    const reference = this.firestore.collection("usageRetentionAudit").doc(`${input.runId}_${input.collection}_${input.page}`);
    await reference.set({
      run_id: input.runId,
      dry_run: input.dryRun,
      collection: input.collection,
      page: input.page,
      candidate_count: input.records.length,
      id_hashes: input.records.map((record) => idHash(record.id)),
      occurred_at: input.occurredAt,
    }, { merge: true });
  }
}

function runReference(firestore: Firestore, runId: string) {
  return firestore.collection("usageRetentionRuns").doc(runId);
}

function assertRetentionLease(data: DocumentData | undefined, ownerId: string, now: Date): RetentionRunDocument {
  const state = data as RetentionRunDocument | undefined;
  if (!state || state.status !== "running" || state.lease_owner !== ownerId
    || !state.lease_expires_at || Date.parse(state.lease_expires_at) <= now.getTime()) {
    throw new Error("Retention run lease was lost");
  }
  return state;
}

function configPolicy(config: RetentionCleanupRuntimeConfig): RetentionPolicy {
  const { runId: _runId, dryRun: _dryRun, maxPages: _maxPages, ownerId: _ownerId, leaseMs: _leaseMs, ...policy } = config;
  return policy;
}

export class FirestoreRetentionCleanupService {
  public constructor(
    private readonly adapter: FirestoreRetentionAdapter,
    private readonly policy: RetentionPolicy,
    private readonly leaseClock?: () => Date,
  ) {
    validatePolicy(policy);
  }

  private currentLeaseTime(fallback: Date): Date {
    const value = this.leaseClock?.() ?? fallback;
    if (Number.isNaN(value.getTime())) throw new Error("Retention lease clock is invalid");
    return value;
  }

  private async renewLease(reference: DocumentReference, ownerId: string, leaseMs: number, now: Date): Promise<RetentionRunDocument> {
    return this.adapter.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const state = assertRetentionLease(snapshot.data(), ownerId, now);
      const renewed: RetentionRunDocument = {
        ...state,
        lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
        updated_at: now.toISOString(),
      };
      transaction.set(reference, renewed);
      return renewed;
    });
  }

  private async saveProgress(
    reference: DocumentReference,
    state: RetentionRunDocument,
    ownerId: string,
    leaseMs: number,
    now: Date,
  ): Promise<RetentionRunDocument> {
    return this.adapter.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      assertRetentionLease(snapshot.data(), ownerId, now);
      const updated: RetentionRunDocument = {
        ...state,
        lease_owner: ownerId,
        lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
        updated_at: now.toISOString(),
      };
      transaction.set(reference, updated);
      return updated;
    });
  }

  private async releaseLease(reference: DocumentReference, ownerId: string, now: Date): Promise<void> {
    await this.adapter.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const state = snapshot.data() as RetentionRunDocument | undefined;
      if (!state || state.lease_owner !== ownerId) return;
      transaction.set(reference, {
        lease_owner: null,
        lease_expires_at: null,
        updated_at: now.toISOString(),
      }, { merge: true });
    });
  }

  public async run(input: { runId: string; now: Date; dryRun: boolean; maxPages?: number; ownerId?: string; leaseMs?: number }): Promise<{
    runId: string;
    status: "running" | "completed";
    dryRun: boolean;
    candidates: number;
    deleted: number;
    totalCandidates: number;
    totalDeleted: number;
    pages: number;
  }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.runId)) throw new Error("Invalid retention run ID");
    if (input.maxPages !== undefined && (!Number.isSafeInteger(input.maxPages) || input.maxPages < 1)) throw new Error("Invalid maxPages");
    const ownerId = input.ownerId ?? "retention-worker";
    const leaseMs = input.leaseMs ?? 60_000;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId)) throw new Error("Invalid retention owner ID");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000) throw new Error("Invalid retention lease");
    const reference = runReference(this.adapter.firestore, input.runId);
    let state: RetentionRunDocument;
    const currentPolicyDigest = policyDigest(this.policy);
    const initialLeaseNow = this.currentLeaseTime(input.now);
    state = await this.adapter.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        const created: RetentionRunDocument = {
          run_id: input.runId,
          status: "running",
          dry_run: input.dryRun,
          cutoff_at: input.now.toISOString(),
          policy_digest: currentPolicyDigest,
          collection_index: 0,
          cursors: {},
          candidates: 0,
          deleted: 0,
          pages: 0,
          lease_owner: ownerId,
          lease_expires_at: new Date(initialLeaseNow.getTime() + leaseMs).toISOString(),
          updated_at: initialLeaseNow.toISOString(),
        };
        transaction.create(reference, created);
        return created;
      }
      const current = snapshot.data() as RetentionRunDocument;
      if (current.dry_run !== input.dryRun) throw new Error("Retention run dry-run mode cannot change");
      if (current.policy_digest !== currentPolicyDigest) throw new Error("Retention run policy cannot change");
      if (current.status === "completed") return current;
      if (current.lease_owner && current.lease_owner !== ownerId && current.lease_expires_at && Date.parse(current.lease_expires_at) > initialLeaseNow.getTime()) {
        throw new Error("Retention run is locked");
      }
      const renewed = {
        ...current,
        lease_owner: ownerId,
        lease_expires_at: new Date(initialLeaseNow.getTime() + leaseMs).toISOString(),
        updated_at: initialLeaseNow.toISOString(),
      };
      transaction.set(reference, renewed);
      return renewed;
    });
    if (state.status === "completed") return {
      runId: input.runId,
      status: state.status,
      dryRun: state.dry_run,
      candidates: 0,
      deleted: 0,
      totalCandidates: state.candidates,
      totalDeleted: state.deleted,
      pages: state.pages,
    };
    const startingCandidates = state.candidates;
    const startingDeleted = state.deleted;
    const cutoffAt = new Date(state.cutoff_at);
    if (Number.isNaN(cutoffAt.getTime())) throw new Error("Retention run cutoff is invalid");
    let pagesThisRun = 0;
    const maxPages = input.maxPages ?? Number.MAX_SAFE_INTEGER;
    while (state.collection_index < COLLECTIONS.length && pagesThisRun < maxPages) {
      state = await this.renewLease(reference, ownerId, leaseMs, this.currentLeaseTime(input.now));
      const collection = COLLECTIONS[state.collection_index];
      const before = retentionBefore(collection, cutoffAt, this.policy);
      const configuredBatchSize = this.policy.batchSize ?? 200;
      const page = await this.adapter.listExpiredPage(
        collection,
        before,
        collection === "usageEvents" ? Math.min(configuredBatchSize, 499) : configuredBatchSize,
        state.cursors[collection],
      );
      if (!page.records.length) {
        state.collection_index += 1;
        delete state.cursors[collection];
        state = await this.saveProgress(reference, state, ownerId, leaseMs, this.currentLeaseTime(input.now));
        continue;
      }
      state = await this.renewLease(reference, ownerId, leaseMs, this.currentLeaseTime(input.now));
      const pageNumber = state.pages;
      await this.adapter.writePageAudit({ runId: input.runId, dryRun: input.dryRun, collection, page: pageNumber, records: page.records, occurredAt: input.now });
      state = await this.renewLease(reference, ownerId, leaseMs, this.currentLeaseTime(input.now));
      if (!input.dryRun) {
        if (collection === "usageEvents") {
          await this.adapter.deleteRawEventBatchIfReplayIdle({
            ids: page.records.map((record) => record.id),
            before: before instanceof Date ? before : new Date(before),
            runId: input.runId,
            ownerId,
            now: this.currentLeaseTime(input.now),
          });
        } else {
          await this.adapter.deleteBatchIfLeaseHeld({
            collection,
            ids: page.records.map((record) => record.id),
            runId: input.runId,
            ownerId,
            now: this.currentLeaseTime(input.now),
          });
        }
      }
      state.candidates += page.records.length;
      if (!input.dryRun) state.deleted += page.records.length;
      state.pages += 1;
      pagesThisRun += 1;
      if (page.nextCursor) state.cursors[collection] = page.nextCursor;
      else {
        state.collection_index += 1;
        delete state.cursors[collection];
      }
      state = await this.saveProgress(reference, state, ownerId, leaseMs, this.currentLeaseTime(input.now));
    }
    if (state.collection_index >= COLLECTIONS.length) {
      state.status = "completed";
      state = await this.saveProgress(reference, state, ownerId, leaseMs, this.currentLeaseTime(input.now));
    }
    await this.releaseLease(reference, ownerId, this.currentLeaseTime(input.now));
    return {
      runId: input.runId,
      status: state.status,
      dryRun: state.dry_run,
      candidates: state.candidates - startingCandidates,
      deleted: state.deleted - startingDeleted,
      totalCandidates: state.candidates,
      totalDeleted: state.deleted,
      pages: state.pages,
    };
  }
}

export function createScheduledRetentionCleanupHandler(input: {
  firestore: Firestore;
  readConfig?: () => RetentionCleanupRuntimeConfig | undefined;
  config?: RetentionCleanupRuntimeConfig;
  clock?: () => Date;
}): () => Promise<ReturnType<FirestoreRetentionCleanupService["run"]> extends Promise<infer T> ? T : never> {
  return async () => {
    const config = input.readConfig ? input.readConfig() : input.config;
    if (!config) throw new Error("Retention policy configuration is required");
    if (!config.runId || typeof config.dryRun !== "boolean") throw new Error("Retention policy configuration is required");
    const service = new FirestoreRetentionCleanupService(
      new FirestoreRetentionAdapter(input.firestore),
      configPolicy(config),
      input.clock ?? (() => new Date()),
    );
    return service.run({
      runId: config.runId,
      now: input.clock?.() ?? new Date(),
      dryRun: config.dryRun,
      maxPages: config.maxPages,
      ownerId: config.ownerId,
      leaseMs: config.leaseMs,
    });
  };
}

export const createRetentionCleanupScheduledHandler = createScheduledRetentionCleanupHandler;
