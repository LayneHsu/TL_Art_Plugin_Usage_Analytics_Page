import type {
  ErrorLog,
  EventRow,
  EventResult,
  PluginUserProfile,
  PortalAnalytics,
  PortalExportRecord,
  UsageDailyShard,
  UsageEvent,
  UsageFilter,
  UsageRow,
  UserUsageRow,
  ErrorRow,
} from "./api";

export function companyDateFromTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function inRange(value: string, filter: UsageFilter): boolean {
  const date = companyDateFromTimestamp(value);
  return date >= filter.dateFrom && date <= filter.dateTo;
}

function matchesFilter(event: UsageEvent, uid: string, filter: UsageFilter, includeResult = true): boolean {
  return inRange(event.occurred_at, filter)
    && (!filter.userUid || filter.userUid === uid)
    && (!filter.toolKey || event.tool_key.includes(filter.toolKey))
    && (!filter.actionKey || event.action_key.includes(filter.actionKey))
    && (!includeResult || !filter.result || event.result === filter.result);
}

export function dedupeEvents(shards: UsageDailyShard[]): Array<{ uid: string; event: UsageEvent }> {
  const seen = new Set<string>();
  const output: Array<{ uid: string; event: UsageEvent }> = [];
  for (const shard of shards) {
    for (const event of shard.events || []) {
      const identity = `${shard.uid}:${event.event_id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      output.push({ uid: shard.uid, event });
    }
  }
  return output;
}

function incrementResult(row: { succeeded: number; failed: number; cancelled: number; interrupted: number }, result: EventResult): void {
  if (result === "succeeded") row.succeeded += 1;
  if (result === "failed" || result === "unexpected") row.failed += 1;
  if (result === "cancelled") row.cancelled += 1;
  if (result === "interrupted") row.interrupted += 1;
}

export function aggregateUsage(
  shards: UsageDailyShard[],
  profiles: PluginUserProfile[],
  filter: UsageFilter,
  errorLogs: ErrorLog[] = [],
): PortalAnalytics {
  const profileByUid = new Map(profiles.map((profile) => [profile.uid, profile]));
  const rows = new Map<string, UsageRow & { userIds: Set<string> }>();
  const users = new Map<string, UserUsageRow>();
  const daily = new Map<string, { total: number; failed: number }>();
  const events: EventRow[] = [];
  const unique = dedupeEvents(shards);
  const terminalByOperation = new Map<string, UsageEvent>();

  for (const value of unique) {
    if (!["run_succeeded", "run_failed", "run_cancelled", "run_interrupted"].includes(value.event.event_type)) continue;
    const operationKey = `${value.uid}:${value.event.operation_id}`;
    const previous = terminalByOperation.get(operationKey);
    if (!previous || value.event.occurred_at > previous.occurred_at) terminalByOperation.set(operationKey, value.event);
  }

  for (const { uid, event } of unique) {
    if (!matchesFilter(event, uid, filter, false) || event.event_type !== "run_started") continue;
    const terminal = terminalByOperation.get(`${uid}:${event.operation_id}`);
    const resolvedEvent: UsageEvent = terminal ? {
      ...event,
      result: terminal.result,
      duration_ms: terminal.duration_ms,
      error_log_id: terminal.error_log_id,
      error_summary: terminal.error_summary,
    } : event;
    if (filter.result && resolvedEvent.result !== filter.result) continue;
    const profile = profileByUid.get(uid);
    const displayName = profile?.display_name || uid;
    const email = profile?.email || "未记录邮箱";
    const eventRow: EventRow = { ...resolvedEvent, uid, display_name: displayName, email };
    events.push(eventRow);

    const key = `${event.tool_key}:${event.action_key}`;
    const row = rows.get(key) ?? { tool_key: event.tool_key, action_key: event.action_key, total: 0, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0, users: 0, last_occurred_at: null, userIds: new Set<string>() };
    row.total += 1;
    row.userIds.add(uid);
    incrementResult(row, resolvedEvent.result);
    if (!row.last_occurred_at || event.occurred_at > row.last_occurred_at) row.last_occurred_at = event.occurred_at;
    rows.set(key, row);

    const userRow = users.get(uid) ?? { uid, display_name: displayName, email, total: 0, succeeded: 0, failed: 0, last_occurred_at: null };
    userRow.total += 1;
    if (resolvedEvent.result === "succeeded") userRow.succeeded += 1;
    if (resolvedEvent.result === "failed" || resolvedEvent.result === "unexpected") userRow.failed += 1;
    if (!userRow.last_occurred_at || event.occurred_at > userRow.last_occurred_at) userRow.last_occurred_at = event.occurred_at;
    users.set(uid, userRow);

    const day = companyDateFromTimestamp(event.occurred_at);
    const dailyPoint = daily.get(day) ?? { total: 0, failed: 0 };
    dailyPoint.total += 1;
    if (resolvedEvent.result === "failed" || resolvedEvent.result === "unexpected") dailyPoint.failed += 1;
    daily.set(day, dailyPoint);
  }

  const usageRows = [...rows.values()].map(({ userIds, ...row }) => ({ ...row, users: userIds.size }));
  usageRows.sort((a, b) => (b.last_occurred_at || "").localeCompare(a.last_occurred_at || ""));
  const userRows = [...users.values()].sort((a, b) => b.total - a.total || a.display_name.localeCompare(b.display_name));
  events.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  return {
    events,
    usageRows,
    userRows,
    errors: aggregateErrorLogs(errorLogs, filter),
    dailyTrend: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, ...value })),
    total: events.length,
    activeUsers: userRows.length,
    activeTools: new Set(usageRows.map((row) => row.tool_key)).size,
    succeeded: events.filter((event) => event.result === "succeeded").length,
    failed: events.filter((event) => event.result === "failed" || event.result === "unexpected").length,
  };
}

function aggregateErrorLogs(logs: ErrorLog[], filter: UsageFilter): ErrorRow[] {
  const groups = new Map<string, ErrorRow & { userIds: Set<string>; summarySet: Set<string> }>();
  for (const log of filterErrorLogs(logs, filter)) {
    const key = `${log.tool_key}:${log.action_key}:${log.fingerprint}`;
    const group = groups.get(key) ?? {
      key,
      tool_key: log.tool_key,
      action_key: log.action_key,
      error_type: log.error_type,
      fingerprint: log.fingerprint,
      count: 0,
      users: 0,
      first_occurred_at: log.occurred_at,
      last_occurred_at: log.occurred_at,
      summaries: [],
      userIds: new Set<string>(),
      summarySet: new Set<string>(),
    };
    group.count += 1;
    group.userIds.add(log.uid);
    group.summarySet.add(log.summary);
    if (log.occurred_at < group.first_occurred_at) group.first_occurred_at = log.occurred_at;
    if (log.occurred_at > group.last_occurred_at) group.last_occurred_at = log.occurred_at;
    groups.set(key, group);
  }
  return [...groups.values()].map(({ userIds, summarySet, ...group }) => ({
    ...group,
    users: userIds.size,
    summaries: [...summarySet].slice(0, 5),
  })).sort((a, b) => b.last_occurred_at.localeCompare(a.last_occurred_at));
}

export function filterErrorLogs(logs: ErrorLog[], filter: UsageFilter): ErrorLog[] {
  return logs.filter((log) => inRange(log.occurred_at, filter)
    && (!filter.userUid || filter.userUid === log.uid)
    && (!filter.toolKey || log.tool_key.includes(filter.toolKey))
    && (!filter.actionKey || log.action_key.includes(filter.actionKey)));
}

export function toExportRecords(analytics: PortalAnalytics): PortalExportRecord[] {
  return analytics.events.map((event) => ({
    event_id: event.event_id,
    uid: event.uid,
    display_name: event.display_name,
    email: event.email,
    tool_key: event.tool_key,
    action_key: event.action_key,
    occurred_at: event.occurred_at,
    result: event.result,
    duration_ms: event.duration_ms ?? null,
    plugin_version: event.plugin_version,
  }));
}
