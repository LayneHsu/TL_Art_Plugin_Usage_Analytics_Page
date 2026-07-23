import type {
  ClientUsageEvent,
  RegistryAction,
  RegistryTool,
  TimeCorrection,
  ToolRegistry,
  UsageEventType,
} from "./types";
import { USAGE_EVENT_TYPES } from "./types";
import { redactError } from "./redaction";
import {
  SUPPORTED_EVENT_SCHEMA_VERSIONS,
  validateEventAgainstAuthoritativeSchema,
} from "./contract-artifacts";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const keyPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ueVersionPattern = /^[0-9]{1,3}\.[0-9]{1,3}(?:\.[0-9]{1,10})?(?:[+-][A-Za-z0-9][A-Za-z0-9.+-]*)?$/;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const versionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const terminalEvents = new Set<UsageEventType>([
  "run_succeeded",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
]);
const errorCategories = new Set([
  "validation",
  "permission",
  "dependency",
  "timeout",
  "ue_runtime",
  "houdini_runtime",
  "cancelled",
  "internal",
  "unknown",
]);
const allowedFields = new Set([
  "schema_version",
  "registry_version",
  "event_id",
  "binding_id",
  "tool_key",
  "action_key",
  "event_type",
  "client_observed_at",
  "plugin_version",
  "ue_version",
  "ui_version",
  "process_instance_id",
  "session_id",
  "operation_id",
  "duration_ms",
  "error",
]);

export interface ValidationFailure {
  ok: false;
  code: string;
  field: string | null;
  diagnostic: string;
}

export interface ValidationSuccess {
  ok: true;
  event: ClientUsageEvent;
  correction: TimeCorrection;
}

export type ValidationResult = ValidationFailure | ValidationSuccess;

function failure(code: string, field: string | null, diagnostic = code): ValidationFailure {
  return { ok: false, code, field, diagnostic: diagnostic.slice(0, 160) };
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && identifierPattern.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && versionPattern.test(value);
}

function resolveToolAction(registry: ToolRegistry, toolKey: string, actionKey: string, now: Date): RegistryAction | null {
  const tool: RegistryTool | undefined = registry.tools.find((item) => item.tool_key === toolKey);
  const toolInGrace = !!tool?.accept_until && Date.parse(tool.accept_until) >= now.getTime();
  if (!tool || (tool.display_state === "retired" && !toolInGrace) || (!!tool.accept_until && !toolInGrace)) {
    return null;
  }
  const action = tool.actions.find((item) => item.action_key === actionKey);
  const actionInGrace = !!action?.accept_until && Date.parse(action.accept_until) >= now.getTime();
  if (!action || (action.display_state === "retired" && !actionInGrace) || (!!action.accept_until && !actionInGrace)) {
    return null;
  }
  return action;
}

export function correctObservedTime(clientObservedAt: string, serverReceivedAt: Date): ValidationFailure | TimeCorrection {
  const clientMs = Date.parse(clientObservedAt);
  if (!Number.isFinite(clientMs)) {
    return failure("invalid_client_time", "client_observed_at");
  }
  const offset = serverReceivedAt.getTime() - clientMs;
  if (offset < -86_400_000 || offset > 2_592_000_000) {
    return failure("client_time_out_of_range", "client_observed_at");
  }
  let reason: TimeCorrection["reason"] = "within_tolerance";
  let applied = false;
  let corrected = new Date(clientMs);
  if (offset < -600_000) {
    reason = "client_clock_ahead";
    applied = true;
    corrected = serverReceivedAt;
  } else if (offset > 604_800_000) {
    reason = "client_clock_behind";
    applied = true;
    corrected = serverReceivedAt;
  }
  return {
    applied,
    corrected_observed_at: corrected.toISOString(),
    clock_offset_ms: offset,
    reason,
  };
}

export function validateClientEvent(input: {
  event: unknown;
  registry: ToolRegistry;
  expectedBindingId: string;
  now: Date;
  allowDraftForTests?: boolean;
}): ValidationResult {
  if (input.registry.registry_status !== "active" && !input.allowDraftForTests) {
    return failure("registry_not_active", null, "registry_not_active");
  }
  if (!input.event || typeof input.event !== "object" || Array.isArray(input.event)) {
    return failure("invalid_event", null);
  }
  const event = input.event as Record<string, unknown>;
  const authoritative = validateEventAgainstAuthoritativeSchema(event);
  if (!authoritative.valid) {
    return failure(authoritative.diagnostic === "schema_version_unsupported" ? "schema_version_unsupported" : "schema_invalid", null, authoritative.diagnostic);
  }
  const unknown = Object.keys(event).find((key) => !allowedFields.has(key));
  if (unknown) {
    return failure("unknown_field", unknown);
  }
  for (const field of ["schema_version", "registry_version", "event_id", "binding_id", "tool_key", "action_key", "plugin_version", "ui_version", "process_instance_id", "session_id", "operation_id"]) {
    if (!isBoundedIdentifier(event[field]) && !(["schema_version", "registry_version", "plugin_version", "ui_version"].includes(field) && isVersion(event[field]))) {
      return failure("invalid_field", field);
    }
  }
  if (!SUPPORTED_EVENT_SCHEMA_VERSIONS.has(String(event.schema_version)) || !isVersion(event.schema_version) || !isVersion(event.registry_version) || !isVersion(event.plugin_version) || !isVersion(event.ui_version)) {
    return failure("invalid_version", "schema_version");
  }
  if (event.registry_version !== input.registry.registry_version) {
    return failure("registry_version_unsupported", "registry_version");
  }
  if (event.binding_id !== input.expectedBindingId) {
    return failure("binding_mismatch", "binding_id");
  }
  if (typeof event.tool_key !== "string" || !keyPattern.test(event.tool_key) || typeof event.action_key !== "string" || !keyPattern.test(event.action_key)) {
    return failure("invalid_tool_key", "tool_key");
  }
  if (!resolveToolAction(input.registry, event.tool_key, event.action_key, input.now)) {
    return failure("tool_action_not_allowed", "tool_key");
  }
  if (!USAGE_EVENT_TYPES.includes(event.event_type as UsageEventType)) {
    return failure("invalid_event_type", "event_type");
  }
  if (typeof event.ue_version !== "string" || event.ue_version.length < 1 || event.ue_version.length > 64 || !ueVersionPattern.test(event.ue_version)) {
    return failure("invalid_field", "ue_version");
  }
  const duration = event.duration_ms;
  if (duration !== undefined && (!terminalEvents.has(event.event_type as UsageEventType) || typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 0 || duration > 604_800_000)) {
    return failure("invalid_duration", "duration_ms");
  }
  if (event.error !== undefined) {
    if (!event.error || typeof event.error !== "object" || Array.isArray(event.error)) {
      return failure("invalid_error", "error");
    }
    const error = event.error as Record<string, unknown>;
    if (Object.keys(error).some((key) => !["error_category", "summary", "call_site", "fingerprint"].includes(key)) || !errorCategories.has(String(error.error_category)) || typeof error.summary !== "string" || error.summary.length < 1 || error.summary.length > 512 || typeof error.call_site !== "string" || !keyPattern.test(error.call_site) || typeof error.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(error.fingerprint)) {
      return failure("invalid_error", "error");
    }
    const sanitizedError = redactError(error as unknown as ClientUsageEvent["error"] & { error_category: string; summary: string; call_site: string });
    if (error.fingerprint !== sanitizedError.fingerprint) {
      return failure("error_fingerprint_mismatch", "error.fingerprint");
    }
  }
  if (typeof event.client_observed_at !== "string" || !dateTimePattern.test(event.client_observed_at)) {
    return failure("invalid_client_time", "client_observed_at");
  }
  const correction = correctObservedTime(event.client_observed_at, input.now);
  if ("ok" in correction && correction.ok === false) {
    return correction;
  }
  const sanitized = { ...event } as ClientUsageEvent;
  if (sanitized.error) {
    sanitized.error = redactError(sanitized.error);
  }
  return { ok: true, event: sanitized, correction: correction as TimeCorrection };
}
