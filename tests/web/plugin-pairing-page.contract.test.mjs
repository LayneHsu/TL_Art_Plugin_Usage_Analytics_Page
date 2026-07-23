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

test("plugin pairing route uses only plugin-prefixed ephemeral session state", () => {
  const source = read("web/src/plugin-pairing/session.ts");
  assert.match(source, /sessionStorage/);
  assert.match(source, /plugin_pairing_/);
  assert.match(source, /clearPluginPairingSession/);
  assert.doesNotMatch(source, /localStorage|firebase.*auth|portal.*session/i);
});

test("plugin pairing page explicitly claims the device and clears state on every terminal path", () => {
  const page = read("web/src/plugin-pairing/PluginPairingPage.vue");
  assert.match(page, /认领此设备/);
  assert.match(page, /clearPluginPairingSession/);
  assert.match(page, /complete|cancel|error/i);
  assert.doesNotMatch(page, /visitor|admin|portalUsers|portalAccessPolicies/);
});

test("plugin pairing callback is rooted at the GitHub Pages base path", () => {
  const page = read("web/src/plugin-pairing/PluginPairingPage.vue");
  assert.match(page, /import\.meta\.env\.BASE_URL/);
  assert.doesNotMatch(page, /document\.baseURI/);
});

test("OAuth terminal errors invalidate the server pairing before local cleanup", () => {
  const page = read("web/src/plugin-pairing/PluginPairingPage.vue");
  assert.match(
    page,
    /oauthError[\s\S]*cancelPluginPairing[\s\S]*clearPluginPairingSession/,
  );
});

test("pairing secret is fragment-only and scrubbed before OAuth or network work", () => {
  const page = read("web/src/plugin-pairing/PluginPairingPage.vue");
  assert.match(page, /window\.location\.hash/);
  assert.match(page, /history\.replaceState/);
  assert.doesNotMatch(page, /query\.get\(["']pairing_secret["']\)/);
  assert.ok(
    page.indexOf("history.replaceState") <
      page.indexOf("const result = await beginPluginPairing"),
    "fragment must be scrubbed before pairing network work",
  );
});

test("OAuth callback scrubs the entire query string after capturing callback values", () => {
  const page = read("web/src/plugin-pairing/PluginPairingPage.vue");
  assert.match(
    page,
    /const authorizationCode = query\.get\("code"\)[\s\S]*const returnedState = query\.get\("state"\)[\s\S]*const oauthError = query\.get\("error"\)/,
  );
  assert.match(page, /isCallback[\s\S]*history\.replaceState/);
  assert.match(
    page,
    /if \(isCallback\)[\s\S]*history\.replaceState\([\s\S]*window\.location\.pathname/,
  );
  const callbackBranch = page.match(/if \(isCallback\) \{([\s\S]*?)\} else/);
  assert.ok(callbackBranch, "callback branch must be explicit");
  assert.doesNotMatch(callbackBranch[1], /scrubbedSearch|\?/);
  assert.match(callbackBranch[1], /history\.replaceState/);
  assert.match(callbackBranch[1], /window\.location\.pathname/);
});

test("pagehide cancels pairing except during intentional OAuth navigation", () => {
  const page = read("web/src/plugin-pairing/PluginPairingPage.vue");
  const api = read("web/src/plugin-pairing/api.ts");
  assert.match(page, /pagehide/);
  assert.match(page, /intentionalOAuthNavigation/);
  assert.match(page, /cancelPluginPairingKeepalive/);
  assert.match(api, /keepalive:\s*true|sendBeacon/);
});

test("the pairing document suppresses referrers and favicon network fallback", () => {
  const html = read("web/index.html");
  assert.match(html, /<meta\s+name="referrer"\s+content="no-referrer"/);
  assert.match(html, /<link\s+rel="icon"\s+href="data:,"/);
});
