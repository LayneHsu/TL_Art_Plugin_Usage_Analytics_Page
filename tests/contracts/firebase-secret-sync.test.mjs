import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(repositoryRoot, "scripts", "sync-firebase-secrets.mjs");
const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "config", "firebase-runtime-parameters.json"), "utf8"));

function validEnvironment() {
  return {
    PORTAL_FIREBASE_PROJECT_ID: "tl-art-usage-prod",
    TL_USAGE_ANALYTICS_FIREBASE_PROJECT_ID: "tl-art-usage-prod",
    PORTAL_COMPANY_DOMAINS_JSON: '["xindong.com"]',
    PORTAL_ALLOWED_WEB_ORIGINS_JSON: '["https://studio.example.github.io"]',
    PORTAL_PAGES_ORIGIN: "https://studio.example.github.io",
    PLUGIN_OAUTH_CLIENT_ID: "123456.apps.googleusercontent.com",
    PLUGIN_COMPANY_DOMAIN: "xindong.com",
    PLUGIN_ALLOWED_CALLBACK_URIS_JSON: '["https://studio.example.github.io/plugin/pair/callback"]',
    PLUGIN_ALLOWED_WEB_ORIGINS_JSON: '["https://studio.example.github.io"]',
    PLUGIN_OPS_AUDIENCE: "https://usage-analytics.example/ops",
    PLUGIN_OPS_ALLOWED_SERVICE_ACCOUNTS_JSON: '["usage-ops@tl-art-usage-prod.iam.gserviceaccount.com"]',
    PLUGIN_PRINCIPAL_KEY_ID: "primary-v1",
    PLUGIN_PRINCIPAL_PEPPER_MIGRATION_MODE: "disabled",
    USAGE_RETENTION_SCHEDULE: "0 2 * * *",
    USAGE_RETENTION_TIME_ZONE: "Asia/Shanghai",
    USAGE_RETENTION_POLICY_JSON: JSON.stringify({ rawEventRetentionMs: 86400000, deadLetterRetentionMs: 86400000, authAuditRetentionMs: 86400000, aggregateRetentionMs: 86400000, quotaRetentionMs: 86400000, operationRetentionMs: 86400000, replayMetadataRetentionMs: 86400000, retentionRunRetentionMs: 86400000, monitoringRetentionMs: 86400000, rebuildWindowMs: 3600000, lateArrivalAllowanceMs: 3600000, batchSize: 100 }),
    USAGE_RETENTION_RUN_ID_PREFIX: "scheduled-retention",
    USAGE_RETENTION_DRY_RUN: "true",
    USAGE_RETENTION_MAX_PAGES: "20",
    USAGE_RETENTION_OWNER_ID: "scheduled-retention-worker",
    USAGE_RETENTION_LEASE_MS: "300000",
    USAGE_MONITORING_SCHEDULE: "*/15 * * * *",
    USAGE_MONITORING_TIME_ZONE: "Asia/Shanghai",
    USAGE_MONITORING_CONFIG_JSON: JSON.stringify({ thresholds: { owner: "art-tools-oncall" }, routes: ["oncall"] }),
    PLUGIN_OAUTH_CLIENT_SECRET: "oauth-client-secret-material",
    PLUGIN_CREDENTIAL_PEPPER: "credential-pepper-material-at-least-32-bytes",
    PLUGIN_CREDENTIAL_DELIVERY_KEYS_JSON: JSON.stringify({ currentKeyId: "delivery-v1", verificationKeys: { "delivery-v1": "delivery-key-material-at-least-32-bytes" } }),
    PLUGIN_PRINCIPAL_KEY_PEPPER: "principal-key-pepper-material-at-least-32-bytes",
    PLUGIN_LEASE_SIGNING_KEYS_JSON: JSON.stringify({ currentKeyId: "lease-v1", verificationKeys: { "lease-v1": "lease-signing-key-material-at-least-32-bytes" } }),
    PORTAL_POLICY_HMAC_KEYS_JSON: JSON.stringify({ currentKeyId: "policy-v1", previousKeyIds: [], keys: { "policy-v1": "portal-policy-hmac-material-at-least-32-bytes" } }),
    PORTAL_BOOTSTRAP_ADMIN_JSON: JSON.stringify({ bootstrapId: "initial-admin-v1", email: "first.admin@xindong.com" }),
  };
}

test("secret synchronization validates the complete runtime configuration before spawning", async () => {
  assert.match(fs.readFileSync(scriptPath, "utf8"), /export\s+(?:async\s+)?function\s+syncFirebaseSecrets/);
  const { syncFirebaseSecrets } = await import(`${pathToFileURL(scriptPath).href}?test=${Date.now()}`);
  for (const change of [
    { PORTAL_FIREBASE_PROJECT_ID: "another-analytics-project" },
    { PORTAL_FIREBASE_PROJECT_ID: "torchlight-pcg-prod", TL_USAGE_ANALYTICS_FIREBASE_PROJECT_ID: "torchlight-pcg-prod" },
    { PLUGIN_OAUTH_CLIENT_ID: "" },
    { USAGE_RETENTION_POLICY_JSON: "not-json" },
  ]) {
    let calls = 0;
    assert.throws(() => syncFirebaseSecrets({ environment: { ...validEnvironment(), ...change }, execute: () => { calls += 1; return { status: 0 }; } }));
    assert.equal(calls, 0);
  }
});

test("secret synchronization sends values only over stdin after validation", async () => {
  assert.match(fs.readFileSync(scriptPath, "utf8"), /export\s+(?:async\s+)?function\s+syncFirebaseSecrets/);
  const { syncFirebaseSecrets } = await import(`${pathToFileURL(scriptPath).href}?success=${Date.now()}`);
  const calls = [];
  const environment = validEnvironment();
  syncFirebaseSecrets({ environment, execute: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; }, log: () => undefined });
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.equal(call.command, "npm");
    assert.equal(call.args.includes(call.options.input), false);
    assert.equal(manifest.secret_parameters.some((item) => call.args.includes(environment[item.name])), false);
    assert.equal(call.options.stdio[0], "pipe");
  }
});
