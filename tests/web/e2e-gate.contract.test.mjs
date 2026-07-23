import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, "utf8");

test("repository keeps Playwright and axe as persistent test-only dependencies", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(typeof packageJson.devDependencies["@playwright/test"], "string");
  assert.equal(typeof packageJson.devDependencies["@axe-core/playwright"], "string");
  assert.match(packageJson.scripts["test:e2e"], /playwright test/);
  assert.ok(existsSync(`${root}/playwright.config.ts`));
  assert.ok(existsSync(`${root}/tests/e2e/portal.spec.ts`));
});

test("browser gate covers authorization, revocation, races, responsiveness and accessibility", () => {
  const e2e = read("tests/e2e/portal.spec.ts");
  const workflow = read(".github/workflows/verify.yml");
  for (const phrase of [
    "visitor cannot open admin routes",
    "admin can open protected routes",
    "role and status changes revoke access",
    "late preview responses are ignored",
    "mobile keeps the account role visible",
    "tables scroll horizontally",
    "keyboard focus is visible",
  ]) assert.match(e2e, new RegExp(phrase));
  assert.match(e2e, /AxeBuilder/);
  assert.match(e2e, /pageerror/);
  assert.match(e2e, /console/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /npm run test:e2e/);
});

test("emulator mode connects the browser to Firestore without touching plugin pairing", () => {
  const firebase = read("web/src/portal/firebase.ts");
  const pairing = read("web/src/plugin-pairing/PluginPairingPage.vue");
  assert.match(firebase, /connectFirestoreEmulator/);
  assert.match(firebase, /PORTAL_FIRESTORE_EMULATOR_HOST/);
  assert.doesNotMatch(pairing, /firebase\/firestore|watchPortalAccess/);
});

test("web build splits Vue, Firebase Auth and Firestore into bounded chunks", () => {
  const vite = read("web/vite.config.ts");
  const pagesTest = read("tests/pages-artifacts.contract.test.mjs");
  assert.match(vite, /manualChunks/);
  assert.match(vite, /firebase-auth/);
  assert.match(vite, /firebase-firestore/);
  assert.match(vite, /vue-vendor/);
  assert.match(pagesTest, /500_000/);
});
