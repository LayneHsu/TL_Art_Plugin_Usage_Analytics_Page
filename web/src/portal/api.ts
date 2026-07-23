import type { User } from "firebase/auth";

export interface PortalSession {
  uid: string;
  email: string;
  display_name: string;
  photo_url: string | null;
  role: "visitor" | "admin";
  status: "active";
  first_login_at: string | null;
  last_login_at: string | null;
}

export interface TeamSummaryRow {
  tool_key: string;
  action_key: string;
  run_started: number;
  run_succeeded: number;
  run_failed: number;
  run_cancelled: number;
  run_interrupted: number;
  distinct_users: number;
  last_used_at: string | null;
  last_received_at: string | null;
  time_corrected_count: number;
}

export interface PrincipalUsageRow {
  plugin_principal_id: string;
  tool_key: string;
  action_key: string;
  display_name: string;
  email: string | null;
  profile_updated_at: string | null;
  identity_changed: boolean;
  run_started: number;
  run_succeeded: number;
  run_failed: number;
  run_cancelled: number;
  run_interrupted: number;
  last_used_at: string | null;
  last_received_at: string | null;
  time_corrected_count: number;
  daily_trend: Array<{ date: string; run_started: number; run_failed: number; run_interrupted: number }>;
}

export interface PluginDeviceRow {
  binding_id: string;
  plugin_principal_id: string;
  status: "active" | "revoked";
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface ErrorRow {
  tool_key: string;
  action_key: string;
  error_category: string;
  fingerprint: string;
  count: number;
  first_seen_at: string;
  recent_seen_at: string;
  first_received_at: string;
  recent_received_at: string;
  time_corrected_count: number;
  affected_versions: string[];
  summaries: Array<{ summary: string; count: number }>;
  status: "open" | "resolved";
  distinct_users: number;
}

export interface ErrorDetailRow {
  event_id: string;
  plugin_principal_id: string;
  display_name: string;
  email: string | null;
  binding_id: string;
  tool_key: string;
  action_key: string;
  event_type: string;
  plugin_version: string;
  observed_at: string;
  received_at: string;
}

export interface PersonRow {
  uid: string;
  normalized_email: string;
  display_name: string;
  photo_url: string | null;
  role: "visitor" | "admin";
  status: "active" | "disabled" | "removed";
  first_login_at: string | null;
  last_login_at: string | null;
}

export interface AccessPolicyRow {
  policy_id: string;
  kind: "email" | "domain";
  normalized_value: string;
  role: "visitor" | "admin";
  enabled: boolean;
  updated_at: string;
}

export interface PolicyPreview {
  normalized_email: string;
  access: "granted" | "denied";
  role: "visitor" | "admin" | null;
  matched_by: "email" | "domain" | "none";
  matched_value: string | null;
}

export interface PortalPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface TeamSummaryPage extends PortalPage<TeamSummaryRow> {
  summary: {
    run_started: number;
    run_succeeded: number;
    run_failed: number;
    run_cancelled: number;
    run_interrupted: number;
    distinct_users: number;
  };
  failure_trend: Array<{ date: string; run_failed: number; run_interrupted: number }>;
}

export class PortalAccessRevokedError extends Error {}
export class PortalRoleChangedError extends Error {}

const endpoint = import.meta.env.PORTAL_FUNCTIONS_BASE_URL?.replace(/\/$/, "") ?? "";

export async function portalRequest<T>(user: User, functionName: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  if (!endpoint) throw new Error("统计服务地址未配置");
  const token = await user.getIdToken();
  const response = await fetch(`${endpoint}/${functionName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal,
  });
  const payload = await response.json() as { ok?: boolean; result?: T; error?: { code?: string; message?: string } };
  if (["portal_admin_required", "portal_role_changed"].includes(payload.error?.code ?? "")) {
    throw new PortalRoleChangedError(payload.error?.message ?? "门户角色已变化");
  }
  if (["portal_access_denied", "portal_disabled", "invalid_identity", "company_account_required"].includes(payload.error?.code ?? "")) {
    throw new PortalAccessRevokedError(payload.error?.message ?? "访问权限已失效");
  }
  if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "请求失败");
  return payload.result as T;
}
