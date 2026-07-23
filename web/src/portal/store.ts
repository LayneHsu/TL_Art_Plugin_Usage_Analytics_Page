import type { User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { isPortalEmail, normalizedEmail, portalFirestore } from "./firebase";
import type {
  ErrorLog,
  PluginUserProfile,
  PortalData,
  PortalMember,
  PortalRole,
  UsageDailyShard,
} from "./api";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function timestampText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toDate?: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return "";
}

function profileFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): PluginUserProfile {
  const data = snapshot.data();
  return {
    uid: String(data.uid || snapshot.id),
    email: String(data.email || ""),
    display_name: String(data.display_name || data.email || snapshot.id),
    avatar_url: String(data.avatar_url || ""),
    last_login_at: timestampText(data.last_login_at),
    last_active_at: timestampText(data.last_active_at),
    plugin_version: String(data.plugin_version || ""),
    updated_at: timestampText(data.updated_at),
  };
}

function shardFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): UsageDailyShard {
  const data = snapshot.data();
  return {
    company_date: String(data.company_date || ""),
    uid: String(data.uid || ""),
    tool_key: String(data.tool_key || ""),
    shard: String(data.shard || ""),
    events: Array.isArray(data.events) ? data.events : [],
    first_occurred_at: timestampText(data.first_occurred_at),
    last_occurred_at: timestampText(data.last_occurred_at),
    last_result: data.last_result,
    plugin_version: String(data.plugin_version || ""),
    updated_at: timestampText(data.updated_at),
  } as UsageDailyShard;
}

function errorFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): ErrorLog {
  const data = snapshot.data();
  return {
    event_id: String(data.event_id || snapshot.id),
    uid: String(data.uid || ""),
    company_date: String(data.company_date || ""),
    tool_key: String(data.tool_key || ""),
    action_key: String(data.action_key || ""),
    occurred_at: timestampText(data.occurred_at),
    error_type: String(data.error_type || "unknown"),
    summary: String(data.summary || ""),
    call_site: String(data.call_site || ""),
    fingerprint: String(data.fingerprint || snapshot.id),
    stack: String(data.stack || ""),
    plugin_version: String(data.plugin_version || ""),
  };
}

export async function loadPortalData(dateFrom: string, dateTo: string, signal?: AbortSignal): Promise<PortalData> {
  throwIfAborted(signal);
  const usageQuery = query(
    collection(portalFirestore, "usageDaily"),
    where("company_date", ">=", dateFrom),
    where("company_date", "<=", dateTo),
    orderBy("company_date", "asc"),
  );
  const errorQuery = query(
    collection(portalFirestore, "errorLogs"),
    where("company_date", ">=", dateFrom),
    where("company_date", "<=", dateTo),
    orderBy("company_date", "asc"),
  );
  const [profiles, shards, errors] = await Promise.all([
    getDocs(collection(portalFirestore, "pluginUsers")),
    getDocs(usageQuery),
    getDocs(errorQuery),
  ]);
  throwIfAborted(signal);
  return {
    profiles: profiles.docs.map(profileFromSnapshot),
    shards: shards.docs.map(shardFromSnapshot),
    errors: errors.docs.map(errorFromSnapshot),
  };
}

export async function loadPortalMembers(signal?: AbortSignal): Promise<PortalMember[]> {
  throwIfAborted(signal);
  const result = await getDocs(query(collection(portalFirestore, "portalMembers"), orderBy(documentId(), "asc")));
  throwIfAborted(signal);
  return result.docs.map((snapshot) => {
    const data = snapshot.data();
    return {
      email: String(data.email || snapshot.id),
      role: data.role as PortalRole,
      enabled: data.enabled === true,
      created_at: timestampText(data.created_at),
      created_by: String(data.created_by || ""),
      updated_at: timestampText(data.updated_at),
      updated_by: String(data.updated_by || ""),
    };
  });
}

export async function savePortalMember(currentUser: User, emailValue: string, role: PortalRole): Promise<void> {
  const email = normalizedEmail(emailValue);
  if (!isPortalEmail(email)) throw new Error("请输入已授权的门户邮箱");
  const reference = doc(portalFirestore, "portalMembers", email);
  const existing = await getDoc(reference);
  if (existing.exists()) {
    await updateDoc(reference, {
      email,
      role,
      enabled: true,
      updated_at: serverTimestamp(),
      updated_by: currentUser.uid,
    });
    return;
  }
  await setDoc(reference, {
    email,
    role,
    enabled: true,
    created_at: serverTimestamp(),
    created_by: currentUser.uid,
    updated_at: serverTimestamp(),
    updated_by: currentUser.uid,
  });
}

export async function updatePortalMember(currentUser: User, member: PortalMember, changes: { role?: PortalRole; enabled?: boolean }): Promise<void> {
  if (normalizedEmail(member.email) === normalizedEmail(currentUser.email || "")) {
    throw new Error("不能修改当前管理员自己的角色或状态");
  }
  await updateDoc(doc(portalFirestore, "portalMembers", normalizedEmail(member.email)), {
    role: changes.role ?? member.role,
    enabled: changes.enabled ?? member.enabled,
    updated_at: serverTimestamp(),
    updated_by: currentUser.uid,
  });
}

export async function removePortalMember(currentUser: User, member: PortalMember): Promise<void> {
  if (normalizedEmail(member.email) === normalizedEmail(currentUser.email || "")) {
    throw new Error("不能移除当前管理员");
  }
  await deleteDoc(doc(portalFirestore, "portalMembers", normalizedEmail(member.email)));
}

export interface CleanupPreview {
  usageDocuments: number;
  errorDocuments: number;
  truncated: boolean;
}

async function documentsBefore(collectionName: "usageDaily" | "errorLogs", cutoffDate: string, maximum = 1000) {
  return getDocs(query(
    collection(portalFirestore, collectionName),
    where("company_date", "<", cutoffDate),
    orderBy("company_date", "asc"),
    limit(maximum),
  ));
}

export async function previewCleanup(cutoffDate: string): Promise<CleanupPreview> {
  const [usage, errors] = await Promise.all([
    documentsBefore("usageDaily", cutoffDate),
    documentsBefore("errorLogs", cutoffDate),
  ]);
  return {
    usageDocuments: usage.size,
    errorDocuments: errors.size,
    truncated: usage.size >= 1000 || errors.size >= 1000,
  };
}

export async function deleteRecordsBefore(cutoffDate: string, batchSize = 200): Promise<{ deleted: number; remaining: boolean }> {
  const [usage, errors] = await Promise.all([
    documentsBefore("usageDaily", cutoffDate, batchSize),
    documentsBefore("errorLogs", cutoffDate, batchSize),
  ]);
  const documents = [...usage.docs, ...errors.docs].slice(0, batchSize);
  for (let offset = 0; offset < documents.length; offset += 25) {
    await Promise.all(documents.slice(offset, offset + 25).map((snapshot) => deleteDoc(snapshot.ref)));
  }
  return {
    deleted: documents.length,
    remaining: usage.size >= batchSize || errors.size >= batchSize,
  };
}
