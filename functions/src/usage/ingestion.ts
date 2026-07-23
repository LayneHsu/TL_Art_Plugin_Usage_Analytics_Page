import { createHash } from "node:crypto";

import type { Clock } from "../plugin-auth/types";
import { aggregateEventsToGenerations, dateBucket } from "./aggregation";
import { boundedDiagnostic } from "./redaction";
import { TokenBucketRateLimiter } from "./rate-limit";
import { InMemoryUsageStore } from "./store";
import type {
  BatchIngestionResult,
  ClientUsageEvent,
  DeadLetter,
  EventResult,
  RateLimitConfiguration,
  ToolRegistry,
  UsageAuth,
  UsageIngestionRequest,
  UsageStore,
  OperationState,
  UsageQuota,
  UsageAggregatePointer,
  UsageAggregateWatermark,
  StoredUsageEvent,
} from "./types";
import { validateClientEvent } from "./validation";
import { validateRegistryAgainstAuthoritativeSchema } from "./contract-artifacts";

export const MAX_BATCH_EVENTS = 100;

export class UsageIngestionError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "UsageIngestionError";
  }
}

function deadLetterId(eventId: string | null, reason: string, bindingId: string, principalId: string): string {
  return `dl_${createHash("sha256").update(`${eventId ?? "batch"}\u0000${reason}\u0000${bindingId}\u0000${principalId}`).digest("hex")}`;
}

function operationDocumentId(principalId: string, bindingId: string, operationId: string): string {
  return `op_${createHash("sha256").update(`${principalId}\u0000${bindingId}\u0000${operationId}`).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clientPayloadDigest(event: ClientUsageEvent | StoredUsageEvent): string {
  const { plugin_principal_id: _principal, server_received_at: _received, time_correction: _correction, ...clientPayload } = event as StoredUsageEvent;
  return createHash("sha256").update(canonicalJson(clientPayload)).digest("hex");
}

function defaultAggregatePointer(now: string): UsageAggregatePointer {
  return {
    id: "active",
    active_generation: "online",
    write_generations: ["online"],
    rollback_generation: null,
    source_revision: 0,
    source_watermark: null,
    updated_at: now,
  };
}

function compareWatermark(
  left: UsageAggregateWatermark,
  right: UsageAggregateWatermark,
): number {
  if (left.corrected_observed_at !== right.corrected_observed_at) {
    return left.corrected_observed_at < right.corrected_observed_at ? -1 : 1;
  }
  if (left.server_received_at !== right.server_received_at) {
    return left.server_received_at < right.server_received_at ? -1 : 1;
  }
  if (left.event_id === right.event_id) return 0;
  return left.event_id < right.event_id ? -1 : 1;
}

function acceptedGenerations(pointer: UsageAggregatePointer, correctedObservedAt: string): string[] {
  const matching = (pointer.generation_partitions ?? []).filter(
    (partition) => partition.from <= correctedObservedAt && correctedObservedAt < partition.to,
  );
  if (matching.length > 1) throw new Error("Overlapping aggregate generation partitions");
  if (matching.length === 1) {
    const partition = matching[0];
    return [...new Set([
      partition.generation,
      ...(partition.rollback_generation ? [partition.rollback_generation] : []),
    ])];
  }
  return [...new Set([
    pointer.active_generation || "online",
    ...(pointer.rollback_generation ? [pointer.rollback_generation] : []),
  ])];
}

function resultCounts(results: EventResult[]): BatchIngestionResult {
  return {
    results,
    accepted: results.filter((item) => item.status === "confirmed" && item.code !== "duplicate").length,
    duplicates: results.filter((item) => item.code === "duplicate").length,
    retryable: results.filter((item) => item.status === "retryable").length,
    permanent_rejected: results.filter((item) => item.status === "permanent_rejected").length,
  };
}

export class UsageIngestionService {
  public readonly auth: UsageAuth;
  public readonly store: UsageStore;
  private readonly limiter: TokenBucketRateLimiter;
  private readonly clock: Clock;
  private readonly registry: ToolRegistry;
  private readonly allowDraftForTests: boolean;
  private readonly quota?: UsageQuota;

  public constructor(input: {
    auth: UsageAuth;
    store?: UsageStore;
    clock: Clock;
    registry: ToolRegistry;
    allowDraftForTests?: boolean;
    rateLimit?: RateLimitConfiguration;
    quota?: UsageQuota;
  }) {
    this.auth = input.auth;
    this.store = input.store ?? new InMemoryUsageStore();
    this.clock = input.clock;
    this.registry = input.registry;
    const registryValidation = validateRegistryAgainstAuthoritativeSchema(this.registry);
    if (!registryValidation.valid) throw new Error("Invalid usage tool registry");
    this.allowDraftForTests = input.allowDraftForTests === true;
    this.quota = input.quota;
    this.limiter = new TokenBucketRateLimiter(input.rateLimit ?? { capacity: 1000, refillPerSecond: 1000 / 60 });
  }

  public async ingestBatch(request: UsageIngestionRequest): Promise<BatchIngestionResult> {
    this.assertRequestShape(request);
    const claims = await this.auth.authorizeEvent({
      leaseToken: request.lease_token,
      queueBindingId: request.queue_binding_id,
    });
    if (request.events.length > MAX_BATCH_EVENTS) {
      throw new UsageIngestionError("batch_too_large", false, "Batch exceeds the maximum event count");
    }
    const exactDuplicateIndexes = await this.findExactDuplicateIndexes(request.events, claims.pluginPrincipalId);
    const limitedEventCount = request.events.filter((event, index) => (
      typeof event?.event_id !== "string" || !exactDuplicateIndexes.has(index)
    )).length;
    if (this.quota && limitedEventCount > 0) {
      const quota = await this.quota.consume({ bindingId: claims.bindingId, pluginPrincipalId: claims.pluginPrincipalId, eventCount: limitedEventCount, now: this.clock.now() });
      if (!quota.allowed) {
        const limited = resultCounts(request.events.map((event, index) => {
          const eventId = typeof event?.event_id === "string" ? event.event_id : null;
          return eventId && exactDuplicateIndexes.has(index)
            ? { event_id: eventId, status: "confirmed" as const, code: "duplicate" }
            : { event_id: eventId, status: "retryable" as const, code: "quota_exceeded", retry_after_seconds: quota.retryAfterSeconds, retry_policy: "exponential_jitter_until_lease_expiry" as const };
        }));
        return { ...limited, lease_expires_at: new Date(claims.expiresAtSeconds * 1000).toISOString(), renewal_recommended: claims.expiresAtSeconds * 1000 - this.clock.now().getTime() <= 300_000 };
      }
    }
    const rateDecision = this.limiter.check(`${claims.pluginPrincipalId}:${claims.bindingId}`, limitedEventCount);
    if (!rateDecision.allowed) {
      const limited = resultCounts(request.events.map((event, index) => {
        const eventId = typeof event?.event_id === "string" ? event.event_id : null;
        return eventId && exactDuplicateIndexes.has(index)
          ? { event_id: eventId, status: "confirmed" as const, code: "duplicate" }
          : {
            event_id: eventId,
            status: "retryable" as const,
            code: "rate_limited",
            retry_after_seconds: rateDecision.retryAfterSeconds,
            retry_policy: "exponential_jitter_until_lease_expiry" as const,
          };
      }));
      return {
        ...limited,
        lease_expires_at: new Date(claims.expiresAtSeconds * 1000).toISOString(),
        renewal_recommended: claims.expiresAtSeconds * 1000 - this.clock.now().getTime() <= 300_000,
      };
    }
    const results: EventResult[] = [];
    for (const rawEvent of request.events) {
      results.push(await this.ingestOne(rawEvent, claims));
    }
    const result = resultCounts(results);
    return {
      ...result,
      lease_expires_at: new Date(claims.expiresAtSeconds * 1000).toISOString(),
      renewal_recommended: claims.expiresAtSeconds * 1000 - this.clock.now().getTime() <= 300_000,
    };
  }

  private async findExactDuplicateIndexes(events: ClientUsageEvent[], pluginPrincipalId: string): Promise<Set<number>> {
    const candidates = new Map<string, ClientUsageEvent>();
    for (const event of events) {
      if (event && typeof event.event_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.event_id)) {
        candidates.set(event.event_id, event);
      }
    }
    if (!candidates.size) return new Set();
    return this.store.runTransaction(async (transaction) => {
      const existingById = new Map<string, StoredUsageEvent | undefined>();
      const reservationsById = new Map<string, Awaited<ReturnType<typeof transaction.getEventReservation>>>();
      for (const eventId of candidates.keys()) {
        existingById.set(eventId, await transaction.getUsageEvent(eventId));
        reservationsById.set(eventId, await transaction.getEventReservation(eventId));
      }
      const duplicates = new Set<number>();
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const eventId = typeof event?.event_id === "string" ? event.event_id : null;
        if (!eventId) continue;
        const existing = existingById.get(eventId);
        const reservation = reservationsById.get(eventId);
        if ((existing?.plugin_principal_id === pluginPrincipalId && clientPayloadDigest(existing) === clientPayloadDigest(event))
          || (reservation?.plugin_principal_id === pluginPrincipalId && reservation.payload_digest === clientPayloadDigest(event))) {
          duplicates.add(index);
        }
      }
      return duplicates;
    });
  }

  private async ingestOne(
    rawEvent: ClientUsageEvent,
    claims: { bindingId: string; pluginPrincipalId: string },
  ): Promise<EventResult> {
    const serverReceivedAt = this.clock.now();
    const validation = validateClientEvent({
      event: rawEvent,
      registry: this.registry,
      expectedBindingId: claims.bindingId,
      now: serverReceivedAt,
      allowDraftForTests: this.allowDraftForTests,
    });
    const eventId = rawEvent && typeof rawEvent.event_id === "string" && rawEvent.event_id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(rawEvent.event_id) ? rawEvent.event_id : null;
    if (!validation.ok) {
      await this.writeDeadLetter({
        eventId,
        bindingId: claims.bindingId,
        principalId: claims.pluginPrincipalId,
        serverReceivedAt,
        reason: validation.code,
        classification: "permanent",
        field: validation.field,
        diagnostic: validation.diagnostic,
      });
      return { event_id: eventId, status: "permanent_rejected", code: validation.code };
    }
    const stored = {
      ...validation.event,
      plugin_principal_id: claims.pluginPrincipalId,
      server_received_at: serverReceivedAt.toISOString(),
      time_correction: validation.correction,
    };
    try {
      const outcome = await this.store.runTransaction(async (transaction) => {
        const existing = await transaction.getUsageEvent(stored.event_id);
        if (existing) {
          if (existing.plugin_principal_id !== stored.plugin_principal_id || clientPayloadDigest(existing) !== clientPayloadDigest(stored)) {
            return "event_id_conflict" as const;
          }
          return "duplicate" as const;
        }
        const existingReservation = await transaction.getEventReservation(stored.event_id);
        if (existingReservation) {
          if (existingReservation.plugin_principal_id !== stored.plugin_principal_id
            || existingReservation.binding_id !== stored.binding_id
            || existingReservation.payload_digest !== clientPayloadDigest(stored)) {
            return "event_id_conflict" as const;
          }
          return "duplicate" as const;
        }
        let operation: OperationState | undefined;
        let pendingTerminalReservation: Awaited<ReturnType<typeof transaction.getEventReservation>>;
        const terminal = ["run_succeeded", "run_failed", "run_cancelled", "run_interrupted"].includes(stored.event_type);
        if (stored.event_type === "run_started" || terminal) {
          const operationId = operationDocumentId(claims.pluginPrincipalId, claims.bindingId, stored.operation_id);
          operation = await transaction.getOperation(operationId);
          if (operation && (operation.tool_key !== stored.tool_key || operation.action_key !== stored.action_key || operation.session_id !== stored.session_id)) {
            return "operation_conflict" as const;
          }
          if (stored.event_type === "run_started" && operation?.started_event_id) return "operation_conflict" as const;
          if (terminal && operation?.terminal_event_id) return "operation_conflict" as const;
          if (terminal && operation?.pending_terminal) {
            return clientPayloadDigest(operation.pending_terminal) === clientPayloadDigest(stored) ? "duplicate" as const : "operation_conflict" as const;
          }
          if (terminal && !operation) {
            await transaction.putEventReservation({
              event_id: stored.event_id,
              plugin_principal_id: stored.plugin_principal_id,
              binding_id: stored.binding_id,
              operation_document_id: operationDocumentId(claims.pluginPrincipalId, claims.bindingId, stored.operation_id),
              payload_digest: clientPayloadDigest(stored),
              created_at: stored.server_received_at,
            });
            await transaction.putOperation({
              id: operationDocumentId(claims.pluginPrincipalId, claims.bindingId, stored.operation_id),
              plugin_principal_id: claims.pluginPrincipalId,
              binding_id: claims.bindingId,
              operation_id: stored.operation_id,
              tool_key: stored.tool_key,
              action_key: stored.action_key,
              session_id: stored.session_id,
              started_event_id: null,
              started_at: null,
              pending_terminal: stored,
              terminal_event_id: null,
              terminal_event_type: null,
              terminal_at: null,
              updated_at: stored.server_received_at,
            });
            return "pending_terminal" as const;
          }
          if (stored.event_type === "run_started" && operation?.pending_terminal) {
            const pendingTerminalEvent = await transaction.getUsageEvent(operation.pending_terminal.event_id);
            pendingTerminalReservation = await transaction.getEventReservation(operation.pending_terminal.event_id);
            if (pendingTerminalEvent
              || (pendingTerminalReservation
                && (pendingTerminalReservation.plugin_principal_id !== stored.plugin_principal_id
                  || pendingTerminalReservation.binding_id !== stored.binding_id
                  || pendingTerminalReservation.payload_digest !== clientPayloadDigest(operation.pending_terminal)))) {
              return "event_id_conflict" as const;
            }
          }
        }
        const currentPointer =
          (await transaction.getAggregatePointer("active")) ??
          defaultAggregatePointer(serverReceivedAt.toISOString());
        const eventsToCommit: StoredUsageEvent[] = [stored];
        if (stored.event_type === "run_started" && operation?.pending_terminal) {
          eventsToCommit.push(operation.pending_terminal);
        }
        const sourceDates = [...new Set(eventsToCommit.map((event) => dateBucket(event.time_correction.corrected_observed_at)))];
        const currentSourceRevisions = new Map(
          await Promise.all(sourceDates.map(async (date) => [
            date,
            await transaction.getAggregateSourceRevision(date),
          ] as const)),
        );
        const aggregateEntries = [{
          event: stored,
          generations: acceptedGenerations(currentPointer, stored.time_correction.corrected_observed_at),
        }];
        if (stored.event_type === "run_started" && operation?.pending_terminal) {
          aggregateEntries.push({
            event: operation.pending_terminal,
            generations: acceptedGenerations(currentPointer, operation.pending_terminal.time_correction.corrected_observed_at),
          });
        }
        await aggregateEventsToGenerations(transaction, aggregateEntries);
        for (const committedEvent of eventsToCommit) await transaction.putUsageEvent(committedEvent);
        if (stored.event_type === "run_started" && operation?.pending_terminal && pendingTerminalReservation) {
          await transaction.deleteEventReservation(operation.pending_terminal.event_id);
        }
        if (stored.event_type === "run_started") {
          await transaction.putOperation({
            id: operationDocumentId(claims.pluginPrincipalId, claims.bindingId, stored.operation_id),
            plugin_principal_id: claims.pluginPrincipalId,
            binding_id: claims.bindingId,
            operation_id: stored.operation_id,
            tool_key: stored.tool_key,
            action_key: stored.action_key,
            session_id: stored.session_id,
            started_event_id: stored.event_id,
            started_at: stored.server_received_at,
            pending_terminal: null,
            terminal_event_id: operation?.pending_terminal?.event_id ?? null,
            terminal_event_type: operation?.pending_terminal?.event_type as OperationState["terminal_event_type"] ?? null,
            terminal_at: operation?.pending_terminal?.server_received_at ?? null,
            updated_at: stored.server_received_at,
          });
        } else if (terminal && operation) {
          operation.terminal_event_id = stored.event_id;
          operation.terminal_event_type = stored.event_type as OperationState["terminal_event_type"];
          operation.terminal_at = stored.server_received_at;
          operation.updated_at = stored.server_received_at;
          await transaction.putOperation(operation);
        }
        const watermark: UsageAggregateWatermark = {
          corrected_observed_at: stored.time_correction.corrected_observed_at,
          server_received_at: stored.server_received_at,
          event_id: stored.event_id,
        };
        await transaction.putAggregatePointer({
          ...currentPointer,
          id: "active",
          source_revision: currentPointer.source_revision + eventsToCommit.length,
          source_watermark: eventsToCommit.reduce((current, committedEvent) => {
            const candidate = {
              corrected_observed_at: committedEvent.time_correction.corrected_observed_at,
              server_received_at: committedEvent.server_received_at,
              event_id: committedEvent.event_id,
            };
            return current && compareWatermark(current, candidate) >= 0 ? current : candidate;
          }, currentPointer.source_watermark ?? watermark),
          updated_at: stored.server_received_at,
        });
        for (const date of sourceDates) {
          const eventsForDate = eventsToCommit.filter((event) => dateBucket(event.time_correction.corrected_observed_at) === date);
          const currentRevision = currentSourceRevisions.get(date);
          await transaction.putAggregateSourceRevision({
            date,
            revision: (currentRevision?.revision ?? 0) + eventsForDate.length,
            updated_at: eventsForDate.reduce(
              (latest, event) => event.server_received_at > latest ? event.server_received_at : latest,
              currentRevision?.updated_at ?? eventsForDate[0].server_received_at,
            ),
          });
        }
        return "accepted" as const;
      });
      if (outcome === "duplicate") return { event_id: stored.event_id, status: "confirmed", code: "duplicate" };
      if (outcome === "pending_terminal") return { event_id: stored.event_id, status: "confirmed", code: "pending_start" };
      if (outcome === "operation_conflict" || outcome === "event_id_conflict") {
        await this.writeDeadLetter({
          eventId,
          bindingId: claims.bindingId,
          principalId: claims.pluginPrincipalId,
          serverReceivedAt,
          reason: outcome,
          classification: "permanent",
          field: outcome === "event_id_conflict" ? "event_id" : "operation_id",
          diagnostic: outcome,
        });
        return { event_id: stored.event_id, status: "permanent_rejected", code: outcome };
      }
      return { event_id: stored.event_id, status: "confirmed" };
    } catch {
      return { event_id: stored.event_id, status: "retryable", code: "storage_unavailable", retry_after_seconds: 5, retry_policy: "exponential_jitter_until_lease_expiry" };
    }
  }

  private async writeDeadLetter(input: {
    eventId: string | null;
    bindingId: string;
    principalId: string;
    serverReceivedAt: Date;
    reason: string;
    classification: "retryable" | "permanent";
    field: string | null;
    diagnostic: string;
  }): Promise<void> {
    const id = deadLetterId(input.eventId, input.reason, input.bindingId, input.principalId);
    const eventHash = input.eventId ? createHash("sha256").update(input.eventId).digest("hex") : null;
    const identityHash = createHash("sha256").update(`${input.bindingId}\u0000${input.principalId}`).digest("hex");
    try {
      await this.store.runTransaction(async (transaction) => {
        const current = await transaction.getDeadLetter(id);
        const record: DeadLetter = {
          id,
          event_hash: eventHash,
          identity_hash: identityHash,
          server_received_at: current?.server_received_at ?? input.serverReceivedAt.toISOString(),
          first_seen_at: current?.first_seen_at ?? input.serverReceivedAt.toISOString(),
          last_seen_at: input.serverReceivedAt.toISOString(),
          reason: input.reason.slice(0, 64),
          classification: input.classification,
          field: input.field && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(input.field) ? input.field : null,
          diagnostic: boundedDiagnostic(input.diagnostic),
          payload_digest: null,
          attempts: (current?.attempts ?? 0) + 1,
          status: current?.status ?? "open",
        };
        await transaction.putDeadLetter(record);
      });
    } catch {
      // A rejected client event must remain rejected even if the diagnostic sink is unavailable.
    }
  }

  private assertRequestShape(request: UsageIngestionRequest): void {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new UsageIngestionError("invalid_request", false, "Invalid ingestion request");
    }
    const keys = Object.keys(request as object).sort();
    if (keys.join(",") !== "events,lease_token,queue_binding_id") {
      throw new UsageIngestionError("invalid_request", false, "Invalid ingestion request fields");
    }
    if (typeof request.queue_binding_id !== "string" || request.queue_binding_id.length < 1 || request.queue_binding_id.length > 128 || typeof request.lease_token !== "string" || request.lease_token.length > 4096 || !Array.isArray(request.events) || request.events.length === 0) {
      throw new UsageIngestionError("invalid_request", false, "Invalid ingestion request");
    }
  }
}

export { InMemoryUsageStore } from "./store";
