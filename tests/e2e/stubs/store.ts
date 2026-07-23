import type { PortalData, PortalMember, PortalRole, UsageEvent } from "../../../web/src/portal/api";

const now = "2026-07-23T08:00:00.000Z";
const started = (id: string, operation: string, uid: string, tool: string, action: string): UsageEvent => ({
  event_id: id,
  operation_id: operation,
  tool_key: tool,
  action_key: action,
  event_type: "run_started",
  occurred_at: now,
  result: "started",
  plugin_version: "8.0.0",
});
const terminal = (id: string, operation: string, tool: string, action: string, result: "succeeded" | "failed"): UsageEvent => ({
  event_id: id,
  operation_id: operation,
  tool_key: tool,
  action_key: action,
  event_type: result === "succeeded" ? "run_succeeded" : "run_failed",
  occurred_at: "2026-07-23T08:00:01.000Z",
  result,
  duration_ms: result === "succeeded" ? 850 : 1400,
  plugin_version: "8.0.0",
  ...(result === "failed" ? { error_log_id: "evt-error-2", error_summary: "生成失败" } : {}),
});

const eventOne = started("evt-start-1", "operation-1", "artist-1", "asset.importer", "asset.importer.run");
const eventTwo = started("evt-start-2", "operation-2", "artist-1", "texture.optimizer", "texture.optimizer.run");
const eventThree = started("evt-start-3", "operation-3", "artist-2", "asset.importer", "asset.importer.run");

const data: PortalData = {
  profiles: [
    { uid: "artist-1", email: "artist.one@xindong.com", display_name: "美术一", avatar_url: "", last_login_at: now, last_active_at: now, plugin_version: "8.0.0", updated_at: now },
    { uid: "artist-2", email: "artist.two@xindong.com", display_name: "美术二", avatar_url: "", last_login_at: now, last_active_at: now, plugin_version: "8.0.0", updated_at: now },
  ],
  shards: [
    { company_date: "2026-07-23", uid: "artist-1", tool_key: "asset.importer", shard: "01", events: [eventOne, terminal("evt-end-1", "operation-1", "asset.importer", "asset.importer.run", "succeeded")], first_occurred_at: now, last_occurred_at: now, last_result: "succeeded", plugin_version: "8.0.0" },
    { company_date: "2026-07-23", uid: "artist-1", tool_key: "texture.optimizer", shard: "02", events: [eventTwo, terminal("evt-end-2", "operation-2", "texture.optimizer", "texture.optimizer.run", "failed")], first_occurred_at: now, last_occurred_at: now, last_result: "failed", plugin_version: "8.0.0" },
    { company_date: "2026-07-23", uid: "artist-2", tool_key: "asset.importer", shard: "03", events: [eventThree, terminal("evt-end-3", "operation-3", "asset.importer", "asset.importer.run", "succeeded")], first_occurred_at: now, last_occurred_at: now, last_result: "succeeded", plugin_version: "8.0.0" },
    { company_date: "2026-07-23", uid: "artist-1", tool_key: "asset.importer", shard: "04", events: [eventOne], first_occurred_at: now, last_occurred_at: now, last_result: "started", plugin_version: "8.0.0" },
  ],
  errors: [
    { event_id: "evt-error-2", uid: "artist-1", company_date: "2026-07-23", tool_key: "texture.optimizer", action_key: "texture.optimizer.run", occurred_at: "2026-07-23T08:00:01.000Z", error_type: "ue_runtime", summary: "生成失败", call_site: "texture.optimizer.run", fingerprint: "a".repeat(64), stack: "Traceback: RuntimeError in tool.run", plugin_version: "8.0.0" },
  ],
};

const members: PortalMember[] = [
  { email: "admin@xindong.com", role: "admin", enabled: true, created_at: now, created_by: "portal-e2e-user", updated_at: now, updated_by: "portal-e2e-user" },
  { email: "viewer@xindong.com", role: "viewer", enabled: true, created_at: now, created_by: "portal-e2e-user", updated_at: now, updated_by: "portal-e2e-user" },
];

function delay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, 5);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export async function loadPortalData(_from: string, _to: string, signal?: AbortSignal): Promise<PortalData> {
  await delay(signal);
  return structuredClone(data);
}

export async function loadPortalMembers(signal?: AbortSignal): Promise<PortalMember[]> {
  await delay(signal);
  return structuredClone(members);
}

export async function savePortalMember(currentUser: { uid: string }, email: string, role: PortalRole): Promise<void> {
  members.push({ email, role, enabled: true, created_at: now, created_by: currentUser.uid, updated_at: now, updated_by: currentUser.uid });
}

export async function updatePortalMember(currentUser: { uid: string }, member: PortalMember, changes: { role?: PortalRole; enabled?: boolean }): Promise<void> {
  Object.assign(members.find((value) => value.email === member.email)!, changes, { updated_by: currentUser.uid });
}

export async function removePortalMember(_currentUser: unknown, member: PortalMember): Promise<void> {
  const index = members.findIndex((value) => value.email === member.email);
  if (index >= 0) members.splice(index, 1);
}

export async function previewCleanup() {
  return { usageDocuments: 4, errorDocuments: 1, truncated: false };
}

export async function deleteRecordsBefore() {
  return { deleted: 5, remaining: false };
}

export type CleanupPreview = { usageDocuments: number; errorDocuments: number; truncated: boolean };
