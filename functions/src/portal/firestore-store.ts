import { FieldPath, type DocumentData, type Firestore, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";

import type {
  ErrorDetailRow,
  ErrorSummaryRow,
  PortalBootstrapMutationInput,
  PortalBootstrapMutationResult,
  PortalAccessPolicy,
  PortalAuditRecord,
  PortalDateFilter,
  PortalPage,
  PortalPersonMutationInput,
  PortalPersonMutationResult,
  PortalPolicyMutationInput,
  PortalPolicyMutationResult,
  PortalSignInMutationInput,
  PortalSignInMutationResult,
  PluginDeviceRow,
  PortalStore,
  PortalUser,
  PrincipalUsageRow,
  TeamSummaryRow,
  TeamSummaryPage,
} from "./types";
import { signInPolicyRole } from "./policy";
import { normalizePortalUserSearch, portalUserSearchTerms } from "./user-search";
import { FirestoreAggregateGenerationReader } from "../usage/read-routing";

const COLLECTIONS = {
  users: "portalUsers",
  policies: "portalAccessPolicies",
  authAudits: "portalAuthAudit",
  bootstrapState: "portalBootstrapState",
  queryAudits: "portalQueryAudit",
  toolAggregates: "toolUsageDaily",
  principalAggregates: "principalUsageDaily",
  errors: "errorAggregates",
  principals: "pluginPrincipals",
  devices: "pluginDeviceBindings",
  usageEvents: "usageEvents",
} as const;

const AGGREGATE_SCAN_LIMIT = 50_000;
const SCAN_PAGE_SIZE = 500;

function fromFirestore<T>(value: unknown): T {
  if (value && typeof value === "object" && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate() as T;
  }
  return value as T;
}

function page<T>(docs: Array<{ id: string; data: () => DocumentData }>, limit: number): PortalPage<T> {
  const items = docs.slice(0, limit).map((doc) => fromFirestore<T>(doc.data()));
  return { items, next_cursor: docs.length > limit && items.length ? docs[limit - 1].id : null };
}

function portalUserFromFirestore(value: DocumentData | undefined): PortalUser {
  const user = fromFirestore<PortalUser>(value);
  return {
    uid: user.uid,
    normalized_email: user.normalized_email,
    display_name: user.display_name,
    photo_url: user.photo_url,
    role: user.role,
    status: user.status,
    first_login_at: user.first_login_at,
    last_login_at: user.last_login_at,
    updated_at: user.updated_at,
  };
}

function portalUserForFirestore(user: PortalUser): PortalUser & { search_terms: string[] } {
  return { ...user, search_terms: portalUserSearchTerms(user) };
}

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) return cursor ? "" : null;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  return decoded && Buffer.from(decoded, "utf8").toString("base64url") === cursor ? decoded : "";
}

function pageRows<T>(values: T[], limit: number, cursor: string | undefined, key: (value: T) => string): PortalPage<T> {
  const ordered = [...values].sort((left, right) => key(left).localeCompare(key(right)));
  const after = decodeCursor(cursor);
  if (after === "") throw new Error("Invalid portal page cursor");
  const found = after === null ? 0 : ordered.findIndex((value) => key(value) > after);
  const start = found < 0 ? ordered.length : found;
  const items = ordered.slice(start, start + limit);
  const nextCursor = start + limit < ordered.length && items.length
    ? Buffer.from(key(items[items.length - 1]), "utf8").toString("base64url")
    : null;
  return { items, next_cursor: nextCursor };
}

async function scanQuery(query: Query, maximum: number, label: string): Promise<QueryDocumentSnapshot[]> {
  const documents: QueryDocumentSnapshot[] = [];
  let after: QueryDocumentSnapshot | undefined;
  while (true) {
    const remaining = maximum - documents.length;
    const take = Math.min(SCAN_PAGE_SIZE, remaining + 1);
    const current = after ? query.startAfter(after).limit(take) : query.limit(take);
    const snapshot = await current.get();
    if (snapshot.docs.length > remaining) throw new Error(`${label} exceeded the ${maximum} document query limit`);
    documents.push(...snapshot.docs);
    if (snapshot.docs.length < take) return documents;
    after = snapshot.docs[snapshot.docs.length - 1];
  }
}

function addStatus(target: { run_started: number; run_succeeded: number; run_failed: number; run_cancelled: number; run_interrupted: number }, data: DocumentData): void {
  target.run_started += Number(data.run_started ?? 0);
  target.run_succeeded += Number(data.run_succeeded ?? 0);
  target.run_failed += Number(data.run_failed ?? 0);
  target.run_cancelled += Number(data.run_cancelled ?? 0);
  target.run_interrupted += Number(data.run_interrupted ?? 0);
}

function matchesResult(target: { run_succeeded: number; run_failed: number; run_cancelled: number; run_interrupted: number }, result: PortalDateFilter["result"]): boolean {
  if (!result) return true;
  return target[`run_${result}` as "run_succeeded" | "run_failed" | "run_cancelled" | "run_interrupted"] > 0;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof (value as { toDate?: unknown }).toDate === "function") return (value as { toDate: () => Date }).toDate().toISOString();
  return new Date(String(value)).toISOString();
}

function companyDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function companyDateBounds(filter: PortalDateFilter): { start: string; endExclusive: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filter.from) || !/^\d{4}-\d{2}-\d{2}$/.test(filter.to) || filter.from > filter.to) {
    throw new Error("Invalid portal date range");
  }
  const start = new Date(`${filter.from}T00:00:00+08:00`);
  const end = new Date(`${filter.to}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || companyDate(start.toISOString()) !== filter.from || companyDate(end.toISOString()) !== filter.to) {
    throw new Error("Invalid portal date range");
  }
  return { start: start.toISOString(), endExclusive: new Date(end.getTime() + 86_400_000).toISOString() };
}

function validPortalKey(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9._-]{1,128}$/.test(value));
}

function validPluginVersion(value: string | undefined): value is string {
  return Boolean(value && value.length <= 64 && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value));
}

export class FirestorePortalStore implements PortalStore {
  private readonly aggregateReader: FirestoreAggregateGenerationReader;

  public constructor(private readonly firestore: Firestore) {
    this.aggregateReader = new FirestoreAggregateGenerationReader(firestore);
  }

  private async scanActiveAggregates(
    collectionName: typeof COLLECTIONS.toolAggregates | typeof COLLECTIONS.errors,
    filter: PortalDateFilter,
    label: string,
    refine?: (query: Query) => Query,
  ): Promise<QueryDocumentSnapshot[]> {
    const bounds = companyDateBounds(filter);
    const segments = await this.aggregateReader.getActiveGenerationSegmentsForRange(
      new Date(bounds.start),
      new Date(bounds.endExclusive),
    );
    const documents: QueryDocumentSnapshot[] = [];
    for (const segment of segments) {
      let query = this.firestore.collection(collectionName).where("generation", "==", segment.generation);
      if (refine) query = refine(query);
      query = query
        .where("date", ">=", companyDate(segment.from))
        .where("date", "<", companyDate(segment.to))
        .orderBy("date", "asc")
        .orderBy(FieldPath.documentId(), "asc");
      documents.push(...await scanQuery(query, AGGREGATE_SCAN_LIMIT - documents.length, label));
    }
    return documents;
  }

  public async getUser(uid: string): Promise<PortalUser | null> {
    const snapshot = await this.firestore.collection(COLLECTIONS.users).doc(uid).get();
    return snapshot.exists ? portalUserFromFirestore(snapshot.data()) : null;
  }

  public async putUser(user: PortalUser): Promise<void> {
    await this.firestore.collection(COLLECTIONS.users).doc(user.uid).set(portalUserForFirestore(user));
  }

  public async listUsers(input: { limit: number; cursor?: string; search?: string }): Promise<PortalPage<PortalUser>> {
    const limit = Math.max(1, Math.min(Math.trunc(input.limit), 100));
    const search = normalizePortalUserSearch(input.search ?? "");
    let query: Query = this.firestore.collection(COLLECTIONS.users);
    if (search) query = query.where("search_terms", "array-contains", search);
    query = query.orderBy(FieldPath.documentId()).limit(limit + 1);
    if (input.cursor) query = query.startAfter(input.cursor);
    const snapshot = await query.get();
    const items = snapshot.docs.slice(0, limit).map((document) => portalUserFromFirestore(document.data()));
    return { items, next_cursor: snapshot.docs.length > limit && items.length ? snapshot.docs[limit - 1].id : null };
  }

  public async countActiveAdmins(): Promise<number> {
    const snapshot = await this.firestore.collection(COLLECTIONS.users).where("role", "==", "admin").where("status", "==", "active").count().get();
    return snapshot.data().count;
  }

  public async getPolicy(policyId: string): Promise<PortalAccessPolicy | null> {
    const snapshot = await this.firestore.collection(COLLECTIONS.policies).doc(policyId).get();
    return snapshot.exists ? fromFirestore<PortalAccessPolicy>(snapshot.data()) : null;
  }

  public async putPolicy(policy: PortalAccessPolicy): Promise<void> {
    await this.firestore.collection(COLLECTIONS.policies).doc(policy.policy_id).set(policy);
  }

  public async listPolicies(input: { limit: number; cursor?: string }): Promise<PortalPage<PortalAccessPolicy>> {
    let query = this.firestore.collection(COLLECTIONS.policies).orderBy(FieldPath.documentId()).limit(Math.min(input.limit, 100) + 1);
    if (input.cursor) query = query.startAfter(input.cursor);
    const snapshot = await query.get();
    return page<PortalAccessPolicy>(snapshot.docs, Math.min(input.limit, 100));
  }

  public async writeAudit(record: PortalAuditRecord): Promise<void> {
    const authActions = new Set(["portal_sign_in", "portal_person_updated", "portal_policy_updated"]);
    const collection = authActions.has(record.action) ? COLLECTIONS.authAudits : COLLECTIONS.queryAudits;
    await this.firestore.collection(collection).doc(record.audit_id).set(record);
  }

  public async bootstrapFirstAdmin(input: PortalBootstrapMutationInput): Promise<PortalBootstrapMutationResult> {
    const users = this.firestore.collection(COLLECTIONS.users);
    const audits = this.firestore.collection(COLLECTIONS.authAudits);
    const bootstrapState = this.firestore.collection(COLLECTIONS.bootstrapState);
    const execute = (): Promise<PortalBootstrapMutationResult> => this.firestore.runTransaction(async (transaction) => {
      const markerRef = bootstrapState.doc(input.bootstrapId);
      const userRef = users.doc(input.uid);
      const auditRef = audits.doc(input.auditId);
      const activeAdminsQuery = users.where("role", "==", "admin").where("status", "==", "active");
      const markerSnapshot = await transaction.get(markerRef);
      const userSnapshot = await transaction.get(userRef);
      const activeAdmins = await transaction.get(activeAdminsQuery);
      const audit = (result: "succeeded" | "denied", reason?: string) => ({
        audit_id: input.auditId,
        actor_uid: input.uid,
        action: "portal_first_admin_bootstrap",
        target_uid: input.uid,
        result,
        ...(reason ? { reason } : {}),
        occurred_at: input.occurredAt,
      });
      if (markerSnapshot.exists) {
        transaction.set(auditRef, audit("denied", "bootstrap_already_consumed"));
        return { status: "already_consumed" };
      }
      const existing = userSnapshot.exists ? portalUserFromFirestore(userSnapshot.data()) : null;
      if (existing && existing.status !== "active") {
        transaction.set(markerRef, { bootstrap_id: input.bootstrapId, status: "consumed", reason: "bootstrap_identity_not_eligible", consumed_at: input.occurredAt, consumed_by_uid: input.uid });
        transaction.set(auditRef, audit("denied", "bootstrap_identity_not_eligible"));
        return { status: "identity_not_eligible" };
      }
      if (!activeAdmins.empty) {
        transaction.set(markerRef, { bootstrap_id: input.bootstrapId, status: "consumed", reason: "active_admin_exists", consumed_at: input.occurredAt, consumed_by_uid: input.uid });
        transaction.set(auditRef, audit("denied", "active_admin_exists"));
        return { status: "active_admin_exists" };
      }
      const next: PortalUser = existing
        ? { ...existing, normalized_email: input.normalizedEmail, display_name: input.displayName, photo_url: input.photoUrl, role: "admin", last_login_at: input.occurredAt, updated_at: input.occurredAt }
        : { uid: input.uid, normalized_email: input.normalizedEmail, display_name: input.displayName, photo_url: input.photoUrl, role: "admin", status: "active", first_login_at: input.occurredAt, last_login_at: input.occurredAt, updated_at: input.occurredAt };
      transaction.set(userRef, portalUserForFirestore(next));
      transaction.set(markerRef, { bootstrap_id: input.bootstrapId, status: "consumed", reason: "first_admin_created", consumed_at: input.occurredAt, consumed_by_uid: input.uid });
      transaction.set(auditRef, { ...audit("succeeded"), after: { role: "admin", status: "active" } });
      return { status: "created", user: next };
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await execute();
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const aborted = code === 10 || code === "aborted" || (error instanceof Error && /\bABORTED\b/i.test(error.message));
        if (!aborted || attempt === 1) throw error;
      }
    }
    throw new Error("Portal bootstrap transaction retry exhausted");
  }

  public async signInUser(input: PortalSignInMutationInput): Promise<PortalSignInMutationResult> {
    const users = this.firestore.collection(COLLECTIONS.users);
    const policies = this.firestore.collection(COLLECTIONS.policies);
    const audits = this.firestore.collection(COLLECTIONS.authAudits);
    return this.firestore.runTransaction(async (transaction) => {
      const userRef = users.doc(input.uid);
      const auditRef = audits.doc(input.auditId);
      const snapshot = await transaction.get(userRef);
      const readCandidate = async (candidates: PortalSignInMutationInput["emailPolicyCandidates"]) => {
        for (const candidate of candidates) {
          const reference = policies.doc(candidate.policyId);
          const policySnapshot = await transaction.get(reference);
          if (policySnapshot.exists) return { candidate, reference, policy: fromFirestore<PortalAccessPolicy>(policySnapshot.data()) };
        }
        return null;
      };
      const emailMatch = await readCandidate(input.emailPolicyCandidates);
      const domainMatch = await readCandidate(input.domainPolicyCandidates);
      const existing = snapshot.exists ? portalUserFromFirestore(snapshot.data()) : null;
      const policyRole = signInPolicyRole(
        input,
        emailMatch?.policy ?? null,
        domainMatch?.policy ?? null,
      );
      const migrate = (match: typeof emailMatch, candidates: PortalSignInMutationInput["emailPolicyCandidates"]): void => {
        const current = candidates[0];
        if (!match || !current || match.candidate.policyId === current.policyId) return;
        transaction.set(policies.doc(current.policyId), { ...match.policy, policy_id: current.policyId, value_hash: current.valueHash, updated_at: input.occurredAt, updated_by: "system:policy-key-rotation" });
        transaction.delete(match.reference);
      };
      migrate(emailMatch, input.emailPolicyCandidates);
      migrate(domainMatch, input.domainPolicyCandidates);
      const denied = (status: "access_denied" | "disabled"): PortalSignInMutationResult => {
        transaction.set(auditRef, { audit_id: input.auditId, actor_uid: input.uid, action: "portal_sign_in", target_uid: input.uid, result: "denied", occurred_at: input.occurredAt });
        return { status };
      };
      if (existing?.status === "disabled" || existing?.status === "removed") return denied("disabled");
      if (!existing && !policyRole) return denied("access_denied");
      const next: PortalUser = existing
        ? { ...existing, normalized_email: input.normalizedEmail, display_name: input.displayName, photo_url: input.photoUrl, last_login_at: input.occurredAt, updated_at: input.occurredAt }
        : { uid: input.uid, normalized_email: input.normalizedEmail, display_name: input.displayName, photo_url: input.photoUrl, role: policyRole ?? "visitor", status: "active", first_login_at: input.occurredAt, last_login_at: input.occurredAt, updated_at: input.occurredAt };
      transaction.set(userRef, portalUserForFirestore(next));
      transaction.set(auditRef, { audit_id: input.auditId, actor_uid: input.uid, action: "portal_sign_in", target_uid: input.uid, ...(existing ? { before: { role: existing.role, status: existing.status } } : {}), after: { role: next.role, status: next.status }, result: "succeeded", occurred_at: input.occurredAt });
      return { status: "signed_in", user: next };
    });
  }

  public async mutatePerson(input: PortalPersonMutationInput): Promise<PortalPersonMutationResult> {
    const users = this.firestore.collection(COLLECTIONS.users);
    const audits = this.firestore.collection(COLLECTIONS.authAudits);
    return this.firestore.runTransaction(async (transaction) => {
      const actorRef = users.doc(input.actorUid);
      const targetRef = users.doc(input.targetUid);
      const auditRef = audits.doc(input.auditId);
      const [actorSnapshot, targetSnapshot] = await Promise.all([transaction.get(actorRef), transaction.get(targetRef)]);
      const deniedAudit = {
        audit_id: input.auditId,
        actor_uid: input.actorUid,
        action: "portal_person_updated",
        target_uid: input.targetUid,
        result: "denied" as const,
        occurred_at: input.occurredAt,
      };
      const actor = actorSnapshot.exists ? portalUserFromFirestore(actorSnapshot.data()) : null;
      if (!actor || actor.role !== "admin" || actor.status !== "active") {
        transaction.set(auditRef, deniedAudit);
        return { status: "actor_not_admin" };
      }
      const target = targetSnapshot.exists ? portalUserFromFirestore(targetSnapshot.data()) : null;
      if (!target) {
        transaction.set(auditRef, deniedAudit);
        return { status: "target_not_found" };
      }
      const next: PortalUser = { ...target, role: input.role ?? target.role, status: input.status ?? target.status, updated_at: input.occurredAt };
      if (target.role === "admin" && target.status === "active" && (next.role !== "admin" || next.status !== "active")) {
        const admins = users.where("role", "==", "admin").where("status", "==", "active");
        const activeAdmins = await transaction.get(admins);
        if (activeAdmins.size <= 1) {
          transaction.set(auditRef, { ...deniedAudit, before: { role: target.role, status: target.status }, after: { role: next.role, status: next.status } });
          return { status: "last_admin" };
        }
      }
      transaction.set(targetRef, portalUserForFirestore(next));
      transaction.set(auditRef, {
        audit_id: input.auditId,
        actor_uid: input.actorUid,
        action: "portal_person_updated",
        target_uid: input.targetUid,
        before: { role: target.role, status: target.status },
        after: { role: next.role, status: next.status },
        result: "succeeded",
        occurred_at: input.occurredAt,
      });
      return { status: "updated", user: next };
    });
  }

  public async mutatePolicy(input: PortalPolicyMutationInput): Promise<PortalPolicyMutationResult> {
    const users = this.firestore.collection(COLLECTIONS.users);
    const policies = this.firestore.collection(COLLECTIONS.policies);
    const audits = this.firestore.collection(COLLECTIONS.authAudits);
    return this.firestore.runTransaction(async (transaction) => {
      const actorSnapshot = await transaction.get(users.doc(input.actorUid));
      const policyRef = policies.doc(input.policy.policy_id);
      const previousSnapshot = await transaction.get(policyRef);
      const auditRef = audits.doc(input.auditId);
      const actor = actorSnapshot.exists ? portalUserFromFirestore(actorSnapshot.data()) : null;
      if (!actor || actor.role !== "admin" || actor.status !== "active") {
        transaction.set(auditRef, { audit_id: input.auditId, actor_uid: input.actorUid, action: "portal_policy_updated", target_policy_id: input.policy.policy_id, result: "denied", occurred_at: input.occurredAt });
        return { status: "actor_not_admin" };
      }
      const previous = previousSnapshot.exists ? fromFirestore<PortalAccessPolicy>(previousSnapshot.data()) : null;
      transaction.set(policyRef, input.policy);
      transaction.set(auditRef, {
        audit_id: input.auditId,
        actor_uid: input.actorUid,
        action: "portal_policy_updated",
        target_policy_id: input.policy.policy_id,
        ...(previous ? { before: { role: previous.role, enabled: previous.enabled } } : {}),
        after: { role: input.policy.role, enabled: input.policy.enabled },
        result: "succeeded",
        occurred_at: input.occurredAt,
      });
      return { status: "updated", policy: input.policy };
    });
  }

  public async listTeamAggregates(filter: PortalDateFilter, limit: number, cursor?: string, minimumDistinctUsers = 0): Promise<TeamSummaryPage> {
    const documents = await this.scanActiveAggregates(COLLECTIONS.toolAggregates, filter, "Team aggregate query");
    const grouped = new Map<string, TeamSummaryRow & { users: Set<string> }>();
    const filteredDocuments: DocumentData[] = [];
    for (const document of documents) {
      const data = document.data();
      if ((filter.toolKey && data.tool_key !== filter.toolKey) || (filter.actionKey && data.action_key !== filter.actionKey)) continue;
      filteredDocuments.push(data);
      const key = `${String(data.tool_key ?? "")}\u0000${String(data.action_key ?? "")}`;
      const row = grouped.get(key) ?? { tool_key: String(data.tool_key ?? ""), action_key: String(data.action_key ?? ""), run_started: 0, run_succeeded: 0, run_failed: 0, run_cancelled: 0, run_interrupted: 0, distinct_users: 0, last_used_at: null, last_received_at: null, time_corrected_count: 0, users: new Set<string>() };
      addStatus(row, data);
      const principalId = String(data.plugin_principal_id ?? "");
      if (principalId) row.users.add(principalId);
      const updated = String(data.last_observed_at ?? data.corrected_observed_at ?? data.updated_at ?? "");
      if (!row.last_used_at || updated > row.last_used_at) row.last_used_at = updated;
      const received = String(data.last_received_at ?? data.updated_at ?? "");
      if (!row.last_received_at || received > row.last_received_at) row.last_received_at = received;
      row.time_corrected_count += Number(data.time_corrected_count ?? 0);
      grouped.set(key, row);
    }
    const rows = [...grouped.values()].map(({ users, ...row }) => ({ ...row, distinct_users: users.size })).filter((row) => row.distinct_users >= minimumDistinctUsers && matchesResult(row, filter.result));
    const visibleKeys = new Set(rows.map((row) => `${row.tool_key}\u0000${row.action_key}`));
    const summaryUsers = new Set<string>();
    for (const data of filteredDocuments) {
      const key = `${String(data.tool_key ?? "")}\u0000${String(data.action_key ?? "")}`;
      if (visibleKeys.has(key) && data.plugin_principal_id) summaryUsers.add(String(data.plugin_principal_id));
    }
    const summary = rows.reduce((total, row) => ({
      run_started: total.run_started + row.run_started,
      run_succeeded: total.run_succeeded + row.run_succeeded,
      run_failed: total.run_failed + row.run_failed,
      run_cancelled: total.run_cancelled + row.run_cancelled,
      run_interrupted: total.run_interrupted + row.run_interrupted,
      distinct_users: summaryUsers.size,
    }), { run_started: 0, run_succeeded: 0, run_failed: 0, run_cancelled: 0, run_interrupted: 0, distinct_users: 0 });
    const dailyGroups = new Map<string, { date: string; run_failed: number; run_interrupted: number; users: Set<string> }>();
    for (const data of filteredDocuments) {
      const toolAction = `${String(data.tool_key ?? "")}\u0000${String(data.action_key ?? "")}`;
      if (!visibleKeys.has(toolAction)) continue;
      const date = String(data.date ?? "");
      const key = `${date}\u0000${toolAction}`;
      const daily = dailyGroups.get(key) ?? { date, run_failed: 0, run_interrupted: 0, users: new Set<string>() };
      daily.run_failed += Number(data.run_failed ?? 0);
      daily.run_interrupted += Number(data.run_interrupted ?? 0);
      if (data.plugin_principal_id) daily.users.add(String(data.plugin_principal_id));
      dailyGroups.set(key, daily);
    }
    const trend = new Map<string, { date: string; run_failed: number; run_interrupted: number }>();
    for (const daily of dailyGroups.values()) {
      if (daily.users.size < minimumDistinctUsers) continue;
      const point = trend.get(daily.date) ?? { date: daily.date, run_failed: 0, run_interrupted: 0 };
      point.run_failed += daily.run_failed;
      point.run_interrupted += daily.run_interrupted;
      trend.set(daily.date, point);
    }
    return {
      ...pageRows(rows, limit, cursor, (row) => `${row.tool_key}\u0000${row.action_key}`),
      summary,
      failure_trend: [...trend.values()].sort((left, right) => left.date.localeCompare(right.date)),
    };
  }

  public async listPrincipalAggregates(filter: PortalDateFilter, limit: number, cursor?: string): Promise<PortalPage<PrincipalUsageRow>> {
    const documents = await this.scanActiveAggregates(COLLECTIONS.toolAggregates, filter, "Principal aggregate query");
    const grouped = new Map<string, PrincipalUsageRow>();
    for (const document of documents) {
      const data = document.data();
      const id = String(data.plugin_principal_id ?? "");
      const toolKey = String(data.tool_key ?? "");
      const actionKey = String(data.action_key ?? "");
      if ((filter.pluginPrincipalId && id !== filter.pluginPrincipalId) || (filter.toolKey && toolKey !== filter.toolKey) || (filter.actionKey && actionKey !== filter.actionKey)) continue;
      const key = `${id}\u0000${toolKey}\u0000${actionKey}`;
      const row = grouped.get(key) ?? { plugin_principal_id: id, tool_key: toolKey, action_key: actionKey, display_name: id, email: null, profile_updated_at: null, identity_changed: false, run_started: 0, run_succeeded: 0, run_failed: 0, run_cancelled: 0, run_interrupted: 0, last_used_at: null, last_received_at: null, time_corrected_count: 0, daily_trend: [] };
      addStatus(row, data);
      const date = String(data.date ?? "");
      if (date) {
        let point = row.daily_trend[row.daily_trend.length - 1];
        if (!point || point.date !== date) {
          point = { date, run_started: 0, run_failed: 0, run_interrupted: 0 };
          row.daily_trend.push(point);
        }
        point.run_started += Number(data.run_started ?? 0);
        point.run_failed += Number(data.run_failed ?? 0);
        point.run_interrupted += Number(data.run_interrupted ?? 0);
      }
      const updated = String(data.last_observed_at ?? data.corrected_observed_at ?? data.updated_at ?? "");
      if (!row.last_used_at || updated > row.last_used_at) row.last_used_at = updated;
      const received = String(data.last_received_at ?? data.updated_at ?? "");
      if (!row.last_received_at || received > row.last_received_at) row.last_received_at = received;
      row.time_corrected_count += Number(data.time_corrected_count ?? 0);
      grouped.set(key, row);
    }
    const groupedPage = pageRows([...grouped.values()].filter((row) => matchesResult(row, filter.result)), limit, cursor, (row) => `${row.plugin_principal_id}\u0000${row.tool_key}\u0000${row.action_key}`);
    const ids = [...new Set(groupedPage.items.map((row) => row.plugin_principal_id).filter(Boolean))];
    const references = ids.map((id) => this.firestore.collection(COLLECTIONS.principals).doc(id));
    const principals = references.length ? await this.firestore.getAll(...references) : [];
    const principalData = new Map(principals.map((snapshot) => [snapshot.id, snapshot.data() ?? {}]));
    const emailCounts = new Map<string, number>();
    const emails = [...new Set([...principalData.values()].map((current) => typeof current.email === "string" ? current.email.trim().toLowerCase() : "").filter(Boolean))];
    for (let index = 0; index < emails.length; index += 30) {
      const snapshot = await this.firestore.collection(COLLECTIONS.principals).where("email", "in", emails.slice(index, index + 30)).get();
      for (const document of snapshot.docs) {
        const email = typeof document.data().email === "string" ? document.data().email.trim().toLowerCase() : "";
        if (email) emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
      }
    }
    const items = groupedPage.items.map((row) => {
      const current = principalData.get(row.plugin_principal_id) ?? {};
      const email = typeof current.email === "string" ? current.email : null;
      return { ...row, daily_trend: [...row.daily_trend].sort((left, right) => left.date.localeCompare(right.date)), display_name: String(current.displayName ?? row.plugin_principal_id), email, profile_updated_at: toIso(current.profileUpdatedAt), identity_changed: Boolean(email && (emailCounts.get(email.trim().toLowerCase()) ?? 0) > 1) };
    });
    return { items, next_cursor: groupedPage.next_cursor };
  }

  public async listPluginDevices(input: { limit: number; cursor?: string }): Promise<PortalPage<PluginDeviceRow>> {
    let query = this.firestore.collection(COLLECTIONS.devices).orderBy(FieldPath.documentId()).limit(Math.min(input.limit, 100) + 1);
    if (input.cursor) query = query.startAfter(input.cursor);
    const snapshot = await query.get();
    const items = snapshot.docs.slice(0, input.limit).map((document) => {
      const data = document.data();
      return { binding_id: document.id, plugin_principal_id: String(data.pluginPrincipalId ?? ""), status: data.status === "revoked" ? "revoked" as const : "active" as const, created_at: toIso(data.createdAt) ?? "", last_seen_at: toIso(data.lastSeenAt), revoked_at: toIso(data.revokedAt) };
    });
    return { items, next_cursor: snapshot.docs.length > input.limit && items.length ? items[items.length - 1].binding_id : null };
  }

  public async listErrorAggregates(filter: PortalDateFilter, limit: number, cursor?: string, minimumDistinctUsers = 0): Promise<PortalPage<ErrorSummaryRow>> {
    if (filter.pluginVersion) {
      if (!validPluginVersion(filter.pluginVersion)) throw new Error("Invalid plugin version");
    }
    const documents = await this.scanActiveAggregates(
      COLLECTIONS.errors,
      filter,
      "Error aggregate query",
      filter.pluginVersion ? (query) => query.where("plugin_version", "==", filter.pluginVersion) : undefined,
    );
    const grouped = new Map<string, ErrorSummaryRow & { versionSet: Set<string>; summaryCounts: Map<string, number>; principalSet: Set<string> }>();
    for (const document of documents) {
      if ((!filter.toolKey || document.get("tool_key") === filter.toolKey) && (!filter.actionKey || document.get("action_key") === filter.actionKey) && (!filter.fingerprint || document.get("fingerprint") === filter.fingerprint) && (!filter.pluginVersion || document.get("plugin_version") === filter.pluginVersion)) {
      const data = document.data();
        const key = `${String(data.tool_key ?? "")}\u0000${String(data.action_key ?? "")}\u0000${String(data.fingerprint ?? "")}`;
        const row = grouped.get(key) ?? {
          tool_key: String(data.tool_key ?? ""),
          action_key: String(data.action_key ?? ""),
          error_category: String(data.error_category ?? ""),
          fingerprint: String(data.fingerprint ?? ""),
          count: 0,
          first_seen_at: String(data.first_seen_at ?? ""),
          recent_seen_at: String(data.recent_seen_at ?? ""),
          first_received_at: String(data.first_received_at ?? data.first_seen_at ?? ""),
          recent_received_at: String(data.recent_received_at ?? data.recent_seen_at ?? ""),
          time_corrected_count: 0,
          affected_versions: [],
          summaries: [],
          status: data.status === "resolved" ? "resolved" as const : "open" as const,
          distinct_users: 0,
          versionSet: new Set<string>(),
          summaryCounts: new Map<string, number>(),
          principalSet: new Set<string>(),
        };
        row.count += Number(data.count ?? 0);
        const firstSeen = String(data.first_seen_at ?? "");
        const recentSeen = String(data.recent_seen_at ?? "");
        if (firstSeen && (!row.first_seen_at || firstSeen < row.first_seen_at)) row.first_seen_at = firstSeen;
        if (recentSeen && (!row.recent_seen_at || recentSeen > row.recent_seen_at)) row.recent_seen_at = recentSeen;
        const firstReceived = String(data.first_received_at ?? data.first_seen_at ?? "");
        const recentReceived = String(data.recent_received_at ?? data.recent_seen_at ?? "");
        if (firstReceived && (!row.first_received_at || firstReceived < row.first_received_at)) row.first_received_at = firstReceived;
        if (recentReceived && (!row.recent_received_at || recentReceived > row.recent_received_at)) row.recent_received_at = recentReceived;
        row.time_corrected_count += Number(data.time_corrected_count ?? 0);
        if (data.status !== "resolved") row.status = "open";
        const version = String(data.plugin_version ?? "");
        if (version) row.versionSet.add(version);
        for (const item of Array.isArray(data.summaries) ? data.summaries : []) {
          const summary = String(item.summary ?? "");
          if (summary) row.summaryCounts.set(summary, (row.summaryCounts.get(summary) ?? 0) + Number(item.count ?? 0));
        }
        for (const principalId of Array.isArray(data.principal_ids) ? data.principal_ids : []) {
          if (typeof principalId === "string" && principalId) row.principalSet.add(principalId);
        }
        grouped.set(key, row);
      }
    }
    const rows = [...grouped.values()].map(({ versionSet, summaryCounts, principalSet, ...row }) => ({
      ...row,
      distinct_users: principalSet.size,
      affected_versions: [...versionSet].sort(),
      summaries: [...summaryCounts.entries()].map(([summary, count]) => ({ summary, count })).sort((left, right) => right.count - left.count || left.summary.localeCompare(right.summary)).slice(0, 3),
    })).filter((row) => row.distinct_users >= minimumDistinctUsers);
    return pageRows(rows, limit, cursor, (row) => `${row.tool_key}\u0000${row.action_key}\u0000${row.fingerprint}`);
  }

  public async listErrorDetails(filter: PortalDateFilter, limit: number, cursor?: string): Promise<PortalPage<ErrorDetailRow>> {
    if (!filter.fingerprint || !/^[a-f0-9]{64}$/.test(filter.fingerprint)) throw new Error("Invalid error fingerprint");
    if (!validPortalKey(filter.toolKey) || !validPortalKey(filter.actionKey)) throw new Error("Invalid error tool or action key");
    if (filter.pluginVersion && !validPluginVersion(filter.pluginVersion)) throw new Error("Invalid plugin version");
    const bounds = companyDateBounds(filter);
    let query = this.firestore.collection(COLLECTIONS.usageEvents)
      .where("error.fingerprint", "==", filter.fingerprint)
      .where("tool_key", "==", filter.toolKey)
      .where("action_key", "==", filter.actionKey);
    if (filter.pluginVersion) query = query.where("plugin_version", "==", filter.pluginVersion);
    query = query
      .where("time_correction.corrected_observed_at", ">=", bounds.start)
      .where("time_correction.corrected_observed_at", "<", bounds.endExclusive)
      .orderBy("time_correction.corrected_observed_at", "asc")
      .orderBy(FieldPath.documentId(), "asc");
    const documents = await scanQuery(query, AGGREGATE_SCAN_LIMIT, "Error detail query");
    const rawRows = documents.map((document) => {
      const data = document.data();
      const observedAt = String(data.time_correction?.corrected_observed_at ?? data.client_observed_at ?? "");
      return {
        event_id: document.id,
        plugin_principal_id: String(data.plugin_principal_id ?? ""),
        display_name: String(data.plugin_principal_id ?? ""),
        email: null,
        binding_id: String(data.binding_id ?? ""),
        tool_key: String(data.tool_key ?? ""),
        action_key: String(data.action_key ?? ""),
        event_type: String(data.event_type ?? ""),
        plugin_version: String(data.plugin_version ?? ""),
        observed_at: observedAt,
        received_at: String(data.server_received_at ?? ""),
      } satisfies ErrorDetailRow;
    });
    const result = pageRows(rawRows, limit, cursor, (row) => `${row.observed_at}\u0000${row.event_id}`);
    const principalIds = [...new Set(result.items.map((row) => row.plugin_principal_id).filter(Boolean))];
    const references = principalIds.map((id) => this.firestore.collection(COLLECTIONS.principals).doc(id));
    const profiles = references.length ? await this.firestore.getAll(...references) : [];
    const profileById = new Map(profiles.map((snapshot) => [snapshot.id, snapshot.data() ?? {}]));
    return {
      items: result.items.map((row) => {
        const profile = profileById.get(row.plugin_principal_id) ?? {};
        return { ...row, display_name: String(profile.displayName ?? row.plugin_principal_id), email: typeof profile.email === "string" ? profile.email : null };
      }),
      next_cursor: result.next_cursor,
    };
  }
}
