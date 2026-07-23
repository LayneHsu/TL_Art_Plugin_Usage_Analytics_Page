import type {
  ErrorAggregate,
  PrincipalDailyAggregate,
  StoredUsageEvent,
  UsageDailyAggregate,
  UsageTransaction,
} from "./types";
import { errorFingerprint } from "./redaction";

function dateBucket(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function incrementStatus(target: UsageDailyAggregate | PrincipalDailyAggregate, eventType: string): void {
  if (eventType === "run_started") target.run_started += 1;
  if (eventType === "run_succeeded") target.run_succeeded += 1;
  if (eventType === "run_failed") target.run_failed += 1;
  if (eventType === "run_cancelled") target.run_cancelled += 1;
  if (eventType === "run_interrupted") target.run_interrupted += 1;
}

export function dailyAggregateId(event: StoredUsageEvent, generation = "online"): string {
  return `${generation}|${dateBucket(event.time_correction.corrected_observed_at)}|${event.plugin_principal_id}|${event.tool_key}|${event.action_key}`;
}

export function principalAggregateId(event: StoredUsageEvent, generation = "online"): string {
  return `${generation}|${dateBucket(event.time_correction.corrected_observed_at)}|${event.plugin_principal_id}`;
}

export function errorAggregateId(event: StoredUsageEvent, generation = "online"): string | null {
  if (!event.error || !["run_failed", "run_cancelled", "run_interrupted", "unexpected_exception", "dialog_open_failed"].includes(event.event_type)) {
    return null;
  }
  const fingerprint = errorFingerprint(event.error.error_category, event.error.summary, event.error.call_site);
  return `${generation}|${dateBucket(event.time_correction.corrected_observed_at)}|${event.tool_key}|${event.action_key}|${event.error.error_category}|${fingerprint}|${event.plugin_version}`;
}

function newDaily(event: StoredUsageEvent, id: string): UsageDailyAggregate {
  return {
    id,
    date: dateBucket(event.time_correction.corrected_observed_at),
    plugin_principal_id: event.plugin_principal_id,
    tool_key: event.tool_key,
    action_key: event.action_key,
    run_started: 0,
    run_succeeded: 0,
    run_failed: 0,
    run_cancelled: 0,
    run_interrupted: 0,
    duration_total_ms: 0,
    duration_count: 0,
    duration_max_ms: 0,
    event_count: 0,
    generation: id.split("|", 1)[0],
    updated_at: event.server_received_at,
    last_observed_at: event.time_correction.corrected_observed_at,
    last_received_at: event.server_received_at,
    time_corrected_count: 0,
  };
}

function newPrincipal(event: StoredUsageEvent, id: string): PrincipalDailyAggregate {
  return {
    id,
    date: dateBucket(event.time_correction.corrected_observed_at),
    plugin_principal_id: event.plugin_principal_id,
    run_started: 0,
    run_succeeded: 0,
    run_failed: 0,
    run_cancelled: 0,
    run_interrupted: 0,
    event_count: 0,
    generation: id.split("|", 1)[0],
    updated_at: event.server_received_at,
    last_observed_at: event.time_correction.corrected_observed_at,
    last_received_at: event.server_received_at,
    time_corrected_count: 0,
  };
}

export async function aggregateEvent(
  transaction: UsageTransaction,
  event: StoredUsageEvent,
  generation = "online",
): Promise<void> {
  await aggregateEventToGenerations(transaction, event, [generation]);
}

export async function aggregateEventToGenerations(
  transaction: UsageTransaction,
  event: StoredUsageEvent,
  generations: string[],
): Promise<void> {
  await aggregateEventsToGenerations(transaction, [{ event, generations }]);
}

export async function aggregateEventsToGenerations(
  transaction: UsageTransaction,
  entries: Array<{ event: StoredUsageEvent; generations: string[] }>,
): Promise<void> {
  const normalizedEntries = entries.map(({ event, generations }) => {
    const normalizedGenerations = [...new Set(generations)];
    if (
      normalizedGenerations.length === 0 ||
      normalizedGenerations.some(
        (generation) => !/^[a-z][a-z0-9._-]{0,63}$/.test(generation),
      )
    ) {
      throw new Error("Invalid aggregate generation");
    }
    return { event, generations: normalizedGenerations };
  });

  const daily = new Map<string, UsageDailyAggregate>();
  const principal = new Map<string, PrincipalDailyAggregate>();
  const errors = new Map<string, ErrorAggregate>();
  const dailyWrites = new Set<string>();
  const principalWrites = new Set<string>();
  const errorWrites = new Set<string>();

  // Firestore requires every transaction read to finish before its first write.
  // Preload every aggregate touched by every event before applying any changes.
  for (const { event, generations } of normalizedEntries) {
    for (const generation of generations) {
      const dailyId = dailyAggregateId(event, generation);
      if (!daily.has(dailyId)) {
        const current = await transaction.getDailyAggregate(dailyId);
        daily.set(dailyId, current ?? newDaily(event, dailyId));
      }
      const principalId = principalAggregateId(event, generation);
      if (!principal.has(principalId)) {
        const current = await transaction.getPrincipalAggregate(principalId);
        principal.set(principalId, current ?? newPrincipal(event, principalId));
      }
      const errorId = errorAggregateId(event, generation);
      if (errorId && !errors.has(errorId)) {
        const current = await transaction.getErrorAggregate(errorId);
        if (current) errors.set(errorId, current);
      }
    }
  }

  for (const { event, generations } of normalizedEntries) {
    for (const generation of generations) {
      const dailyId = dailyAggregateId(event, generation);
      const principalId = principalAggregateId(event, generation);
      const dailyValue = daily.get(dailyId) as UsageDailyAggregate;
      const principalValue = principal.get(principalId) as PrincipalDailyAggregate;
      incrementStatus(dailyValue, event.event_type);
      incrementStatus(principalValue, event.event_type);
      dailyValue.event_count += 1;
      principalValue.event_count += 1;
      if (event.duration_ms !== undefined) {
        dailyValue.duration_total_ms += event.duration_ms;
        dailyValue.duration_count += 1;
        dailyValue.duration_max_ms = Math.max(dailyValue.duration_max_ms, event.duration_ms);
      }
      dailyValue.updated_at = event.server_received_at;
      principalValue.updated_at = event.server_received_at;
      const observedAt = event.time_correction.corrected_observed_at;
      if (!dailyValue.last_observed_at || observedAt > dailyValue.last_observed_at) dailyValue.last_observed_at = observedAt;
      if (!principalValue.last_observed_at || observedAt > principalValue.last_observed_at) principalValue.last_observed_at = observedAt;
      if (!dailyValue.last_received_at || event.server_received_at > dailyValue.last_received_at) dailyValue.last_received_at = event.server_received_at;
      if (!principalValue.last_received_at || event.server_received_at > principalValue.last_received_at) principalValue.last_received_at = event.server_received_at;
      dailyValue.time_corrected_count = Number(dailyValue.time_corrected_count ?? 0) + (event.time_correction.applied ? 1 : 0);
      principalValue.time_corrected_count = Number(principalValue.time_corrected_count ?? 0) + (event.time_correction.applied ? 1 : 0);
      dailyWrites.add(dailyId);
      principalWrites.add(principalId);

      const errorId = errorAggregateId(event, generation);
      if (!errorId || !event.error) continue;
      const summary = event.error.summary.slice(0, 512);
      const errorValue: ErrorAggregate = errors.get(errorId) ?? {
        id: errorId,
        date: dailyValue.date,
        tool_key: event.tool_key,
        action_key: event.action_key,
        error_category: event.error.error_category,
        fingerprint: errorFingerprint(event.error.error_category, summary, event.error.call_site),
        count: 0,
        first_seen_at: event.time_correction.corrected_observed_at,
        recent_seen_at: event.time_correction.corrected_observed_at,
        summaries: [],
        status: "open",
        generation,
        first_received_at: event.server_received_at,
        recent_received_at: event.server_received_at,
        time_corrected_count: 0,
        plugin_version: event.plugin_version,
        affected_versions: [event.plugin_version],
        principal_ids: [],
      };
      errors.set(errorId, errorValue);
      errorValue.count += 1;
      errorValue.first_seen_at =
        event.time_correction.corrected_observed_at < errorValue.first_seen_at
          ? event.time_correction.corrected_observed_at
          : errorValue.first_seen_at;
      errorValue.recent_seen_at =
        event.time_correction.corrected_observed_at > errorValue.recent_seen_at
          ? event.time_correction.corrected_observed_at
          : errorValue.recent_seen_at;
      errorValue.first_received_at = !errorValue.first_received_at || event.server_received_at < errorValue.first_received_at ? event.server_received_at : errorValue.first_received_at;
      errorValue.recent_received_at = !errorValue.recent_received_at || event.server_received_at > errorValue.recent_received_at ? event.server_received_at : errorValue.recent_received_at;
      errorValue.time_corrected_count = Number(errorValue.time_corrected_count ?? 0) + (event.time_correction.applied ? 1 : 0);
      errorValue.plugin_version = event.plugin_version;
      errorValue.affected_versions = [event.plugin_version];
      errorValue.principal_ids = [...new Set([...(errorValue.principal_ids ?? []), event.plugin_principal_id])].sort().slice(0, 100);
      const existingSummary = errorValue.summaries.find(
        (item) => item.summary === summary,
      );
      if (existingSummary) {
        existingSummary.count += 1;
      } else if (errorValue.summaries.length < 3) {
        errorValue.summaries.push({ summary, count: 1 });
      }
      errorWrites.add(errorId);
    }
  }

  for (const id of dailyWrites) await transaction.putDailyAggregate(daily.get(id) as UsageDailyAggregate);
  for (const id of principalWrites) await transaction.putPrincipalAggregate(principal.get(id) as PrincipalDailyAggregate);
  for (const id of errorWrites) await transaction.putErrorAggregate(errors.get(id) as ErrorAggregate);
}

export { dateBucket };
