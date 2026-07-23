import { createHash } from "node:crypto";

import type {
  DocumentData,
  DocumentReference,
  Firestore,
  Query,
  Transaction,
} from "firebase-admin/firestore";

import {
  aggregateEvent,
  dateBucket,
  errorAggregateId,
} from "./aggregation";
import {
  aggregatePointerFromData,
  defaultAggregatePointer,
  ReplayOperationError,
  type AggregateGenerationPartition,
  type AggregatePointerDocument,
} from "./read-routing";
export { FirestoreAggregateGenerationReader, ReplayOperationError } from "./read-routing";
import type {
  DeadLetter,
  ErrorAggregate,
  PrincipalDailyAggregate,
  OperationState,
  StoredUsageEvent,
  UsageAggregatePointer,
  UsageDailyAggregate,
  UsageTransaction,
} from "./types";

const COLLECTIONS = {
  events: "usageEvents",
  daily: "toolUsageDaily",
  principal: "principalUsageDaily",
  errors: "errorAggregates",
  markers: "usageReplayAppliedEvents",
  jobs: "usageReplayJobs",
  locks: "usageReplayLocks",
  generations: "usageReplayGenerations",
  validationGroups: "usageReplayValidationGroups",
  revisions: "usageAggregateSourceRevisions",
  pointers: "usageAggregatePointers",
} as const;

const ACTIVE_POINTER_ID = "active";
const REPLAY_LOCK_ID = "aggregate-rebuild";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GENERATION = /^[a-z][a-z0-9._-]{0,63}$/;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const DEFAULT_LOCK_LEASE_MS = 60_000;
const MAX_REPLAY_DAYS = 366;

export interface ReplayWatermark {
  corrected_observed_at: string;
  server_received_at: string;
  event_id: string;
}

export interface ReplayValidationTotals {
  event_count: number;
  run_started: number;
  run_succeeded: number;
  run_failed: number;
  run_cancelled: number;
  run_interrupted: number;
  error_count: number;
  duration_total_ms: number;
  duration_count: number;
  duration_max_ms: number;
  principal_event_count: number;
  group_count: number;
  group_digest: string;
  principal_group_count: number;
  principal_group_digest: string;
  error_group_count: number;
  error_group_digest: string;
}

export interface ReplayValidation {
  matched: boolean;
  source: ReplayValidationTotals;
  shadow: ReplayValidationTotals;
  validated_at: string;
}

type ReplayStatus = "running" | "switched" | "rolled_back" | "finalized" | "failed";
type ReplayPhase = "prepare" | "scan" | "validating" | "switched" | "rolled_back" | "finalized" | "failed";
export type ReplayCutoverScope = "global" | "partition";

type ReplayValidationKind = "daily" | "principal" | "error";
type ReplayValidationSide = "source" | "shadow";
type ReplayValidationStage =
  | "source_daily"
  | "shadow_daily"
  | "source_principal"
  | "shadow_principal"
  | "source_error"
  | "shadow_error"
  | "complete";

interface ReplayValidationProgress {
  stage: ReplayValidationStage;
  cursor: string | null;
  source: ReplayValidationTotals;
  shadow: ReplayValidationTotals;
}

interface ReplayValidationGroupDocument {
  replay_id: string;
  generation: string;
  kind: ReplayValidationKind;
  group_key: string;
  event_count: number;
  run_started: number;
  run_succeeded: number;
  run_failed: number;
  run_cancelled: number;
  run_interrupted: number;
  duration_total_ms: number;
  duration_count: number;
  duration_max_ms: number;
  count: number;
  first_seen_at: string | null;
  recent_seen_at: string | null;
  summaries: Array<{ summary: string; count: number }>;
  updated_at: string;
}

interface ReplayJobDocument {
  replay_id: string;
  generation: string;
  from: string;
  to: string;
  status: ReplayStatus;
  phase: ReplayPhase;
  checkpoint: ReplayWatermark | null;
  catchup_fence: ReplayWatermark | null;
  catchup_source_revision: number | null;
  catchup_source_revisions: Record<string, number> | null;
  catchup_passes: number;
  processed: number;
  validation: ReplayValidation | null;
  validation_progress: ReplayValidationProgress | null;
  previous_generation: string | null;
  previous_partition_generation: string | null;
  previous_generation_partitions: AggregateGenerationPartition[];
  requested_cutover_scope: ReplayCutoverScope;
  cutover_scope: ReplayCutoverScope | null;
  started_at: string;
  updated_at: string;
  switched_at: string | null;
  rolled_back_at: string | null;
  finalized_at: string | null;
}

function hasActiveRollbackWindow(pointer: AggregatePointerDocument): boolean {
  return pointer.rollback_generation !== null
    || pointer.generation_partitions.some((partition) => partition.rollback_generation !== null);
}

interface ReplayLockDocument {
  owner_id: string;
  replay_id: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
}

interface ReplayGenerationClaim {
  generation: string;
  replay_id: string;
  claimed_at: string;
}

export interface FirestoreReplayRunInput {
  replayId: string;
  generation: string;
  from: Date;
  to: Date;
  ownerId: string;
  cutoverScope: ReplayCutoverScope;
  pageSize?: number;
  maxPages?: number;
}

export interface FirestoreReplayRunResult {
  replay_id: string;
  generation: string;
  status: ReplayStatus;
  checkpoint: ReplayWatermark | null;
  catchup_fence: ReplayWatermark | null;
  catchup_passes: number;
  processed: number;
  validation: ReplayValidation | null;
  previous_generation: string | null;
}

interface PrincipalGroupCounters {
  event_count: number;
  run_started: number;
  run_succeeded: number;
  run_failed: number;
  run_cancelled: number;
  run_interrupted: number;
}

function compareWatermark(left: ReplayWatermark, right: ReplayWatermark): number {
  if (left.corrected_observed_at !== right.corrected_observed_at) {
    return left.corrected_observed_at < right.corrected_observed_at ? -1 : 1;
  }
  if (left.server_received_at !== right.server_received_at) {
    return left.server_received_at < right.server_received_at ? -1 : 1;
  }
  if (left.event_id === right.event_id) return 0;
  return left.event_id < right.event_id ? -1 : 1;
}

function asWatermark(event: StoredUsageEvent): ReplayWatermark {
  return {
    corrected_observed_at: event.time_correction.corrected_observed_at,
    server_received_at: event.server_received_at,
    event_id: event.event_id,
  };
}

function isCompanyDayBoundary(value: Date): boolean {
  if (value.getUTCMilliseconds() !== 0) return false;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return fields.hour === "00" && fields.minute === "00" && fields.second === "00";
}

function nextDateBucket(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function replayDateBuckets(from: Date, to: Date): string[] {
  if (!isCompanyDayBoundary(from) || !isCompanyDayBoundary(to)) {
    throw new ReplayOperationError("replay_window_not_day_aligned", "Replay window must use company-time day boundaries");
  }
  const end = dateBucket(to.toISOString());
  const buckets: string[] = [];
  for (let current = dateBucket(from.toISOString()); current < end; current = nextDateBucket(current)) {
    buckets.push(current);
    if (buckets.length > MAX_REPLAY_DAYS) {
      throw new ReplayOperationError("replay_window_too_large", "Replay window exceeds the maximum date partitions");
    }
  }
  if (!buckets.length) throw new ReplayOperationError("invalid_replay_window", "Invalid replay window");
  return buckets;
}

function assertRunInput(input: FirestoreReplayRunInput): void {
  if (!IDENTIFIER.test(input.replayId)) {
    throw new ReplayOperationError("invalid_replay_id", "Invalid replay ID");
  }
  if (!GENERATION.test(input.generation) || input.generation === "online") {
    throw new ReplayOperationError("invalid_generation", "Invalid replay generation");
  }
  if (!IDENTIFIER.test(input.ownerId)) {
    throw new ReplayOperationError("invalid_owner_id", "Invalid replay owner ID");
  }
  if (!Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()) || input.from >= input.to) {
    throw new ReplayOperationError("invalid_replay_window", "Invalid replay window");
  }
  if (input.cutoverScope !== "global" && input.cutoverScope !== "partition") {
    throw new ReplayOperationError("invalid_cutover_scope", "Invalid replay cutover scope");
  }
  replayDateBuckets(input.from, input.to);
  if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > MAX_PAGE_SIZE)) {
    throw new ReplayOperationError("invalid_page_size", "Invalid replay page size");
  }
  if (input.maxPages !== undefined && (!Number.isInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > 100)) {
    throw new ReplayOperationError("invalid_max_pages", "Invalid maximum page count");
  }
}

function assertRollbackInput(input: { replayId: string; ownerId: string }): void {
  if (!IDENTIFIER.test(input.replayId) || !IDENTIFIER.test(input.ownerId)) {
    throw new ReplayOperationError("invalid_rollback_request", "Invalid rollback request");
  }
}

function toRunResult(job: ReplayJobDocument): FirestoreReplayRunResult {
  return {
    replay_id: job.replay_id,
    generation: job.generation,
    status: job.status,
    checkpoint: job.checkpoint,
    catchup_fence: job.catchup_fence,
    catchup_passes: job.catchup_passes,
    processed: job.processed,
    validation: job.validation,
    previous_generation: job.previous_generation,
  };
}

function incrementStatusCounters(counters: PrincipalGroupCounters, event: StoredUsageEvent): void {
  counters.event_count += 1;
  if (event.event_type === "run_started") counters.run_started += 1;
  if (event.event_type === "run_succeeded") counters.run_succeeded += 1;
  if (event.event_type === "run_failed") counters.run_failed += 1;
  if (event.event_type === "run_cancelled") counters.run_cancelled += 1;
  if (event.event_type === "run_interrupted") counters.run_interrupted += 1;
}

function sameValidation(left: ReplayValidationTotals, right: ReplayValidationTotals): boolean {
  return left.event_count === right.event_count
    && left.run_started === right.run_started
    && left.run_succeeded === right.run_succeeded
    && left.run_failed === right.run_failed
    && left.run_cancelled === right.run_cancelled
    && left.run_interrupted === right.run_interrupted
    && left.error_count === right.error_count
    && left.duration_total_ms === right.duration_total_ms
    && left.duration_count === right.duration_count
    && left.duration_max_ms === right.duration_max_ms
    && left.principal_event_count === right.principal_event_count
    && left.group_count === right.group_count
    && left.group_digest === right.group_digest
    && left.principal_group_count === right.principal_group_count
    && left.principal_group_digest === right.principal_group_digest
    && left.error_group_count === right.error_group_count
    && left.error_group_digest === right.error_group_digest;
}

function emptyValidationTotals(): ReplayValidationTotals {
  const emptyDigest = createHash("sha256").update("replay-validation-v1").digest("hex");
  return {
    event_count: 0,
    run_started: 0,
    run_succeeded: 0,
    run_failed: 0,
    run_cancelled: 0,
    run_interrupted: 0,
    error_count: 0,
    duration_total_ms: 0,
    duration_count: 0,
    duration_max_ms: 0,
    principal_event_count: 0,
    group_count: 0,
    group_digest: emptyDigest,
    principal_group_count: 0,
    principal_group_digest: emptyDigest,
    error_group_count: 0,
    error_group_digest: emptyDigest,
  };
}

function initialValidationProgress(): ReplayValidationProgress {
  return {
    stage: "source_daily",
    cursor: null,
    source: emptyValidationTotals(),
    shadow: emptyValidationTotals(),
  };
}

function nextValidationStage(stage: ReplayValidationStage): ReplayValidationStage {
  const stages: ReplayValidationStage[] = [
    "source_daily",
    "shadow_daily",
    "source_principal",
    "shadow_principal",
    "source_error",
    "shadow_error",
    "complete",
  ];
  return stages[Math.min(stages.indexOf(stage) + 1, stages.length - 1)];
}

function validationStageParts(stage: ReplayValidationStage): { side: ReplayValidationSide; kind: ReplayValidationKind } {
  if (stage === "complete") throw new ReplayOperationError("replay_validation_complete", "Replay validation is complete");
  const [side, kind] = stage.split("_") as [ReplayValidationSide, ReplayValidationKind];
  return { side, kind };
}

function chainedDigest(previous: string, groupKey: string, value: unknown): string {
  return createHash("sha256")
    .update(previous)
    .update("\u0000")
    .update(JSON.stringify([groupKey, value]))
    .digest("hex");
}

function validationGroupId(replayId: string, kind: ReplayValidationKind, groupKey: string): string {
  return `${replayId}|${kind}|${groupKey}`;
}

function updateValidationGroup(
  current: ReplayValidationGroupDocument | undefined,
  input: {
    replayId: string;
    generation: string;
    kind: ReplayValidationKind;
    groupKey: string;
    event: StoredUsageEvent;
    updatedAt: string;
  },
): ReplayValidationGroupDocument {
  const value: ReplayValidationGroupDocument = current ? {
    ...current,
    summaries: current.summaries.map((summary) => ({ ...summary })),
  } : {
    replay_id: input.replayId,
    generation: input.generation,
    kind: input.kind,
    group_key: input.groupKey,
    event_count: 0,
    run_started: 0,
    run_succeeded: 0,
    run_failed: 0,
    run_cancelled: 0,
    run_interrupted: 0,
    duration_total_ms: 0,
    duration_count: 0,
    duration_max_ms: 0,
    count: 0,
    first_seen_at: null,
    recent_seen_at: null,
    summaries: [],
    updated_at: input.updatedAt,
  };
  if (input.kind === "error") {
    const summary = input.event.error?.summary.slice(0, 512);
    value.count += 1;
    value.first_seen_at = value.first_seen_at && value.first_seen_at < input.event.server_received_at
      ? value.first_seen_at
      : input.event.server_received_at;
    value.recent_seen_at = value.recent_seen_at && value.recent_seen_at > input.event.server_received_at
      ? value.recent_seen_at
      : input.event.server_received_at;
    if (summary) {
      const existing = value.summaries.find((item) => item.summary === summary);
      if (existing) existing.count += 1;
      else if (value.summaries.length < 3) value.summaries.push({ summary, count: 1 });
    }
  } else {
    incrementStatusCounters(value, input.event);
    if (input.kind === "daily" && input.event.duration_ms !== undefined) {
      value.duration_total_ms += input.event.duration_ms;
      value.duration_count += 1;
      value.duration_max_ms = Math.max(value.duration_max_ms, input.event.duration_ms);
    }
  }
  value.updated_at = input.updatedAt;
  return value;
}

export class FirestoreReplayService {
  private readonly clock: () => Date;
  private readonly lockLeaseMs: number;

  public constructor(input: {
    firestore: Firestore;
    clock?: () => Date;
    lockLeaseMs?: number;
  }) {
    this.firestore = input.firestore;
    this.clock = input.clock ?? (() => new Date());
    this.lockLeaseMs = input.lockLeaseMs ?? DEFAULT_LOCK_LEASE_MS;
    if (!Number.isInteger(this.lockLeaseMs) || this.lockLeaseMs < 1_000 || this.lockLeaseMs > 900_000) {
      throw new ReplayOperationError("invalid_lock_lease", "Invalid replay lock lease");
    }
  }

  private readonly firestore: Firestore;

  public async run(input: FirestoreReplayRunInput): Promise<FirestoreReplayRunResult> {
    assertRunInput(input);
    const now = this.clock();
    await this.acquireLock(input.replayId, input.ownerId, now);
    try {
      let job = await this.initializeOrLoadJob(input, now);
      if (job.status !== "running") return toRunResult(job);
      const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
      const maxPages = input.maxPages ?? 10;
      let pages = 0;
      while (job.status === "running") {
        await this.renewLock(input.replayId, input.ownerId, this.clock());
        if (job.phase === "prepare") {
          job = await this.prepareCatchupPass(job, this.clock());
          continue;
        }
        if (job.phase === "scan") {
          if (pages >= maxPages) return toRunResult(job);
          const page = await this.listEventPage(job, pageSize);
          if (page.length === 0) {
            job = await this.setPhase(job.replay_id, "validating", this.clock());
            continue;
          }
          let applied = 0;
          for (const event of page) {
            await this.renewLock(input.replayId, input.ownerId, this.clock());
            if (await this.applyEvent(job.generation, job.replay_id, event)) applied += 1;
          }
          job = await this.checkpointPage(job.replay_id, asWatermark(page[page.length - 1]), applied, this.clock());
          pages += 1;
          continue;
        }
        if (job.phase === "validating") {
          if (await this.sourceRevisionChanged(job, this.clock())) {
            job = await this.resetForCatchup(job.replay_id, this.clock());
            continue;
          }
          if (job.validation_progress?.stage !== "complete") {
            if (pages >= maxPages) return toRunResult(job);
            job = await this.processValidationPage(job, pageSize, this.clock());
            pages += 1;
            if (pages >= maxPages) return toRunResult(job);
            continue;
          }
          if (!job.validation?.matched) {
            throw new ReplayOperationError("replay_validation_failed", "Replay validation failed");
          }
          const switched = await this.tryCutover(job.replay_id, input.ownerId, this.clock());
          job = switched ?? await this.resetForCatchup(job.replay_id, this.clock());
          continue;
        }
        return toRunResult(job);
      }
      return toRunResult(job);
    } catch (error) {
      if (error instanceof ReplayOperationError && error.code === "replay_validation_failed") {
        await this.markFailed(input.replayId, this.clock());
      }
      throw error;
    } finally {
      await this.releaseLock(input.replayId, input.ownerId, this.clock());
    }
  }

  public async rollback(input: { replayId: string; ownerId: string }): Promise<FirestoreReplayRunResult> {
    assertRollbackInput(input);
    const now = this.clock();
    await this.acquireLock(input.replayId, input.ownerId, now);
    try {
      const jobReference = this.firestore.collection(COLLECTIONS.jobs).doc(input.replayId);
      const pointerReference = this.firestore.collection(COLLECTIONS.pointers).doc(ACTIVE_POINTER_ID);
      const lockReference = this.firestore.collection(COLLECTIONS.locks).doc(REPLAY_LOCK_ID);
      const rolledBack = await this.firestore.runTransaction(async (transaction) => {
        const [jobSnapshot, pointerSnapshot, lockSnapshot] = await Promise.all([
          transaction.get(jobReference),
          transaction.get(pointerReference),
          transaction.get(lockReference),
        ]);
        if (!jobSnapshot.exists) throw new ReplayOperationError("replay_not_found", "Replay was not found");
        const job = jobSnapshot.data() as ReplayJobDocument;
        if (job.status === "rolled_back") return job;
        if (job.status !== "switched" || !job.previous_generation) {
          throw new ReplayOperationError("replay_not_switched", "Replay has not been switched");
        }
        this.assertHeldLock(lockSnapshot.data(), input.replayId, input.ownerId, now);
        const pointer = aggregatePointerFromData(pointerSnapshot.data(), now.toISOString());
        const updatedAt = now.toISOString();
        if (job.cutover_scope === "partition") {
          const partition = pointer.generation_partitions.find((item) => item.generation === job.generation && item.from === job.from && item.to === job.to);
          if (!partition || partition.rollback_generation !== job.previous_generation) {
            throw new ReplayOperationError("rollback_pointer_changed", "Aggregate partition no longer matches this replay");
          }
          const restoredPartitions = pointer.generation_partitions.filter((item) => item !== partition);
          if (job.previous_partition_generation) {
            restoredPartitions.push({
              from: job.from,
              to: job.to,
              generation: job.previous_partition_generation,
              rollback_generation: job.generation,
            });
          }
          transaction.set(pointerReference, {
            ...pointer,
            generation_partitions: restoredPartitions,
            write_generations: [...new Set([job.previous_generation, job.generation, ...pointer.write_generations])],
            updated_at: updatedAt,
          });
        } else {
          if (pointer.active_generation !== job.generation || pointer.rollback_generation !== job.previous_generation) {
            throw new ReplayOperationError("rollback_pointer_changed", "Aggregate pointer no longer matches this replay");
          }
          transaction.set(pointerReference, {
            ...pointer,
            active_generation: job.previous_generation,
            write_generations: [...new Set([
              job.previous_generation,
              job.generation,
              ...(job.previous_generation_partitions ?? []).map((partition) => partition.generation),
            ])],
            rollback_generation: job.generation,
            generation_partitions: (job.previous_generation_partitions ?? []).map((partition) => ({
              ...partition,
              rollback_generation: job.generation,
            })),
            updated_at: updatedAt,
          });
        }
        const updated: ReplayJobDocument = {
          ...job,
          status: "rolled_back",
          phase: "rolled_back",
          updated_at: updatedAt,
          rolled_back_at: updatedAt,
        };
        transaction.set(jobReference, updated);
        return updated;
      });
      return toRunResult(rolledBack);
    } finally {
      await this.releaseLock(input.replayId, input.ownerId, this.clock());
    }
  }

  public async finalize(input: { replayId: string; ownerId: string }): Promise<FirestoreReplayRunResult> {
    assertRollbackInput(input);
    const now = this.clock();
    await this.acquireLock(input.replayId, input.ownerId, now);
    try {
      const jobReference = this.firestore.collection(COLLECTIONS.jobs).doc(input.replayId);
      const pointerReference = this.firestore.collection(COLLECTIONS.pointers).doc(ACTIVE_POINTER_ID);
      const lockReference = this.firestore.collection(COLLECTIONS.locks).doc(REPLAY_LOCK_ID);
      const finalized = await this.firestore.runTransaction(async (transaction) => {
        const [jobSnapshot, pointerSnapshot, lockSnapshot] = await Promise.all([
          transaction.get(jobReference),
          transaction.get(pointerReference),
          transaction.get(lockReference),
        ]);
        if (!jobSnapshot.exists) throw new ReplayOperationError("replay_not_found", "Replay was not found");
        const job = jobSnapshot.data() as ReplayJobDocument;
        if (job.status === "finalized") return job;
        if ((job.status !== "switched" && job.status !== "rolled_back") || !job.previous_generation || !job.cutover_scope) {
          throw new ReplayOperationError("replay_not_finalizable", "Replay rollback window is not ready to finalize");
        }
        this.assertHeldLock(lockSnapshot.data(), input.replayId, input.ownerId, now);
        const pointer = aggregatePointerFromData(pointerSnapshot.data(), now.toISOString());
        let partitions = pointer.generation_partitions;
        let rollbackGeneration = pointer.rollback_generation;
        if (job.cutover_scope === "partition") {
          if (job.status === "switched") {
            const partition = partitions.find((item) => item.generation === job.generation && item.from === job.from && item.to === job.to);
            if (!partition || partition.rollback_generation !== job.previous_generation) {
              throw new ReplayOperationError("finalize_pointer_changed", "Aggregate partition no longer matches this replay");
            }
            partitions = partitions.map((item) => item === partition ? { ...item, rollback_generation: null } : item);
          } else {
            if (job.previous_partition_generation) {
              const restored = partitions.find((item) => (
                item.from === job.from
                && item.to === job.to
                && item.generation === job.previous_partition_generation
                && item.rollback_generation === job.generation
              ));
              if (!restored) throw new ReplayOperationError("finalize_pointer_changed", "Restored aggregate partition no longer matches this replay");
              partitions = partitions.map((item) => item === restored ? { ...item, rollback_generation: null } : item);
            } else {
              partitions = partitions.filter((item) => !(item.generation === job.generation && item.from === job.from && item.to === job.to));
            }
          }
        } else {
          const expectedActive = job.status === "switched" ? job.generation : job.previous_generation;
          const expectedRollback = job.status === "switched" ? job.previous_generation : job.generation;
          if (pointer.active_generation !== expectedActive || pointer.rollback_generation !== expectedRollback) {
            throw new ReplayOperationError("finalize_pointer_changed", "Aggregate pointer no longer matches this replay");
          }
          rollbackGeneration = null;
          if (job.status === "rolled_back") {
            partitions = partitions.map((partition) => ({ ...partition, rollback_generation: null }));
          }
        }
        const writeGenerations = [...new Set([
          pointer.active_generation,
          ...partitions.map((partition) => partition.generation),
          ...partitions.flatMap((partition) => partition.rollback_generation ? [partition.rollback_generation] : []),
          ...(rollbackGeneration ? [rollbackGeneration] : []),
        ])];
        const timestamp = now.toISOString();
        transaction.set(pointerReference, {
          ...pointer,
          generation_partitions: partitions,
          rollback_generation: rollbackGeneration,
          write_generations: writeGenerations,
          updated_at: timestamp,
        });
        const updated: ReplayJobDocument = {
          ...job,
          status: "finalized",
          phase: "finalized",
          finalized_at: timestamp,
          updated_at: timestamp,
        };
        transaction.set(jobReference, updated);
        return updated;
      });
      return toRunResult(finalized);
    } finally {
      await this.releaseLock(input.replayId, input.ownerId, this.clock());
    }
  }

  private async acquireLock(replayId: string, ownerId: string, now: Date): Promise<void> {
    const reference = this.firestore.collection(COLLECTIONS.locks).doc(REPLAY_LOCK_ID);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const current = snapshot.data() as ReplayLockDocument | undefined;
      if (current && current.released_at === null && Date.parse(current.expires_at) > now.getTime()
        && (current.owner_id !== ownerId || current.replay_id !== replayId)) {
        throw new ReplayOperationError("replay_lock_busy", "Another aggregate replay holds the lock");
      }
      transaction.set(reference, {
        owner_id: ownerId,
        replay_id: replayId,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.lockLeaseMs).toISOString(),
        released_at: null,
      } satisfies ReplayLockDocument);
    });
  }

  private async renewLock(replayId: string, ownerId: string, now: Date): Promise<void> {
    const reference = this.firestore.collection(COLLECTIONS.locks).doc(REPLAY_LOCK_ID);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      this.assertHeldLock(snapshot.data(), replayId, ownerId, now);
      transaction.update(reference, {
        expires_at: new Date(now.getTime() + this.lockLeaseMs).toISOString(),
      });
    });
  }

  private async releaseLock(replayId: string, ownerId: string, now: Date): Promise<void> {
    const reference = this.firestore.collection(COLLECTIONS.locks).doc(REPLAY_LOCK_ID);
    try {
      await this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        const lock = snapshot.data() as ReplayLockDocument | undefined;
        if (!lock || lock.owner_id !== ownerId || lock.replay_id !== replayId || lock.released_at !== null) return;
        transaction.update(reference, {
          expires_at: now.toISOString(),
          released_at: now.toISOString(),
        });
      });
    } catch {
      // A failed release remains recoverable through the persisted lease expiry.
    }
  }

  private assertHeldLock(data: DocumentData | undefined, replayId: string, ownerId: string, now: Date): void {
    const lock = data as ReplayLockDocument | undefined;
    if (!lock || lock.owner_id !== ownerId || lock.replay_id !== replayId || lock.released_at !== null || Date.parse(lock.expires_at) <= now.getTime()) {
      throw new ReplayOperationError("replay_lock_lost", "Aggregate replay lock was lost");
    }
  }

  private async initializeOrLoadJob(input: FirestoreReplayRunInput, now: Date): Promise<ReplayJobDocument> {
    const jobReference = this.firestore.collection(COLLECTIONS.jobs).doc(input.replayId);
    const generationReference = this.firestore.collection(COLLECTIONS.generations).doc(input.generation);
    const pointerReference = this.firestore.collection(COLLECTIONS.pointers).doc(ACTIVE_POINTER_ID);
    return this.firestore.runTransaction(async (transaction) => {
      const [jobSnapshot, generationSnapshot, pointerSnapshot] = await Promise.all([
        transaction.get(jobReference),
        transaction.get(generationReference),
        transaction.get(pointerReference),
      ]);
      const generationClaim = generationSnapshot.data() as ReplayGenerationClaim | undefined;
      if (generationClaim && generationClaim.replay_id !== input.replayId) {
        throw new ReplayOperationError("replay_generation_claimed", "Replay generation is already claimed");
      }
      if (jobSnapshot.exists) {
        const existing = jobSnapshot.data() as ReplayJobDocument;
        if (existing.generation !== input.generation || existing.from !== input.from.toISOString() || existing.to !== input.to.toISOString()
          || existing.requested_cutover_scope !== input.cutoverScope) {
          throw new ReplayOperationError("replay_definition_changed", "Replay definition is immutable after creation");
        }
        if (!generationSnapshot.exists) {
          transaction.create(generationReference, {
            generation: input.generation,
            replay_id: input.replayId,
            claimed_at: now.toISOString(),
          } satisfies ReplayGenerationClaim);
        }
        return existing;
      }
      const timestamp = now.toISOString();
      const job: ReplayJobDocument = {
        replay_id: input.replayId,
        generation: input.generation,
        from: input.from.toISOString(),
        to: input.to.toISOString(),
        status: "running",
        phase: "prepare",
        checkpoint: null,
        catchup_fence: null,
        catchup_source_revision: null,
        catchup_source_revisions: null,
        catchup_passes: 0,
        processed: 0,
        validation: null,
        validation_progress: null,
        previous_generation: null,
        previous_partition_generation: null,
        previous_generation_partitions: [],
        requested_cutover_scope: input.cutoverScope,
        cutover_scope: null,
        started_at: timestamp,
        updated_at: timestamp,
        switched_at: null,
        rolled_back_at: null,
        finalized_at: null,
      };
      transaction.create(jobReference, job);
      if (!generationSnapshot.exists) {
        transaction.create(generationReference, {
          generation: input.generation,
          replay_id: input.replayId,
          claimed_at: timestamp,
        } satisfies ReplayGenerationClaim);
      }
      if (!pointerSnapshot.exists) transaction.create(pointerReference, defaultAggregatePointer(timestamp));
      return job;
    });
  }

  private eventRangeQuery(job: ReplayJobDocument): Query<DocumentData> {
    let query: Query<DocumentData> = this.firestore.collection(COLLECTIONS.events)
      .where("time_correction.corrected_observed_at", ">=", job.from)
      .where("time_correction.corrected_observed_at", "<", job.to)
      .orderBy("time_correction.corrected_observed_at", "asc")
      .orderBy("server_received_at", "asc")
      .orderBy("event_id", "asc");
    if (job.catchup_fence) {
      query = query.endAt(
        job.catchup_fence.corrected_observed_at,
        job.catchup_fence.server_received_at,
        job.catchup_fence.event_id,
      );
    }
    return query;
  }

  private async prepareCatchupPass(job: ReplayJobDocument, now: Date): Promise<ReplayJobDocument> {
    const sourceState = await this.readSourceRevisionState(job);
    const fenceSnapshot = await this.firestore.collection(COLLECTIONS.events)
      .where("time_correction.corrected_observed_at", ">=", job.from)
      .where("time_correction.corrected_observed_at", "<", job.to)
      .orderBy("time_correction.corrected_observed_at", "asc")
      .orderBy("server_received_at", "asc")
      .orderBy("event_id", "asc")
      .limitToLast(1)
      .get();
    const fence = fenceSnapshot.empty
      ? null
      : asWatermark(fenceSnapshot.docs[0].data() as StoredUsageEvent);
    const reference = this.firestore.collection(COLLECTIONS.jobs).doc(job.replay_id);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new ReplayOperationError("replay_not_found", "Replay was not found");
      const current = snapshot.data() as ReplayJobDocument;
      if (current.status !== "running") return current;
      const updated: ReplayJobDocument = {
        ...current,
        phase: "scan",
        checkpoint: null,
        catchup_fence: fence,
        catchup_source_revision: sourceState.global,
        catchup_source_revisions: sourceState.partitions,
        catchup_passes: current.catchup_passes + 1,
        validation: null,
        validation_progress: null,
        updated_at: now.toISOString(),
      };
      transaction.set(reference, updated);
      return updated;
    });
  }

  private async listEventPage(job: ReplayJobDocument, pageSize: number): Promise<StoredUsageEvent[]> {
    if (!job.catchup_fence) return [];
    let query = this.eventRangeQuery(job);
    if (job.checkpoint) {
      query = query.startAfter(
        job.checkpoint.corrected_observed_at,
        job.checkpoint.server_received_at,
        job.checkpoint.event_id,
      );
    }
    const snapshot = await query.limit(pageSize).get();
    return snapshot.docs.map((document) => document.data() as StoredUsageEvent);
  }

  private async applyEvent(generation: string, replayId: string, event: StoredUsageEvent): Promise<boolean> {
    const markerReference = this.firestore.collection(COLLECTIONS.markers).doc(`${generation}|${event.event_id}`);
    const bucket = dateBucket(event.time_correction.corrected_observed_at);
    const groups: Array<{ kind: ReplayValidationKind; key: string; reference: DocumentReference<DocumentData> }> = [
      {
        kind: "daily",
        key: `${bucket}|${event.plugin_principal_id}|${event.tool_key}|${event.action_key}`,
        reference: this.firestore.collection(COLLECTIONS.validationGroups).doc(
          validationGroupId(replayId, "daily", `${bucket}|${event.plugin_principal_id}|${event.tool_key}|${event.action_key}`),
        ),
      },
      {
        kind: "principal",
        key: `${bucket}|${event.plugin_principal_id}`,
        reference: this.firestore.collection(COLLECTIONS.validationGroups).doc(
          validationGroupId(replayId, "principal", `${bucket}|${event.plugin_principal_id}`),
        ),
      },
    ];
    const validationErrorId = errorAggregateId(event, "validation");
    if (validationErrorId && event.error) {
      const key = validationErrorId.split("|").slice(1).join("|");
      groups.push({
        kind: "error",
        key,
        reference: this.firestore.collection(COLLECTIONS.validationGroups).doc(validationGroupId(replayId, "error", key)),
      });
    }
    return this.firestore.runTransaction(async (firestoreTransaction) => {
      const [marker, ...groupSnapshots] = await Promise.all([
        firestoreTransaction.get(markerReference),
        ...groups.map((group) => firestoreTransaction.get(group.reference)),
      ]);
      if (marker.exists) return false;
      const transaction = this.aggregateTransaction(firestoreTransaction);
      await aggregateEvent(transaction, event, generation);
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const current = groupSnapshots[index].exists
          ? groupSnapshots[index].data() as ReplayValidationGroupDocument
          : undefined;
        firestoreTransaction.set(group.reference, updateValidationGroup(current, {
          replayId,
          generation,
          kind: group.kind,
          groupKey: group.key,
          event,
          updatedAt: this.clock().toISOString(),
        }));
      }
      firestoreTransaction.create(markerReference, {
        generation,
        replay_id: replayId,
        event_id: event.event_id,
        corrected_observed_at: event.time_correction.corrected_observed_at,
        server_received_at: event.server_received_at,
        applied_at: this.clock().toISOString(),
      });
      return true;
    });
  }

  private aggregateTransaction(firestoreTransaction: Transaction): UsageTransaction {
    const read = async <T>(collection: string, id: string): Promise<T | undefined> => {
      const snapshot = await firestoreTransaction.get(this.firestore.collection(collection).doc(id));
      return snapshot.exists ? snapshot.data() as T : undefined;
    };
    return {
      getUsageEvent: (id) => read<StoredUsageEvent>(COLLECTIONS.events, id),
      putUsageEvent: async () => {
        throw new ReplayOperationError("replay_raw_write_forbidden", "Replay cannot write raw events");
      },
      getEventReservation: async () => undefined,
      putEventReservation: async () => {
        throw new ReplayOperationError("replay_reservation_write_forbidden", "Replay cannot write event reservations");
      },
      deleteEventReservation: async () => {
        throw new ReplayOperationError("replay_reservation_write_forbidden", "Replay cannot delete event reservations");
      },
      getDailyAggregate: (id) => read<UsageDailyAggregate>(COLLECTIONS.daily, id),
      putDailyAggregate: async (value) => {
        firestoreTransaction.set(this.firestore.collection(COLLECTIONS.daily).doc(value.id), value);
      },
      getPrincipalAggregate: (id) => read<PrincipalDailyAggregate>(COLLECTIONS.principal, id),
      putPrincipalAggregate: async (value) => {
        firestoreTransaction.set(this.firestore.collection(COLLECTIONS.principal).doc(value.id), value);
      },
      getErrorAggregate: (id) => read<ErrorAggregate>(COLLECTIONS.errors, id),
      putErrorAggregate: async (value) => {
        firestoreTransaction.set(this.firestore.collection(COLLECTIONS.errors).doc(value.id), value);
      },
      getOperation: (id) => read<OperationState>("usageOperations", id),
      putOperation: async () => {
        throw new ReplayOperationError("replay_operation_write_forbidden", "Replay cannot write operation state");
      },
      getDeadLetter: (id) => read<DeadLetter>("deadLetters", id),
      putDeadLetter: async (_value: DeadLetter) => {
        throw new ReplayOperationError("replay_dead_letter_write_forbidden", "Replay cannot write dead letters");
      },
      getAggregatePointer: (id) => read<UsageAggregatePointer>(COLLECTIONS.pointers, id),
      putAggregatePointer: async () => {
        throw new ReplayOperationError("replay_pointer_write_forbidden", "Replay aggregation cannot update the active pointer");
      },
      getAggregateSourceRevision: async () => undefined,
      putAggregateSourceRevision: async () => {
        throw new ReplayOperationError("replay_revision_write_forbidden", "Replay aggregation cannot update source revisions");
      },
    };
  }

  private async checkpointPage(replayId: string, checkpoint: ReplayWatermark, applied: number, now: Date): Promise<ReplayJobDocument> {
    const reference = this.firestore.collection(COLLECTIONS.jobs).doc(replayId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new ReplayOperationError("replay_not_found", "Replay was not found");
      const job = snapshot.data() as ReplayJobDocument;
      if (job.status !== "running" || job.phase !== "scan") return job;
      if (job.checkpoint && compareWatermark(job.checkpoint, checkpoint) >= 0) return job;
      const updated: ReplayJobDocument = {
        ...job,
        checkpoint,
        processed: job.processed + applied,
        updated_at: now.toISOString(),
      };
      transaction.set(reference, updated);
      return updated;
    });
  }

  private async setPhase(replayId: string, phase: ReplayPhase, now: Date): Promise<ReplayJobDocument> {
    const reference = this.firestore.collection(COLLECTIONS.jobs).doc(replayId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new ReplayOperationError("replay_not_found", "Replay was not found");
      const job = snapshot.data() as ReplayJobDocument;
      const updated = {
        ...job,
        phase,
        validation_progress: phase === "validating" ? initialValidationProgress() : job.validation_progress,
        updated_at: now.toISOString(),
      };
      transaction.set(reference, updated);
      return updated;
    });
  }

  private async readSourceRevisionState(job: ReplayJobDocument): Promise<{
    global: number | null;
    partitions: Record<string, number> | null;
  }> {
    if (job.requested_cutover_scope === "global") {
      const pointer = aggregatePointerFromData(
        (await this.firestore.collection(COLLECTIONS.pointers).doc(ACTIVE_POINTER_ID).get()).data(),
        this.clock().toISOString(),
      );
      return { global: pointer.source_revision, partitions: null };
    }
    const dates = replayDateBuckets(new Date(job.from), new Date(job.to));
    const snapshots = await Promise.all(
      dates.map((date) => this.firestore.collection(COLLECTIONS.revisions).doc(date).get()),
    );
    return {
      global: null,
      partitions: Object.fromEntries(snapshots.map((snapshot, index) => [
        dates[index],
        Number(snapshot.data()?.revision ?? 0),
      ])),
    };
  }

  private async sourceRevisionChanged(job: ReplayJobDocument, now: Date): Promise<boolean> {
    void now;
    const current = await this.readSourceRevisionState(job);
    if (job.requested_cutover_scope === "global") return current.global !== job.catchup_source_revision;
    return JSON.stringify(current.partitions) !== JSON.stringify(job.catchup_source_revisions);
  }

  private validationQuery(job: ReplayJobDocument, stage: ReplayValidationStage): Query<DocumentData> {
    const { side, kind } = validationStageParts(stage);
    if (side === "source") {
      return this.firestore.collection(COLLECTIONS.validationGroups)
        .where("replay_id", "==", job.replay_id)
        .where("kind", "==", kind)
        .orderBy("__name__", "asc");
    }
    const collection = kind === "daily"
      ? COLLECTIONS.daily
      : kind === "principal"
        ? COLLECTIONS.principal
        : COLLECTIONS.errors;
    return this.firestore.collection(collection)
      .where("generation", "==", job.generation)
      .orderBy("__name__", "asc");
  }

  private accumulateValidationDocument(
    totals: ReplayValidationTotals,
    kind: ReplayValidationKind,
    groupKey: string,
    data: DocumentData,
  ): void {
    if (kind === "daily") {
      const [date, pluginPrincipalId, toolKey, actionKey] = groupKey.split("|");
      const value = {
        date: String(data.date ?? date),
        plugin_principal_id: String(data.plugin_principal_id ?? pluginPrincipalId),
        tool_key: String(data.tool_key ?? toolKey),
        action_key: String(data.action_key ?? actionKey),
        event_count: Number(data.event_count ?? 0),
        run_started: Number(data.run_started ?? 0),
        run_succeeded: Number(data.run_succeeded ?? 0),
        run_failed: Number(data.run_failed ?? 0),
        run_cancelled: Number(data.run_cancelled ?? 0),
        run_interrupted: Number(data.run_interrupted ?? 0),
        duration_total_ms: Number(data.duration_total_ms ?? 0),
        duration_count: Number(data.duration_count ?? 0),
        duration_max_ms: Number(data.duration_max_ms ?? 0),
      };
      totals.event_count += value.event_count;
      totals.run_started += value.run_started;
      totals.run_succeeded += value.run_succeeded;
      totals.run_failed += value.run_failed;
      totals.run_cancelled += value.run_cancelled;
      totals.run_interrupted += value.run_interrupted;
      totals.duration_total_ms += value.duration_total_ms;
      totals.duration_count += value.duration_count;
      totals.duration_max_ms = Math.max(totals.duration_max_ms, value.duration_max_ms);
      totals.group_count += 1;
      totals.group_digest = chainedDigest(totals.group_digest, groupKey, value);
      return;
    }
    if (kind === "principal") {
      const [date, pluginPrincipalId] = groupKey.split("|");
      const value = {
        date: String(data.date ?? date),
        plugin_principal_id: String(data.plugin_principal_id ?? pluginPrincipalId),
        event_count: Number(data.event_count ?? 0),
        run_started: Number(data.run_started ?? 0),
        run_succeeded: Number(data.run_succeeded ?? 0),
        run_failed: Number(data.run_failed ?? 0),
        run_cancelled: Number(data.run_cancelled ?? 0),
        run_interrupted: Number(data.run_interrupted ?? 0),
      };
      totals.principal_event_count += value.event_count;
      totals.principal_group_count += 1;
      totals.principal_group_digest = chainedDigest(totals.principal_group_digest, groupKey, value);
      return;
    }
    const summaries = Array.isArray(data.summaries)
      ? data.summaries.map((summary: { summary?: unknown; count?: unknown }) => ({
        summary: String(summary.summary ?? ""),
        count: Number(summary.count ?? 0),
      })).sort((left: { summary: string }, right: { summary: string }) => left.summary.localeCompare(right.summary))
      : [];
    const [date, toolKey, actionKey, errorCategory, fingerprint, pluginVersion] = groupKey.split("|");
    const value = {
      date: String(data.date ?? date),
      tool_key: String(data.tool_key ?? toolKey),
      action_key: String(data.action_key ?? actionKey),
      error_category: String(data.error_category ?? errorCategory),
      fingerprint: String(data.fingerprint ?? fingerprint),
      plugin_version: String(data.plugin_version ?? pluginVersion),
      count: Number(data.count ?? 0),
      first_seen_at: String(data.first_seen_at ?? ""),
      recent_seen_at: String(data.recent_seen_at ?? ""),
      summaries,
    };
    totals.error_count += value.count;
    totals.error_group_count += 1;
    totals.error_group_digest = chainedDigest(totals.error_group_digest, groupKey, value);
  }

  private async processValidationPage(job: ReplayJobDocument, pageSize: number, now: Date): Promise<ReplayJobDocument> {
    const progress = job.validation_progress ?? initialValidationProgress();
    if (progress.stage === "complete") return job;
    const { side, kind } = validationStageParts(progress.stage);
    let query = this.validationQuery(job, progress.stage);
    if (progress.cursor) query = query.startAfter(progress.cursor);
    const snapshot = await query.limit(pageSize).get();
    const totals = { ...progress[side] };
    for (const document of snapshot.docs) {
      const data = document.data();
      const groupKey = side === "source"
        ? String(data.group_key ?? "")
        : document.id.split("|").slice(1).join("|");
      this.accumulateValidationDocument(totals, kind, groupKey, data);
    }
    const stageFinished = snapshot.size < pageSize;
    const updatedProgress: ReplayValidationProgress = {
      ...progress,
      stage: stageFinished ? nextValidationStage(progress.stage) : progress.stage,
      cursor: stageFinished ? null : snapshot.docs[snapshot.docs.length - 1].id,
      [side]: totals,
    };
    const validation = updatedProgress.stage === "complete"
      ? {
        matched: sameValidation(updatedProgress.source, updatedProgress.shadow),
        source: updatedProgress.source,
        shadow: updatedProgress.shadow,
        validated_at: now.toISOString(),
      } satisfies ReplayValidation
      : null;
    const reference = this.firestore.collection(COLLECTIONS.jobs).doc(job.replay_id);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new ReplayOperationError("replay_not_found", "Replay was not found");
      const current = snapshot.data() as ReplayJobDocument;
      const currentProgress = current.validation_progress ?? initialValidationProgress();
      if (current.status !== "running" || current.phase !== "validating") return current;
      if (currentProgress.stage !== progress.stage || currentProgress.cursor !== progress.cursor) return current;
      const updated: ReplayJobDocument = {
        ...current,
        validation_progress: updatedProgress,
        validation: validation ?? current.validation,
        updated_at: now.toISOString(),
      };
      transaction.set(reference, updated);
      return updated;
    });
  }

  private async tryCutover(replayId: string, ownerId: string, now: Date): Promise<ReplayJobDocument | null> {
    const jobReference = this.firestore.collection(COLLECTIONS.jobs).doc(replayId);
    const pointerReference = this.firestore.collection(COLLECTIONS.pointers).doc(ACTIVE_POINTER_ID);
    const lockReference = this.firestore.collection(COLLECTIONS.locks).doc(REPLAY_LOCK_ID);
    const initialJob = (await jobReference.get()).data() as ReplayJobDocument | undefined;
    if (!initialJob) throw new ReplayOperationError("replay_not_found", "Replay was not found");
    if (await this.sourceRevisionChanged(initialJob, now)) return null;
    return this.firestore.runTransaction(async (transaction) => {
      const [jobSnapshot, pointerSnapshot, lockSnapshot] = await Promise.all([
        transaction.get(jobReference),
        transaction.get(pointerReference),
        transaction.get(lockReference),
      ]);
      if (!jobSnapshot.exists) throw new ReplayOperationError("replay_not_found", "Replay was not found");
      const job = jobSnapshot.data() as ReplayJobDocument;
      if (job.status !== "running" || !job.validation?.matched || job.validation_progress?.stage !== "complete") {
        throw new ReplayOperationError("replay_not_ready", "Replay is not ready for cutover");
      }
      this.assertHeldLock(lockSnapshot.data(), replayId, ownerId, now);
      const pointer = aggregatePointerFromData(pointerSnapshot.data(), now.toISOString());
      if (hasActiveRollbackWindow(pointer)) {
        throw new ReplayOperationError("replay_rollback_window_active", "An aggregate rollback window is already open");
      }
      if (job.requested_cutover_scope === "global") {
        if (job.catchup_source_revision === null || pointer.source_revision !== job.catchup_source_revision) return null;
        if (pointer.generation_partitions.some((partition) => partition.from < job.from || partition.to > job.to)) {
          throw new ReplayOperationError("replay_global_window_incomplete", "Global replay window does not cover every active aggregate partition");
        }
        const dates = replayDateBuckets(new Date(job.from), new Date(job.to));
        const firstDate = dates[0];
        const afterLastDate = nextDateBucket(dates[dates.length - 1]);
        const aggregateCollections = [COLLECTIONS.daily, COLLECTIONS.principal, COLLECTIONS.errors];
        const outsideQueries: Query<DocumentData>[] = aggregateCollections.flatMap((collection) => [
          this.firestore.collection(collection)
            .where("generation", "==", pointer.active_generation)
            .where("date", "<", firstDate)
            .limit(1),
          this.firestore.collection(collection)
            .where("generation", "==", pointer.active_generation)
            .where("date", ">=", afterLastDate)
            .limit(1),
        ]);
        const outsideSnapshots = await Promise.all(outsideQueries.map((query) => transaction.get(query)));
        if (outsideSnapshots.some((snapshot) => !snapshot.empty)) {
          throw new ReplayOperationError("replay_global_window_incomplete", "Global replay window does not cover readable aggregate history");
        }
      } else {
        if (!job.catchup_source_revisions) throw new ReplayOperationError("replay_not_ready", "Replay is not ready for cutover");
        const dates = replayDateBuckets(new Date(job.from), new Date(job.to));
        const revisions = await Promise.all(
          dates.map((date) => transaction.get(this.firestore.collection(COLLECTIONS.revisions).doc(date))),
        );
        const changed = revisions.some((snapshot, index) => (
          Number(snapshot.data()?.revision ?? 0) !== job.catchup_source_revisions?.[dates[index]]
        ));
        if (changed) return null;
      }
      const timestamp = now.toISOString();
      let previousGeneration = pointer.active_generation;
      let previousPartitionGeneration: string | null = null;
      const previousGenerationPartitions = pointer.generation_partitions;
      if (job.requested_cutover_scope === "partition") {
        const replacedPartition = pointer.generation_partitions.find((partition) => partition.from === job.from && partition.to === job.to);
        const overlaps = pointer.generation_partitions.some((partition) => (
          partition !== replacedPartition
          && partition.from < job.to
          && partition.to > job.from
          && partition.generation !== job.generation
        ));
        if (overlaps) throw new ReplayOperationError("replay_partition_overlap", "Replay partition overlaps an active generation");
        if (replacedPartition) {
          previousGeneration = replacedPartition.generation;
          previousPartitionGeneration = replacedPartition.generation;
        }
        transaction.set(pointerReference, {
          ...pointer,
          write_generations: [...new Set([...pointer.write_generations, job.generation])],
          generation_partitions: [
            ...pointer.generation_partitions.filter((partition) => (
              partition.generation !== job.generation
              && !(partition.from === job.from && partition.to === job.to)
            )),
            { from: job.from, to: job.to, generation: job.generation, rollback_generation: previousGeneration },
          ],
          updated_at: timestamp,
        });
      } else {
        transaction.set(pointerReference, {
          ...pointer,
          active_generation: job.generation,
          write_generations: previousGeneration === job.generation
            ? [job.generation]
            : [job.generation, previousGeneration],
          rollback_generation: previousGeneration === job.generation ? pointer.rollback_generation : previousGeneration,
          generation_partitions: [],
          updated_at: timestamp,
        });
      }
      const updated: ReplayJobDocument = {
        ...job,
        status: "switched",
        phase: "switched",
        previous_generation: previousGeneration,
        previous_partition_generation: previousPartitionGeneration,
        previous_generation_partitions: previousGenerationPartitions,
        cutover_scope: job.requested_cutover_scope,
        switched_at: timestamp,
        updated_at: timestamp,
      };
      transaction.set(jobReference, updated);
      return updated;
    });
  }

  private async resetForCatchup(replayId: string, now: Date): Promise<ReplayJobDocument> {
    const reference = this.firestore.collection(COLLECTIONS.jobs).doc(replayId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new ReplayOperationError("replay_not_found", "Replay was not found");
      const job = snapshot.data() as ReplayJobDocument;
      const updated: ReplayJobDocument = {
        ...job,
        phase: "prepare",
        checkpoint: null,
        catchup_fence: null,
        catchup_source_revision: null,
        catchup_source_revisions: null,
        validation: null,
        validation_progress: null,
        updated_at: now.toISOString(),
      };
      transaction.set(reference, updated);
      return updated;
    });
  }

  private async markFailed(replayId: string, now: Date): Promise<void> {
    const reference = this.firestore.collection(COLLECTIONS.jobs).doc(replayId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return;
      const job = snapshot.data() as ReplayJobDocument;
      if (job.status !== "running") return;
      transaction.set(reference, {
        ...job,
        status: "failed",
        phase: "failed",
        updated_at: now.toISOString(),
      } satisfies ReplayJobDocument);
    });
  }
}
