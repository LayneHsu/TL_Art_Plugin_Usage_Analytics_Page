import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("production plugin auth adapters pin direct dependencies and use Firestore transactions", () => {
  const packageJson = JSON.parse(read("functions/package.json"));
  assert.match(packageJson.dependencies["firebase-functions"], /^\d+\.\d+\.\d+$/);
  assert.match(packageJson.dependencies["firebase-admin"], /^\d+\.\d+\.\d+$/);
  assert.match(packageJson.dependencies["google-auth-library"], /^\d+\.\d+\.\d+$/);
  assert.match(
    packageJson.scripts.build,
    /clean/,
    "Functions build must remove stale compiled auth modules before TypeScript output",
  );

  const store = read("functions/src/plugin-auth/firestore-store.ts");
  assert.match(store, /runTransaction/);
  for (const collection of [
    "pluginPrincipals",
    "pluginDeviceBindings",
    "pluginDevicePairings",
    "pluginAuthAudit",
    "pluginOpsReviews",
  ]) {
    assert.match(store, new RegExp(collection));
  }
  assert.doesNotMatch(store, /portalUsers|portalAccessPolicies|portalAuthAudit/);
});

test("plugin endpoints use plugin-prefixed secrets, bounded requests, HTTPS, and private IAM ops", () => {
  const endpoints = read("functions/src/plugin-auth/endpoints.ts");
  const index = read("functions/src/index.ts");
  assert.match(endpoints, /defineSecret\("PLUGIN_/);
  assert.match(endpoints, /pluginCreatePairing/);
  assert.match(endpoints, /pluginCompletePairing/);
  assert.match(endpoints, /pluginAcknowledgePairingDelivery/);
  assert.match(endpoints, /pluginRenewLease/);
  assert.match(endpoints, /pluginOpsRequest/);
  assert.match(endpoints, /pluginOpsApprove/);
  assert.match(endpoints, /pluginOpsExecute/);
  assert.doesNotMatch(endpoints, /x-goog-authenticated-user-email|approved_by/);
  assert.match(endpoints, /invoker:\s*"private"/);
  assert.match(endpoints, /requireHttps/);
  assert.match(endpoints, /readBoundedJsonBody/);
  assert.doesNotMatch(
    endpoints,
    /PORTAL_|portalUsers|portalAccessPolicies|["'](?:visitor|admin)["']/,
  );
  assert.match(endpoints, /publicEndpointFields/);
  assert.match(endpoints, /assertExactFields\(body, publicEndpointFields\[endpoint\]/);
  assert.doesNotMatch(endpoints, /portal_uid/);
  assert.doesNotMatch(index, /ops-service/);
  assert.doesNotMatch(endpoints, /ops-service/);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "functions/src/plugin-auth/ops-service.ts")),
    false,
    "legacy self-supplied plugin ops service must not ship",
  );
});

test("operations and client auth lifecycle are documented as separate domains", () => {
  const operations = read("docs/plugin-auth-operations.md");
  const lifecycle = read("contracts/plugin-auth-contract.md");
  assert.match(operations, /IAM/i);
  assert.match(operations, /two-person|two person|双人/i);
  assert.match(operations, /recovery|恢复/i);
  assert.match(operations, /pluginAuthAudit/);
  assert.match(operations, /portal admin.*cannot|门户管理员.*不能/is);
  assert.match(lifecycle, /3600/);
  assert.match(lifecycle, /process memory|进程内存/i);
  assert.match(lifecycle, /binding_id.*queue|队列.*binding_id/is);
  assert.match(lifecycle, /content.*not stored|不存储.*事件内容/is);
  assert.match(lifecycle, /prepare.*confirm.*cancel.*expiry/is);
  assert.match(lifecycle, /display_name.*avatar_url.*profile_updated_at/is);
  assert.match(lifecycle, /Windows user names.*never|Windows.*用户名.*不/is);
  assert.match(lifecycle, /issuer.*subject.*Firebase UID.*credential/is);
});

test("plugin auth profile snapshots are explicitly allowlisted in service code", () => {
  const pairing = read("functions/src/plugin-auth/pairing-service.ts");
  const lease = read("functions/src/plugin-auth/lease-service.ts");
  const principal = read("functions/src/plugin-auth/principal-service.ts");
  for (const source of [pairing, lease]) {
    assert.match(source, /pluginPrincipalProfile/);
  }
  assert.match(principal, /PluginPrincipalProfileSnapshot/);
  assert.match(principal, /parsed\.protocol === "https:"/);
  assert.match(principal, /toISOString\(\)/);
});
