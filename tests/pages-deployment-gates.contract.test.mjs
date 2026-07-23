import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, "utf8");
const validatorUrl = pathToFileURL(`${root}/scripts/validate-production-web-config.mjs`).href;

const validEnvironment = {
  PORTAL_DEPLOY_ENV: "production",
  PORTAL_PUBLIC_BASE_PATH: "/TL_Art_Tool_Usage_Analytics/",
  PORTAL_FIREBASE_API_KEY: "public-web-api-key-1234567890",
  PORTAL_FIREBASE_AUTH_DOMAIN: "tl-analytics.firebaseapp.com",
  PORTAL_FIREBASE_PROJECT_ID: "tl-analytics-prod",
  PORTAL_FIREBASE_APP_ID: "1:123456789:web:abcdef0123456789",
  PORTAL_FIREBASE_STORAGE_BUCKET: "tl-analytics-prod.firebasestorage.app",
  PORTAL_FIREBASE_MESSAGING_SENDER_ID: "123456789",
  PORTAL_FUNCTIONS_BASE_URL: "https://asia-east1-tl-analytics-prod.cloudfunctions.net",
  PORTAL_PAGES_ORIGIN: "https://company.github.io",
  PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON: '["company.github.io","tl-analytics.firebaseapp.com"]',
  PORTAL_ALLOWED_WEB_ORIGINS_JSON: '["https://company.github.io"]',
};

test("production web configuration rejects missing, placeholder and malformed values", async () => {
  const { validateProductionWebConfig } = await import(validatorUrl);
  assert.equal(validateProductionWebConfig(validEnvironment).projectId, "tl-analytics-prod");
  for (const change of [
    { PORTAL_FIREBASE_API_KEY: "" },
    { PORTAL_FIREBASE_PROJECT_ID: "replace-with-production-project-id" },
    { PORTAL_FUNCTIONS_BASE_URL: "http://insecure.example" },
    { PORTAL_FIREBASE_APP_ID: "not-an-app-id" },
  ]) assert.throws(() => validateProductionWebConfig({ ...validEnvironment, ...change }), /production web configuration/i);
});

test("production web configuration binds Pages origin to Auth and Functions allowlists", async () => {
  const { validateProductionWebConfig } = await import(validatorUrl);
  assert.throws(() => validateProductionWebConfig({ ...validEnvironment, PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON: '[]' }), /authorized domains/i);
  assert.throws(() => validateProductionWebConfig({ ...validEnvironment, PORTAL_ALLOWED_WEB_ORIGINS_JSON: '[]' }), /allowed web origins/i);
});

test("authorized-domain live check compares Firebase project configuration", async () => {
  const { validateProductionWebConfig, verifyFirebaseAuthorizedDomains } = await import(validatorUrl);
  const config = validateProductionWebConfig(validEnvironment);
  const fetchImpl = async () => new Response(JSON.stringify({ projectId: config.projectId, authorizedDomains: config.authorizedDomains }), { status: 200 });
  await assert.doesNotReject(() => verifyFirebaseAuthorizedDomains(config, fetchImpl));
  await assert.rejects(() => verifyFirebaseAuthorizedDomains(config, async () => new Response(JSON.stringify({ projectId: config.projectId, authorizedDomains: ["tl-analytics.firebaseapp.com"] }), { status: 200 })), /company.github.io/);
});

test("Pages workflow runs preflight before build and browser smoke after deployment", () => {
  const workflow = read(".github/workflows/deploy-pages.yml");
  const packageJson = JSON.parse(read("package.json"));
  const smoke = read("tests/e2e/pages-deployment.smoke.spec.ts");
  assert.match(packageJson.scripts["validate:pages-production"], /validate-production-web-config/);
  assert.match(packageJson.scripts["test:pages-smoke"], /pages-deployment\.smoke\.spec\.ts/);
  assert.ok(workflow.indexOf("npm run validate:pages-production") < workflow.indexOf("npm run build:web"));
  assert.ok(workflow.indexOf("actions/deploy-pages") < workflow.indexOf("npm run test:pages-smoke"));
  assert.match(workflow, /PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON/);
  assert.match(workflow, /PORTAL_ALLOWED_WEB_ORIGINS_JSON/);
  assert.match(smoke, /history-smoke/);
  assert.match(smoke, /pageerror/);
  assert.match(smoke, /OPTIONS/);
  assert.match(smoke, /access-control-allow-origin/i);
});

test("Firebase deployment installs Chromium before repository verification", () => {
  const workflow = read(".github/workflows/deploy-firebase.yml");
  const installChromium = workflow.indexOf("npx playwright install --with-deps chromium");
  const verifyRepository = workflow.indexOf("npm run verify");
  assert.notEqual(installChromium, -1, "Firebase deployment must install the Playwright Chromium binary");
  assert.ok(installChromium < verifyRepository, "Chromium installation must happen before npm run verify");
});
