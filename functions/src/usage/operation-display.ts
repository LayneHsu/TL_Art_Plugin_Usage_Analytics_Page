import type { OperationState } from "./types";

export type OperationDisplayState =
  | "pending_start"
  | "running"
  | "abandoned"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

export function deriveOperationDisplayState(
  operation: OperationState,
  now: Date,
): OperationDisplayState {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid operation display time");
  if (operation.terminal_event_type === "run_succeeded") return "succeeded";
  if (operation.terminal_event_type === "run_failed") return "failed";
  if (operation.terminal_event_type === "run_cancelled") return "cancelled";
  if (operation.terminal_event_type === "run_interrupted") return "interrupted";
  if (!operation.started_at || operation.pending_terminal) return "pending_start";
  const startedAt = Date.parse(operation.started_at);
  if (!Number.isFinite(startedAt)) throw new Error("Invalid operation start time");
  return now.getTime() - startedAt >= ABANDONED_AFTER_MS
    ? "abandoned"
    : "running";
}
