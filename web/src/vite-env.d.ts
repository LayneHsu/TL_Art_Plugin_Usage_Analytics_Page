/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PLUGIN_AUTH_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface ImportMetaEnv {
  readonly PORTAL_DEPLOY_ENV?: "production" | "test" | "emulator";
  readonly PORTAL_PUBLIC_BASE_PATH?: string;
  readonly PORTAL_FIREBASE_API_KEY?: string;
  readonly PORTAL_FIREBASE_AUTH_DOMAIN?: string;
  readonly PORTAL_FIREBASE_PROJECT_ID?: string;
  readonly PORTAL_FIREBASE_APP_ID?: string;
  readonly PORTAL_FIREBASE_STORAGE_BUCKET?: string;
  readonly PORTAL_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly PORTAL_FIREBASE_AUTH_EMULATOR_HOST?: string;
  readonly PORTAL_FUNCTIONS_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
