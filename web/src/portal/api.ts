import type { User } from "firebase/auth";

export type PortalRole = "admin" | "viewer";

export interface PortalMember {
  email: string;
  role: PortalRole;
  enabled: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface PortalSession {
  uid: string;
  email: string;
  display_name: string;
  photo_url: string | null;
  role: PortalRole;
}

export interface PluginUserProfile {
  uid: string;
  email: string;
  display_name: string;
  avatar_url: string;
  last_login_at: string;
  last_active_at: string;
  plugin_version: string;
  updated_at: string;
}

export type EventType =
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

export type EventResult = "started" | "succeeded" | "failed" | "rejected" | "cancelled" | "interrupted" | "unexpected";

export interface UsageEvent {
  event_id: string;
  operation_id: string;
  tool_key: string;
  action_key: string;
  event_type: EventType;
  occurred_at: string;
  result: EventResult;
  duration_ms?: number;
  plugin_version: string;
  error_log_id?: string;
  error_summary?: string;
}

export interface UsageDailyShard {
  company_date: string;
  uid: string;
  tool_key: string;
  shard: string;
  events: UsageEvent[];
  first_occurred_at: string;
  last_occurred_at: string;
  last_result: EventResult;
  plugin_version: string;
  updated_at?: string;
}

export interface ErrorLog {
  event_id: string;
  uid: string;
  company_date: string;
  tool_key: string;
  action_key: string;
  occurred_at: string;
  error_type: string;
  summary: string;
  call_site: string;
  fingerprint: string;
  stack: string;
  plugin_version: string;
}

export interface PortalData {
  profiles: PluginUserProfile[];
  shards: UsageDailyShard[];
  errors: ErrorLog[];
}

export interface UsageFilter {
  dateFrom: string;
  dateTo: string;
  userUid?: string;
  toolKey?: string;
  actionKey?: string;
  result?: string;
}

export interface UsageRow {
  tool_key: string;
  action_key: string;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  users: number;
  last_occurred_at: string | null;
}

export interface UserUsageRow {
  uid: string;
  display_name: string;
  email: string;
  total: number;
  succeeded: number;
  failed: number;
  last_occurred_at: string | null;
}

export interface EventRow extends UsageEvent {
  uid: string;
  display_name: string;
  email: string;
}

export interface ErrorRow {
  key: string;
  tool_key: string;
  action_key: string;
  error_type: string;
  fingerprint: string;
  count: number;
  users: number;
  first_occurred_at: string;
  last_occurred_at: string;
  summaries: string[];
}

export interface PortalAnalytics {
  events: EventRow[];
  usageRows: UsageRow[];
  userRows: UserUsageRow[];
  errors: ErrorRow[];
  dailyTrend: Array<{ date: string; total: number; failed: number }>;
  total: number;
  activeUsers: number;
  activeTools: number;
  succeeded: number;
  failed: number;
}

export interface PortalExportRecord {
  event_id: string;
  uid: string;
  display_name: string;
  email: string;
  tool_key: string;
  action_key: string;
  occurred_at: string;
  result: string;
  duration_ms: number | null;
  plugin_version: string;
}

export function sessionFromFirebaseUser(user: User, member: PortalMember): PortalSession {
  return {
    uid: user.uid,
    email: user.email?.toLowerCase() ?? member.email,
    display_name: user.displayName || user.email || member.email,
    photo_url: user.photoURL,
    role: member.role,
  };
}
