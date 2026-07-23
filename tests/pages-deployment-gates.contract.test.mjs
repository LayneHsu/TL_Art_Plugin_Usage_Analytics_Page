import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const validatorUrl = pathToFileURL(path.join(root, "scripts", "validate-production-web-config.mjs")).href;

const validEnvironment = {
  PORTAL_DEPLOY_ENV: "production",
  PORTAL_PUBLIC_BASE_PATH: "/TL_Art_Plugin_Usage_Analytics_Page/",
  PORTAL_FIREBASE_API_KEY: "valid-public-web-api-key-12345",
  PORTAL_FIREBASE_AUTH_DOMAIN: "tl-analytics.firebaseapp.com",
  PORTAL_FIREBASE_PROJECT_ID: "tl-analytics-prod",
  PORTAL_FIREBASE_APP_ID: "1:123456789:web:abcdef0123456789",
  PORTAL_FIREBASE_STORAGE_BUCKET: "tl-analytics-prod.firebasestorage.app",
  PORTAL_FIREBASE_MESSAGING_SENDER_ID: "123456789",
  PORTAL_PAGES_ORIGIN: "https://company.github.io",
  PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON: '["company.github.io","tl-analytics.firebaseapp.com"]',
};

test("production web configuration accepts only public Firebase and Pages values", async () => {
  const { validateProductionWebConfig } = await import(validatorUrl);
  const config = validateProductionWebConfig(validEnvironment);
  assert.equal(config.projectId, "tl-analytics-prod");
  assert.equal(config.pagesOrigin, "https://company.github.io");
  assert.equal(Object.hasOwn(config, "functionsBaseUrl"), false);
});

test("production web configuration rejects missing, placeholder and malformed values", async () => {
  const { validateProductionWebConfig } = await import(validatorUrl);
  for (const change of [
    { PORTAL_FIREBASE_API_KEY: "" },
    { PORTAL_FIREBASE_PROJECT_ID: "replace-with-production-project-id" },
    { PORTAL_PAGES_ORIGIN: "http://insecure.example" },
    { PORTAL_PAGES_ORIGIN: "https://company.github.io/wrong-path" },
    { PORTAL_FIREBASE_APP_ID: "not-an-app-id" },
  ]) {
    assert.throws(
      () => validateProductionWebConfig({ ...validEnvironment, ...change }),
      /production web configuration/i,
    );
  }
});

test("production web configuration binds Pages origin to Firebase Auth domains", async () => {
  const { validateProductionWebConfig } = await import(validatorUrl);
  assert.throws(
    () => validateProductionWebConfig({ ...validEnvironment, PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON: "[]" }),
    /authorized domains/i,
  );
});

test("authorized-domain live check compares Firebase project configuration", async () => {
  const { validateProductionWebConfig, verifyFirebaseAuthorizedDomains } = await import(validatorUrl);
  const config = validateProductionWebConfig(validEnvironment);
  const success = async () => new Response(
    JSON.stringify({ projectId: config.projectId, authorizedDomains: config.authorizedDomains }),
    { status: 200 },
  );
  await assert.doesNotReject(() => verifyFirebaseAuthorizedDomains(config, success));
  await assert.doesNotReject(() => verifyFirebaseAuthorizedDomains(
    config,
    async () => new Response(
      JSON.stringify({ projectId: config.projectNumber, authorizedDomains: config.authorizedDomains }),
      { status: 200 },
    ),
  ));
  await assert.rejects(
    () => verifyFirebaseAuthorizedDomains(
      config,
      async () => new Response(
        JSON.stringify({ projectId: config.projectId, authorizedDomains: ["tl-analytics.firebaseapp.com"] }),
        { status: 200 },
      ),
    ),
    /company\.github\.io/,
  );
});

test("Pages workflow runs preflight before build and static smoke after deployment", () => {
  const workflow = read(".github/workflows/deploy-pages.yml");
  const packageJson = JSON.parse(read("package.json"));
  const smoke = read("tests/e2e/pages-deployment.smoke.spec.ts");
  assert.match(packageJson.scripts["validate:pages-production"], /validate-production-web-config/);
  assert.match(packageJson.scripts["test:pages-smoke"], /pages-deployment\.smoke\.spec\.ts/);
  assert.ok(workflow.indexOf("npm run validate:pages-production") < workflow.indexOf("npm run build:web"));
  assert.ok(workflow.indexOf("actions/deploy-pages") < workflow.indexOf("npm run test:pages-smoke"));
  assert.match(workflow, /PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON/);
  assert.doesNotMatch(workflow, /FUNCTIONS|ALLOWED_WEB_ORIGINS|CORS/i);
  assert.match(smoke, /history-smoke/);
  assert.match(smoke, /pageerror/);
  assert.doesNotMatch(smoke, /OPTIONS|access-control-allow-origin|FUNCTIONS/i);
});

test("server deployment workflow is absent", () => {
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "deploy-firebase.yml")), false);
});
