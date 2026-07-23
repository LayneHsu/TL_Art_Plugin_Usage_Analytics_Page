import { getApp, getApps, initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { connectFirestoreEmulator, doc, getFirestore, onSnapshot } from "firebase/firestore";

const app = getApps().length ? getApp() : initializeApp({
  apiKey: import.meta.env.PORTAL_FIREBASE_API_KEY,
  authDomain: import.meta.env.PORTAL_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PORTAL_FIREBASE_PROJECT_ID,
  appId: import.meta.env.PORTAL_FIREBASE_APP_ID,
  storageBucket: import.meta.env.PORTAL_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.PORTAL_FIREBASE_MESSAGING_SENDER_ID,
});

export const portalAuth = getAuth(app);
const portalFirestore = getFirestore(app);
let authEmulatorConnected = false;
let firestoreEmulatorConnected = false;
if (import.meta.env.PORTAL_DEPLOY_ENV === "emulator" && import.meta.env.PORTAL_FIREBASE_AUTH_EMULATOR_HOST && !authEmulatorConnected) {
  connectAuthEmulator(portalAuth, `http://${import.meta.env.PORTAL_FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  authEmulatorConnected = true;
}
if (import.meta.env.PORTAL_DEPLOY_ENV === "emulator" && import.meta.env.PORTAL_FIRESTORE_EMULATOR_HOST && !firestoreEmulatorConnected) {
  const [hostname, port] = import.meta.env.PORTAL_FIRESTORE_EMULATOR_HOST.split(":");
  connectFirestoreEmulator(portalFirestore, hostname, Number(port));
  firestoreEmulatorConnected = true;
}

export async function signInPortal(): Promise<void> {
  await setPersistence(portalAuth, browserLocalPersistence);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: "xindong.com", prompt: "select_account" });
  await signInWithPopup(portalAuth, provider);
}

export async function signOutPortal(): Promise<void> {
  await signOut(portalAuth);
}

export function watchPortalUser(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(portalAuth, callback);
}

export interface PortalAccessDocument {
  role: "visitor" | "admin";
  status: "active" | "disabled" | "removed";
}

export function watchPortalAccess(user: User, callback: (access: PortalAccessDocument | null) => void, onError: (error: Error) => void): () => void {
  return onSnapshot(doc(portalFirestore, "portalUsers", user.uid), (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }
    const data = snapshot.data();
    const role = data.role === "admin" ? "admin" : data.role === "visitor" ? "visitor" : null;
    const status = ["active", "disabled", "removed"].includes(data.status) ? data.status as PortalAccessDocument["status"] : null;
    callback(role && status ? { role, status } : null);
  }, onError);
}
