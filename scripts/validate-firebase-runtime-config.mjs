import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../config/firebase-runtime-parameters.json", import.meta.url)), "utf8"));

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (/replace-with|placeholder|example-value/i.test(value)) throw new Error(`${name} must not be a placeholder`);
  return value;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function stringArray(environment, name, label) {
  const parsed = parseJson(required(environment, name), label);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${label} must be a non-empty JSON string array`);
  }
  return parsed.map((value) => value.trim());
}

function httpsUrl(value, label, originOnly = false) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (originOnly && parsed.origin !== value.replace(/\/$/, ""))) {
    throw new Error(`${label} must be a valid HTTPS ${originOnly ? "origin" : "URL"}`);
  }
  return originOnly ? parsed.origin : parsed.toString();
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function keyMap(environment, name, keysField = "verificationKeys", keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/) {
  const parsed = parseJson(required(environment, name), name);
  const keys = parsed?.[keysField];
  if (typeof parsed?.currentKeyId !== "string" || !keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error(`${name} configuration is invalid`);
  }
  const entries = Object.entries(keys);
  if (typeof keys[parsed.currentKeyId] !== "string" || entries.length === 0 || entries.some(([keyId, value]) => !keyIdPattern.test(keyId) || typeof value !== "string" || value.length < 32)) {
    throw new Error(`${name} configuration is invalid`);
  }
}

function portalPolicyKeyMap(environment) {
  const name = "PORTAL_POLICY_HMAC_KEYS_JSON";
  const parsed = parseJson(required(environment, name), name);
  const keys = parsed?.keys;
  const previousKeyIds = parsed?.previousKeyIds;
  const keyIdPattern = new RegExp(manifest.constraints.portal_policy_hmac_key_id.pattern);
  if (typeof parsed?.currentKeyId !== "string" || !Array.isArray(previousKeyIds) || !keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error(`${name} configuration is invalid`);
  }
  const orderedKeyIds = [parsed.currentKeyId, ...previousKeyIds];
  const entries = Object.entries(keys);
  if (previousKeyIds.some((keyId) => typeof keyId !== "string") || new Set(orderedKeyIds).size !== orderedKeyIds.length || orderedKeyIds.length !== entries.length || orderedKeyIds.some((keyId) => typeof keyId !== "string" || !(keyId in keys)) || entries.some(([keyId, value]) => !keyIdPattern.test(keyId) || typeof value !== "string" || value.length < 32)) {
    throw new Error(`${name} configuration is invalid`);
  }
}

function objectConfig(environment, name, label) {
  const parsed = parseJson(required(environment, name), label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} configuration is invalid`);
  return parsed;
}

export function validateFirebaseRuntimeConfig(environment = process.env) {
  for (const item of [...manifest.string_parameters, ...manifest.secret_parameters, ...manifest.validation_parameters]) required(environment, item.name);

  const projectId = required(environment, manifest.project.deploy_target);
  const expectedProjectId = required(environment, manifest.project.expected_target);
  const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
  if (!projectPattern.test(projectId) || !projectPattern.test(expectedProjectId)) throw new Error("Firebase project ID is invalid");
  if (projectId !== expectedProjectId) throw new Error("Firebase deploy project must match the protected analytics project");
  if (manifest.project.forbidden_markers.some((marker) => projectId.toLowerCase().includes(marker.toLowerCase()))) {
    throw new Error("PCG Firebase projects are forbidden for usage analytics deployment");
  }

  const domains = stringArray(environment, "PORTAL_COMPANY_DOMAINS_JSON", "Portal company domains").map((domain) => domain.toLowerCase());
  const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (domains.some((domain) => !domainPattern.test(domain))) throw new Error("Portal company domains must contain valid DNS domain names");
  const pagesOrigin = httpsUrl(required(environment, "PORTAL_PAGES_ORIGIN"), "Pages origin", true);
  const portalOrigins = stringArray(environment, "PORTAL_ALLOWED_WEB_ORIGINS_JSON", "Portal allowed web origins").map((origin) => httpsUrl(origin, "Portal allowed web origins", true));
  if (!portalOrigins.includes(pagesOrigin)) throw new Error("Pages origin must be present in Portal allowed web origins");

  const pluginDomain = required(environment, "PLUGIN_COMPANY_DOMAIN").toLowerCase().replace(/^@/, "");
  if (!domains.includes(pluginDomain)) throw new Error("Plugin company domain must be one of the Portal company domains");
  if (!/\.apps\.googleusercontent\.com$/.test(required(environment, "PLUGIN_OAUTH_CLIENT_ID"))) throw new Error("PLUGIN_OAUTH_CLIENT_ID is invalid");
  stringArray(environment, "PLUGIN_ALLOWED_CALLBACK_URIS_JSON", "Plugin callback URIs").forEach((uri) => httpsUrl(uri, "Plugin callback URI"));
  stringArray(environment, "PLUGIN_ALLOWED_WEB_ORIGINS_JSON", "Plugin allowed web origins").forEach((origin) => httpsUrl(origin, "Plugin allowed web origin", true));
  httpsUrl(required(environment, "PLUGIN_OPS_AUDIENCE"), "Plugin ops audience");
  if (stringArray(environment, "PLUGIN_OPS_ALLOWED_SERVICE_ACCOUNTS_JSON", "Plugin ops service accounts").some((email) => !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(email))) {
    throw new Error("Plugin ops service accounts must be service-account emails");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(required(environment, "PLUGIN_PRINCIPAL_KEY_ID"))) throw new Error("PLUGIN_PRINCIPAL_KEY_ID is invalid");
  if (!new Set(["disabled", "explicit"]).has(required(environment, "PLUGIN_PRINCIPAL_PEPPER_MIGRATION_MODE"))) throw new Error("PLUGIN_PRINCIPAL_PEPPER_MIGRATION_MODE is invalid");

  required(environment, "USAGE_RETENTION_SCHEDULE");
  required(environment, "USAGE_MONITORING_SCHEDULE");
  for (const name of ["USAGE_RETENTION_TIME_ZONE", "USAGE_MONITORING_TIME_ZONE"]) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: required(environment, name) }); } catch { throw new Error(`${name} is invalid`); }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(required(environment, "USAGE_RETENTION_RUN_ID_PREFIX"))) throw new Error("USAGE_RETENTION_RUN_ID_PREFIX is invalid");
  if (!new Set(["true", "false"]).has(required(environment, "USAGE_RETENTION_DRY_RUN").toLowerCase())) throw new Error("USAGE_RETENTION_DRY_RUN is invalid");
  positiveInteger(required(environment, "USAGE_RETENTION_MAX_PAGES"), "USAGE_RETENTION_MAX_PAGES", 1000);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(required(environment, "USAGE_RETENTION_OWNER_ID"))) throw new Error("USAGE_RETENTION_OWNER_ID is invalid");
  positiveInteger(required(environment, "USAGE_RETENTION_LEASE_MS"), "USAGE_RETENTION_LEASE_MS", 900000);
  const retention = objectConfig(environment, "USAGE_RETENTION_POLICY_JSON", "Retention policy");
  for (const field of ["rawEventRetentionMs", "deadLetterRetentionMs", "authAuditRetentionMs", "aggregateRetentionMs", "quotaRetentionMs", "operationRetentionMs", "replayMetadataRetentionMs", "retentionRunRetentionMs", "monitoringRetentionMs", "rebuildWindowMs", "lateArrivalAllowanceMs", "batchSize"]) {
    positiveInteger(retention[field], `Retention policy ${field}`);
  }
  const monitoring = objectConfig(environment, "USAGE_MONITORING_CONFIG_JSON", "Monitoring");
  if (!monitoring.thresholds || typeof monitoring.thresholds !== "object" || Array.isArray(monitoring.thresholds) || typeof monitoring.thresholds.owner !== "string") throw new Error("Monitoring thresholds are required");
  if (monitoring.routes !== undefined && (!Array.isArray(monitoring.routes) || monitoring.routes.some((route) => typeof route !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(route)))) throw new Error("Monitoring routes are invalid");

  if (required(environment, "PLUGIN_OAUTH_CLIENT_SECRET").length < 16) throw new Error("PLUGIN_OAUTH_CLIENT_SECRET is invalid");
  for (const name of ["PLUGIN_CREDENTIAL_PEPPER", "PLUGIN_PRINCIPAL_KEY_PEPPER"]) if (required(environment, name).length < 32) throw new Error(`${name} is invalid`);
  keyMap(environment, "PLUGIN_CREDENTIAL_DELIVERY_KEYS_JSON");
  keyMap(environment, "PLUGIN_LEASE_SIGNING_KEYS_JSON");
  portalPolicyKeyMap(environment);
  const bootstrap = objectConfig(environment, "PORTAL_BOOTSTRAP_ADMIN_JSON", "Portal bootstrap administrator");
  const bootstrapEmail = typeof bootstrap.email === "string" ? bootstrap.email.trim().toLowerCase() : "";
  if (typeof bootstrap.bootstrapId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(bootstrap.bootstrapId) || !/^[^@\s]+@[^@\s]+$/.test(bootstrapEmail) || !domains.includes(bootstrapEmail.split("@")[1] ?? "")) {
    throw new Error("Portal bootstrap administrator configuration is invalid");
  }
  return { projectId };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    validateFirebaseRuntimeConfig();
    console.log("Firebase runtime configuration is valid.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
