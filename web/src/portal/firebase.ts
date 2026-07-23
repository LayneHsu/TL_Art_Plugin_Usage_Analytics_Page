import { getApp, getApps, initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  connectFirestoreEmulator,
  doc,
  getFirestore,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import type { PortalMember } from "./api";

const app = getApps().length ? getApp() : initializeApp({
  apiKey: import.meta.env.PORTAL_FIREBASE_API_KEY,
  authDomain: import.meta.env.PORTAL_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PORTAL_FIREBASE_PROJECT_ID,
  appId: import.meta.env.PORTAL_FIREBASE_APP_ID,
  storageBucket: import.meta.env.PORTAL_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.PORTAL_FIREBASE_MESSAGING_SENDER_ID,
});

export const portalAuth = getAuth(app);
export const portalFirestore = getFirestore(app);

if (import.meta.env.PORTAL_DEPLOY_ENV === "emulator" && import.meta.env.PORTAL_FIREBASE_AUTH_EMULATOR_HOST) {
  connectAuthEmulator(portalAuth, `http://${import.meta.env.PORTAL_FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
}
if (import.meta.env.PORTAL_DEPLOY_ENV === "emulator" && import.meta.env.PORTAL_FIRESTORE_EMULATOR_HOST) {
  const [hostname, port] = import.meta.env.PORTAL_FIRESTORE_EMULATOR_HOST.split(":");
  connectFirestoreEmulator(portalFirestore, hostname, Number(port));
}

export async function signInPortal(): Promise<void> {
  await setPersistence(portalAuth, browserLocalPersistence);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithPopup(portalAuth, provider);
}

export function signOutPortal(): Promise<void> {
  return signOut(portalAuth);
}

export function watchPortalUser(callback: (user: User | null) => void): Unsubscribe {
  return onAuthStateChanged(portalAuth, callback);
}

export function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isPortalEmail(value: string): boolean {
  const email = normalizedEmail(value);
  return email.endsWith("@xindong.com") || email === "snkhtm@gmail.com";
}

export function watchPortalMember(
  user: User,
  callback: (member: PortalMember | null) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const email = normalizedEmail(user.email || "");
  return onSnapshot(doc(portalFirestore, "portalMembers", email), (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }
    const data = snapshot.data();
    if (data.email !== email || !["admin", "viewer"].includes(data.role) || typeof data.enabled !== "boolean") {
      callback(null);
      return;
    }
    callback(data as PortalMember);
  }, onError);
}
