export type PortalRole = "visitor" | "admin";
export type PortalStatus = "active" | "disabled" | "removed";

export interface PortalIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  photoUrl?: string;
}

export interface PortalUser {
  uid: string;
  normalized_email: string;
  display_name: string;
  photo_url: string | null;
  role: PortalRole;
  status: PortalStatus;
  first_login_at: string | null;
  last_login_at: string | null;
  updated_at: string;
}

export interface PortalUserPublic {
  uid: string;
  normalized_email: string;
  display_name: string;
  photo_url: string | null;
  role: PortalRole;
  status: PortalStatus;
  first_login_at: string | null;
  last_login_at: string | null;
}

export interface PortalAccessPolicy {
  policy_id: string;
  kind: "email" | "domain";
  value_hash: string;
  normalized_value: string;
  role: PortalRole;
  enabled: boolean;
  updated_at: string;
  updated_by: string;
}

export interface PortalAccessPolicyPublic {
  policy_id: string;
  kind: "email" | "domain";
  normalized_value: string;
  role: PortalRole;
  enabled: boolean;
  updated_at: string;
}

export interface PortalPolicyPreview {
  normalized_email: string;
  access: "granted" | "denied";
  role: PortalRole | null;
  matched_by: "email" | "domain" | "none";
  matched_value: string | null;
}

export interface PortalAuditRecord {
  audit_id: string;
  actor_uid: string;
  action: string;
  target_uid?: string;
  target_policy_id?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  result: "succeeded" | "denied" | "failed";
  reason?: string;
  occurred_at: string;
  query?: PortalQueryAuditMetadata;
}

export interface PortalQueryAuditMetadata {
  from?: string;
  to?: string;
  tool_key?: string;
  action_key?: string;
  result?: "succeeded" | "failed" | "cancelled" | "interrupted";
  plugin_principal_id?: string;
  fingerprint?: string;
  plugin_version?: string;
  scope?: "all_plugin_devices" | "team_summary" | "error_summary" | "portal_people" | "portal_policies" | "portal_policy_preview";
  search_present?: boolean;
  limit: number;
  cursor_present: boolean;
}

export interface PortalSession {
  uid: string;
  email: string;
  display_name: string;
  photo_url: string | null;
  role: PortalRole;
  status: "active";
  first_login_at: string | null;
  last_login_at: string | null;
}

export interface PortalDateFilter {
  from: string;
  to: string;
  toolKey?: string;
  actionKey?: string;
  result?: "succeeded" | "failed" | "cancelled" | "interrupted";
  fingerprint?: string;
  pluginVersion?: string;
  pluginPrincipalId?: string;
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
  daily_trend: Array<{
    date: string;
    run_started: number;
    run_failed: number;
    run_interrupted: number;
  }>;
}

export interface PluginDeviceRow {
  binding_id: string;
  plugin_principal_id: string;
  status: "active" | "revoked";
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface ErrorSummaryRow {
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

export interface PortalPersonMutationInput {
  actorUid: string;
  targetUid: string;
  role?: PortalRole;
  status?: PortalStatus;
  auditId: string;
  occurredAt: string;
}

export type PortalPersonMutationResult =
  | { status: "updated"; user: PortalUser }
  | { status: "actor_not_admin" }
  | { status: "target_not_found" }
  | { status: "last_admin" };

export interface PortalPolicyMutationInput {
  actorUid: string;
  policy: PortalAccessPolicy;
  auditId: string;
  occurredAt: string;
}

export type PortalPolicyMutationResult =
  | { status: "updated"; policy: PortalAccessPolicy }
  | { status: "actor_not_admin" };

export interface PortalSignInMutationInput {
  uid: string;
  normalizedEmail: string;
  displayName: string;
  photoUrl: string | null;
  emailPolicyCandidates: PortalPolicyLookupCandidate[];
  domainPolicyCandidates: PortalPolicyLookupCandidate[];
  auditId: string;
  occurredAt: string;
}

export interface PortalPolicyLookupCandidate {
  policyId: string;
  valueHash: string;
}

export interface PortalBootstrapMutationInput {
  bootstrapId: string;
  uid: string;
  normalizedEmail: string;
  displayName: string;
  photoUrl: string | null;
  auditId: string;
  occurredAt: string;
}

export type PortalBootstrapMutationResult =
  | { status: "created"; user: PortalUser }
  | { status: "already_consumed" }
  | { status: "active_admin_exists" }
  | { status: "identity_not_eligible" };

export type PortalSignInMutationResult =
  | { status: "signed_in"; user: PortalUser }
  | { status: "access_denied" }
  | { status: "disabled" };

export interface PortalStore {
  getUser(uid: string): Promise<PortalUser | null>;
  putUser(user: PortalUser): Promise<void>;
  listUsers(input: { limit: number; cursor?: string; search?: string }): Promise<PortalPage<PortalUser>>;
  countActiveAdmins(): Promise<number>;
  getPolicy(policyId: string): Promise<PortalAccessPolicy | null>;
  putPolicy(policy: PortalAccessPolicy): Promise<void>;
  listPolicies(input: { limit: number; cursor?: string }): Promise<PortalPage<PortalAccessPolicy>>;
  writeAudit(record: PortalAuditRecord): Promise<void>;
  bootstrapFirstAdmin(input: PortalBootstrapMutationInput): Promise<PortalBootstrapMutationResult>;
  signInUser(input: PortalSignInMutationInput): Promise<PortalSignInMutationResult>;
  mutatePerson(input: PortalPersonMutationInput): Promise<PortalPersonMutationResult>;
  mutatePolicy(input: PortalPolicyMutationInput): Promise<PortalPolicyMutationResult>;
  listTeamAggregates(filter: PortalDateFilter, limit: number, cursor?: string, minimumDistinctUsers?: number): Promise<TeamSummaryPage>;
  listPrincipalAggregates(filter: PortalDateFilter, limit: number, cursor?: string): Promise<PortalPage<PrincipalUsageRow>>;
  listPluginDevices(input: { limit: number; cursor?: string }): Promise<PortalPage<PluginDeviceRow>>;
  listErrorAggregates(filter: PortalDateFilter, limit: number, cursor?: string, minimumDistinctUsers?: number): Promise<PortalPage<ErrorSummaryRow>>;
  listErrorDetails(filter: PortalDateFilter, limit: number, cursor?: string): Promise<PortalPage<ErrorDetailRow>>;
}
