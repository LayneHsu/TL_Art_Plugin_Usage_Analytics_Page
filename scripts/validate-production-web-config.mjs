import path from "node:path";
import { pathToFileURL } from "node:url";

const requiredKeys = [
  "PORTAL_DEPLOY_ENV",
  "PORTAL_PUBLIC_BASE_PATH",
  "PORTAL_FIREBASE_API_KEY",
  "PORTAL_FIREBASE_AUTH_DOMAIN",
  "PORTAL_FIREBASE_PROJECT_ID",
  "PORTAL_FIREBASE_APP_ID",
  "PORTAL_FIREBASE_STORAGE_BUCKET",
  "PORTAL_FIREBASE_MESSAGING_SENDER_ID",
  "PORTAL_PAGES_ORIGIN",
  "PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON",
];

function failure(message) {
  throw new Error(`Invalid production web configuration: ${message}`);
}

function required(environment, key) {
  const value = String(environment[key] ?? "").trim();
  if (!value || /replace-with|example|invalid/i.test(value)) {
    failure(`${key} is missing or contains a placeholder`);
  }
  return value;
}

function stringList(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    failure(`${label} must be a JSON string array`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item.trim())) {
    failure(`${label} must be a JSON string array`);
  }
  return [...new Set(parsed.map((item) => item.trim().toLowerCase()))];
}

function httpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    failure(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    failure(`${label} must be a valid HTTPS URL`);
  }
  return parsed;
}

export function validateProductionWebConfig(environment) {
  const values = Object.fromEntries(requiredKeys.map((key) => [key, required(environment, key)]));
  if (values.PORTAL_DEPLOY_ENV !== "production") failure("PORTAL_DEPLOY_ENV must equal production");
  if (!/^\/[A-Za-z0-9._/-]*\/$/.test(values.PORTAL_PUBLIC_BASE_PATH) || values.PORTAL_PUBLIC_BASE_PATH.includes("//")) {
    failure("PORTAL_PUBLIC_BASE_PATH must be an absolute directory path");
  }
  if (values.PORTAL_FIREBASE_API_KEY.length < 20) failure("PORTAL_FIREBASE_API_KEY is malformed");
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(values.PORTAL_FIREBASE_PROJECT_ID)) failure("PORTAL_FIREBASE_PROJECT_ID is malformed");
  if (!/^\d+:\d+:web:[A-Za-z0-9]+$/.test(values.PORTAL_FIREBASE_APP_ID)) failure("PORTAL_FIREBASE_APP_ID is malformed");
  if (!/^\d{6,}$/.test(values.PORTAL_FIREBASE_MESSAGING_SENDER_ID)) failure("PORTAL_FIREBASE_MESSAGING_SENDER_ID is malformed");
  const authDomain = values.PORTAL_FIREBASE_AUTH_DOMAIN.toLowerCase();
  const storageBucket = values.PORTAL_FIREBASE_STORAGE_BUCKET.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(authDomain)) failure("PORTAL_FIREBASE_AUTH_DOMAIN is malformed");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(storageBucket)) failure("PORTAL_FIREBASE_STORAGE_BUCKET is malformed");
  const pagesOrigin = httpsUrl(values.PORTAL_PAGES_ORIGIN, "PORTAL_PAGES_ORIGIN").origin;
  const authorizedDomains = stringList(values.PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON, "authorized domains");
  const pagesHostname = new URL(pagesOrigin).hostname.toLowerCase();
  if (!authorizedDomains.includes(pagesHostname) || !authorizedDomains.includes(authDomain)) {
    failure("authorized domains must include the Pages and Firebase Auth hostnames");
  }
  return {
    apiKey: values.PORTAL_FIREBASE_API_KEY,
    projectId: values.PORTAL_FIREBASE_PROJECT_ID,
    pagesOrigin,
    authorizedDomains,
  };
}

export async function verifyFirebaseAuthorizedDomains(config, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(config.apiKey)}`,
  );
  if (!response.ok) throw new Error(`Firebase authorized-domain check failed with HTTP ${response.status}`);
  const project = await response.json();
  if (project.projectId && project.projectId !== config.projectId) {
    throw new Error(`Firebase project mismatch: expected ${config.projectId}, received ${project.projectId}`);
  }
  const liveDomains = new Set(
    Array.isArray(project.authorizedDomains)
      ? project.authorizedDomains.map((value) => String(value).toLowerCase())
      : [],
  );
  for (const domain of config.authorizedDomains) {
    if (!liveDomains.has(domain)) throw new Error(`Firebase authorized domain is missing: ${domain}`);
  }
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    const config = validateProductionWebConfig(process.env);
    if (process.argv.includes("--verify-authorized-domains")) {
      await verifyFirebaseAuthorizedDomains(config);
    }
    console.log(`Production web configuration verified for ${config.projectId} at ${config.pagesOrigin}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
