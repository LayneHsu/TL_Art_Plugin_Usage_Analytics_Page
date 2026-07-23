import type { PortalMember, PortalRole } from "../../../web/src/portal/api";

type StubUser = {
  uid: string;
  email: string;
  displayName: string;
  photoURL: null;
};

const query = new URLSearchParams(window.location.search);
const state = {
  role: query.get("role") === "viewer" ? "viewer" as PortalRole : "admin" as PortalRole,
  enabled: query.get("enabled") !== "false",
  signedIn: query.get("signedIn") !== "false",
};
const user: StubUser = { uid: "portal-e2e-user", email: "admin@xindong.com", displayName: "测试管理员", photoURL: null };
const authListeners = new Set<(value: StubUser | null) => void>();
const memberListeners = new Set<(value: PortalMember | null) => void>();

function member(): PortalMember {
  return {
    email: user.email,
    role: state.role,
    enabled: state.enabled,
    created_at: "2026-07-01T00:00:00.000Z",
    created_by: user.uid,
    updated_at: "2026-07-23T08:00:00.000Z",
    updated_by: user.uid,
  };
}

function emitAuth(): void {
  for (const listener of authListeners) listener(state.signedIn ? user : null);
}

function emitMember(): void {
  for (const listener of memberListeners) listener(state.signedIn ? member() : null);
}

(window as typeof window & { __portalE2E: typeof state & { setMember: (role: PortalRole, enabled: boolean) => void } }).__portalE2E = Object.assign(state, {
  setMember(role: PortalRole, enabled: boolean) {
    state.role = role;
    state.enabled = enabled;
    emitMember();
  },
});

export async function signInPortal(): Promise<void> {
  state.signedIn = true;
  state.enabled = true;
  emitAuth();
}

export async function signOutPortal(): Promise<void> {
  state.signedIn = false;
  emitAuth();
}

export function watchPortalUser(callback: (value: StubUser | null) => void): () => void {
  authListeners.add(callback);
  queueMicrotask(() => callback(state.signedIn ? user : null));
  return () => authListeners.delete(callback);
}

export function watchPortalMember(_user: StubUser, callback: (value: PortalMember | null) => void): () => void {
  memberListeners.add(callback);
  queueMicrotask(() => callback(member()));
  return () => memberListeners.delete(callback);
}

export function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isPortalEmail(value: string): boolean {
  const email = normalizedEmail(value);
  return email.endsWith("@xindong.com") || email === "snkhtm@gmail.com";
}

export const portalFirestore = {};
