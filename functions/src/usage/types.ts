import type { Clock } from "../plugin-auth/types";

export type UsageEventType =
  | "entry_clicked"
  | "dialog_opened"
  | "dialog_open_failed"
  | "run_rejected"
  | "run_started"
  | "run_succeeded"
  | "run_failed"
  | "run_cancelled"
  | "run_interrupted"
  | "unexpected_exception";

export const USAGE_EVENT_TYPES: readonly UsageEventType[] = [
  "entry_clicked",
  "dialog_opened",
  "dialog_open_failed",
  "run_rejected",
  "run_started",
  "run_succeeded",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "unexpected_exception",
];

export interface RegistryAction {
  action_key: string;
  display_name: string;
  page: string;
  introduced_version: string;
  retired_version: string | null;
  accept_until: string | null;
  display_state: "active" | "hidden" | "retired";
}

export interface RegistryTool {
  tool_key: string;
  display_name: string;
  page: string;
  introduced_version: string;
  retired_version: string | null;
  accept_until: string | null;
  display_state: "active" | "hidden" | "retired";
  actions: RegistryAction[];
}

export interface ToolRegistry {
  schema_version: string;
  registry_version: string;
  registry_status: "draft" | "active";
  tools: RegistryTool[];
}

export interface ClientUsageEvent {
  schema_version: string;
  registry_version: string;
  event_id: string;
  binding_id: string;
  tool_key: string;
  action_key: string;
  event_type: UsageEventType;
  client_observed_at: string;
  plugin_version: string;
  ue_version: string;
  ui_version: string;
  process_instance_id: string;
  session_id: string;
  operation_id: string;
  duration_ms?: number;
  error?: {
    error_category:
      | "validation"
      | "permission"
      | "dependency"
      | "timeout"
      | "ue_runtime"
      | "houdini_runtime"
      | "cancelled"
      | "internal"
      | "unknown";
    summary: string;
    call_site: string;
    fingerprint: string;
  };
  [key: string]: unknown;
}

export interface TimeCorrection {
  applied: boolean;
  corrected_observed_at: string;
  clock_offset_ms: number;
  reason: "within_tolerance" | "client_clock_ahead" | "client_clock_behind";
}

export interface StoredUsageEvent extends ClientUsageEvent {
  plugin_principal_id: string;
  server_received_at: string;
  time_correction: TimeCorrection;
}

export interface UsageDailyAggregate {
  id: string;
  date: string;
  plugin_principal_id: string;
  tool_key: string;
  action_key: string;
  run_started: number;
  run_succeeded: number;
  run_failed: number;
  run_cancelled: number;
  run_interrupted: number;
  duration_total_ms: number;
  duration_count: number;
  duration_max_ms: number;
  event_count: number;
  generation: string;
  updated_at: string;
  last_observed_at?: string;
  last_received_at?: string;
  time_corrected_count?: number;
}

export interface PrincipalDailyAggregate {
  id: string;
  date: string;
  plugin_principal_id: string;
  run_started: number;
  run_succeeded: number;
  run_failed: number;
  run_cancelled: number;
  run_interrupted: number;
  event_count: number;
  generation: string;
  updated_at: string;
  last_observed_at?: string;
  last_received_at?: string;
  time_corrected_count?: number;
}

export interface ErrorAggregate {
  id: string;
  date: string;
  tool_key: string;
  action_key: string;
  error_category: string;
  fingerprint: string;
  count: number;
  first_seen_at: string;
  recent_seen_at: string;
  summaries: Array<{ summary: string; count: number }>;
  status: "open" | "resolved";
  generation: string;
  first_received_at?: string;
  recent_received_at?: string;
  time_corrected_count?: number;
  plugin_version: string;
  affected_versions: string[];
  principal_ids?: string[];
}

export interface UsageAggregateWatermark {
  corrected_observed_at: string;
  server_received_at: string;
  event_id: string;
}

export interface UsageAggregatePointer {
  id: string;
  active_generation: string;
  write_generations: string[];
  rollback_generation: string | null;
  source_revision: number;
  source_watermark: UsageAggregateWatermark | null;
  generation_partitions?: Array<{
    from: string;
    to: string;
    generation: string;
    rollback_generation: string | null;
  }>;
  updated_at: string;
}

export interface UsageAggregateSourceRevision {
  date: string;
  revision: number;
  updated_at: string;
}

export interface DeadLetter {
  id: string;
  event_hash: string | null;
  identity_hash: string;
  server_received_at: string;
  first_seen_at: string;
  last_seen_at: string;
  reason: string;
  classification: "retryable" | "permanent";
  field: string | null;
  diagnostic: string;
  payload_digest: string | null;
  attempts: number;
  status: "open" | "replayed" | "discarded";
}

export interface OperationState {
  id: string;
  plugin_principal_id: string;
  binding_id: string;
  operation_id: string;
  tool_key: string;
  action_key: string;
  session_id: string;
  started_event_id: string | null;
  started_at: string | null;
  pending_terminal: StoredUsageEvent | null;
  terminal_event_id: string | null;
  terminal_event_type: "run_succeeded" | "run_failed" | "run_cancelled" | "run_interrupted" | null;
  terminal_at: string | null;
  updated_at: string;
}

export interface UsageEventReservation {
  event_id: string;
  plugin_principal_id: string;
  binding_id: string;
  operation_document_id: string;
  payload_digest: string;
  created_at: string;
}

export interface UsageTransaction {
  getUsageEvent(eventId: string): Promise<StoredUsageEvent | undefined>;
  putUsageEvent(event: StoredUsageEvent): Promise<void>;
  getEventReservation(eventId: string): Promise<UsageEventReservation | undefined>;
  putEventReservation(reservation: UsageEventReservation): Promise<void>;
  deleteEventReservation(eventId: string): Promise<void>;
  getDailyAggregate(id: string): Promise<UsageDailyAggregate | undefined>;
  putDailyAggregate(value: UsageDailyAggregate): Promise<void>;
  getPrincipalAggregate(id: string): Promise<PrincipalDailyAggregate | undefined>;
  putPrincipalAggregate(value: PrincipalDailyAggregate): Promise<void>;
  getErrorAggregate(id: string): Promise<ErrorAggregate | undefined>;
  putErrorAggregate(value: ErrorAggregate): Promise<void>;
  getOperation(id: string): Promise<OperationState | undefined>;
  putOperation(value: OperationState): Promise<void>;
  getDeadLetter(id: string): Promise<DeadLetter | undefined>;
  putDeadLetter(value: DeadLetter): Promise<void>;
  getAggregatePointer(id: string): Promise<UsageAggregatePointer | undefined>;
  putAggregatePointer(value: UsageAggregatePointer): Promise<void>;
  getAggregateSourceRevision(date: string): Promise<UsageAggregateSourceRevision | undefined>;
  putAggregateSourceRevision(value: UsageAggregateSourceRevision): Promise<void>;
}

export interface UsageStore {
  runTransaction<T>(handler: (transaction: UsageTransaction) => Promise<T>): Promise<T>;
}

export interface UsageQuota {
  consume(input: { bindingId: string; pluginPrincipalId: string; eventCount: number; now: Date }): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface UsageAuth {
  authorizeEvent(input: {
    leaseToken: string;
    queueBindingId: string;
  }): Promise<{ bindingId: string; pluginPrincipalId: string; expiresAtSeconds: number }>;
}

export interface IngestionClock extends Clock {}

export interface UsageIngestionRequest {
  queue_binding_id: string;
  lease_token: string;
  events: ClientUsageEvent[];
}

export type EventResultStatus = "confirmed" | "retryable" | "permanent_rejected";

export interface EventResult {
  event_id: string | null;
  status: EventResultStatus;
  code?: string;
  retry_after_seconds?: number;
  retry_policy?: "exponential_jitter_until_lease_expiry";
}

export interface BatchIngestionResult {
  results: EventResult[];
  accepted: number;
  duplicates: number;
  retryable: number;
  permanent_rejected: number;
  lease_expires_at?: string;
  renewal_recommended?: boolean;
}

export interface RateLimitConfiguration {
  capacity: number;
  refillPerSecond: number;
}
