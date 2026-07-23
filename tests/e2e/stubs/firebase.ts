type PortalRole = "visitor" | "admin";
type PortalStatus = "active" | "disabled" | "removed";
type StubUser = { uid: string; getIdToken: () => Promise<string> };
type Access = { role: PortalRole; status: PortalStatus };

const query = new URLSearchParams(window.location.search);
const state = {
  role: query.get("role") === "visitor" ? "visitor" as PortalRole : "admin" as PortalRole,
  status: "active" as PortalStatus,
  signedIn: query.get("signedIn") !== "false",
  deferPreview: false,
  previewResolver: undefined as (() => void) | undefined,
  errorDetailRequests: [] as Array<Record<string, unknown>>,
  roleChangeFunction: query.get("roleChangeOn"),
  roleChangeConsumed: false,
};
const user: StubUser = { uid: "portal-e2e-user", getIdToken: async () => "portal-e2e-token" };
const authListeners = new Set<(value: StubUser | null) => void>();
const accessListeners = new Set<(value: Access | null) => void>();

function emitAuth(): void {
  const value = state.signedIn ? user : null;
  for (const listener of authListeners) listener(value);
}

function emitAccess(): void {
  const value = state.signedIn ? { role: state.role, status: state.status } : null;
  for (const listener of accessListeners) listener(value);
}

(window as typeof window & { __portalE2E: typeof state & { setAccess: (role: PortalRole, status: PortalStatus) => void; resolvePreview: () => void } }).__portalE2E = Object.assign(state, {
  setAccess(role: PortalRole, status: PortalStatus) {
    state.role = role;
    state.status = status;
    emitAccess();
  },
  resolvePreview() {
    state.previewResolver?.();
    state.previewResolver = undefined;
  },
});

export async function signInPortal(): Promise<void> {
  state.signedIn = true;
  state.status = "active";
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

export function watchPortalAccess(_user: StubUser, callback: (value: Access | null) => void): () => void {
  accessListeners.add(callback);
  queueMicrotask(() => callback({ role: state.role, status: state.status }));
  return () => accessListeners.delete(callback);
}
