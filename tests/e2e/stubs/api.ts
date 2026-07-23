export interface PortalSession { uid: string; email: string; display_name: string; photo_url: string | null; role: "visitor" | "admin"; status: "active"; first_login_at: string | null; last_login_at: string | null }
export interface TeamSummaryRow { tool_key: string; action_key: string; run_started: number; run_succeeded: number; run_failed: number; run_cancelled: number; run_interrupted: number; distinct_users: number; last_used_at: string | null; last_received_at: string | null; time_corrected_count: number }
export interface PrincipalUsageRow extends TeamSummaryRow { plugin_principal_id: string; display_name: string; email: string | null; profile_updated_at: string | null; identity_changed: boolean; daily_trend: Array<{ date: string; run_started: number; run_failed: number; run_interrupted: number }> }
export interface PluginDeviceRow { binding_id: string; plugin_principal_id: string; status: "active" | "revoked"; created_at: string; last_seen_at: string | null; revoked_at: string | null }
export interface ErrorRow { tool_key: string; action_key: string; error_category: string; fingerprint: string; count: number; first_seen_at: string; recent_seen_at: string; first_received_at: string; recent_received_at: string; time_corrected_count: number; affected_versions: string[]; summaries: Array<{ summary: string; count: number }>; status: "open" | "resolved"; distinct_users: number }
export interface ErrorDetailRow { event_id: string; plugin_principal_id: string; display_name: string; email: string | null; binding_id: string; tool_key: string; action_key: string; event_type: string; plugin_version: string; observed_at: string; received_at: string }
export interface PersonRow { uid: string; normalized_email: string; display_name: string; photo_url: string | null; role: "visitor" | "admin"; status: "active" | "disabled" | "removed"; first_login_at: string | null; last_login_at: string | null }
export interface AccessPolicyRow { policy_id: string; kind: "email" | "domain"; normalized_value: string; role: "visitor" | "admin"; enabled: boolean; updated_at: string }
export interface PolicyPreview { normalized_email: string; access: "granted" | "denied"; role: "visitor" | "admin" | null; matched_by: "email" | "domain" | "none"; matched_value: string | null }
export interface PortalPage<T> { items: T[]; next_cursor: string | null }
export interface TeamSummaryPage extends PortalPage<TeamSummaryRow> { summary: { run_started: number; run_succeeded: number; run_failed: number; run_cancelled: number; run_interrupted: number; distinct_users: number }; failure_trend: Array<{ date: string; run_failed: number; run_interrupted: number }> }

export class PortalAccessRevokedError extends Error {}
export class PortalRoleChangedError extends Error {}

const now = "2026-07-23T08:00:00.000Z";
const teamRow: TeamSummaryRow = { tool_key: "asset.import", action_key: "run", run_started: 12, run_succeeded: 10, run_failed: 1, run_cancelled: 0, run_interrupted: 1, distinct_users: 3, last_used_at: now, last_received_at: now, time_corrected_count: 0 };
const sharedFingerprint = "a".repeat(64);
const errorRows: ErrorRow[] = [
  { tool_key: "asset.primary", action_key: "run", error_category: "runtime", fingerprint: sharedFingerprint, count: 2, first_seen_at: now, recent_seen_at: now, first_received_at: now, recent_received_at: now, time_corrected_count: 0, affected_versions: ["1.0.0"], summaries: [{ summary: "Primary failure", count: 2 }], status: "open", distinct_users: 2 },
  { tool_key: "asset.secondary", action_key: "retry", error_category: "runtime", fingerprint: sharedFingerprint, count: 2, first_seen_at: now, recent_seen_at: now, first_received_at: now, recent_received_at: now, time_corrected_count: 0, affected_versions: ["1.0.0"], summaries: [{ summary: "Secondary failure", count: 2 }], status: "open", distinct_users: 2 },
];

function state() {
  return (window as typeof window & { __portalE2E: { role: "visitor" | "admin"; signedIn: boolean; deferPreview: boolean; previewResolver?: () => void; errorDetailRequests: Array<Record<string, unknown>>; roleChangeFunction: string | null; roleChangeConsumed: boolean } }).__portalE2E;
}

function abortableDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, 5);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export async function portalRequest<T>(_user: unknown, functionName: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  await abortableDelay(signal);
  const current = state();
  if (current.roleChangeFunction === functionName && !current.roleChangeConsumed) {
    current.roleChangeConsumed = true;
    current.role = "visitor";
    throw new PortalRoleChangedError("门户角色已变化");
  }
  const session: PortalSession = { uid: "portal-e2e-user", email: "artist@xindong.com", display_name: "测试美术", photo_url: null, role: current.role, status: "active", first_login_at: now, last_login_at: now };
  let result: unknown;
  if (functionName === "portalSignIn" || functionName === "portalSession") result = session;
  else if (functionName === "portalTeamSummary") result = { items: [teamRow], next_cursor: null, summary: { run_started: 12, run_succeeded: 10, run_failed: 1, run_cancelled: 0, run_interrupted: 1, distinct_users: 3 }, failure_trend: [{ date: "2026-07-23", run_failed: 1, run_interrupted: 1 }] };
  else if (functionName === "portalErrors") result = { items: errorRows, next_cursor: null };
  else if (functionName === "portalPrincipalUsage") result = { items: [{ ...teamRow, plugin_principal_id: "principal-e2e", display_name: "测试美术", email: "artist@xindong.com", profile_updated_at: now, identity_changed: false, daily_trend: [{ date: "2026-07-23", run_started: 12, run_failed: 1, run_interrupted: 1 }] }], next_cursor: null };
  else if (functionName === "portalDevices") result = { items: [{ binding_id: "binding-e2e", plugin_principal_id: "principal-e2e", status: "active", created_at: now, last_seen_at: now, revoked_at: null }], next_cursor: null };
  else if (functionName === "portalErrorDetails") {
    current.errorDetailRequests.push({ ...input });
    const page = input.cursor ? 2 : 1;
    result = { items: [{ event_id: `event-e2e-${page}`, plugin_principal_id: "principal-e2e", display_name: "测试美术", email: "artist@xindong.com", binding_id: "binding-e2e", tool_key: String(input.tool_key), action_key: String(input.action_key), event_type: "run_failed", plugin_version: String(input.plugin_version), observed_at: now, received_at: now }], next_cursor: page === 1 ? "detail-page-2" : null };
  }
  else if (functionName === "portalPeople") result = { items: [{ ...session, normalized_email: session.email }], next_cursor: null };
  else if (functionName === "portalPolicies" && input.operation === "list") result = { items: [], next_cursor: null };
  else if (functionName === "portalPolicies" && input.operation === "preview") {
    if (current.deferPreview) await new Promise<void>((resolve) => { current.previewResolver = resolve; });
    result = { normalized_email: String(input.email), access: "granted", role: "admin", matched_by: "email", matched_value: String(input.email) };
  } else result = {};
  return result as T;
}
