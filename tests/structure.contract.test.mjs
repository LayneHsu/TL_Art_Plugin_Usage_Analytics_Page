import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..");

const requiredFiles = [
  ".github/workflows/deploy-pages.yml",
  ".github/workflows/verify.yml",
  "README.md",
  "config/environments/.env.emulator.example",
  "config/environments/.env.production.example",
  "config/environments/.env.test.example",
  "contracts/data-contract.md",
  "contracts/error-redaction.md",
  "contracts/tool-registry.json",
  "contracts/tool-registry.schema.json",
  "contracts/usage-event-schema.json",
  "docs/data-retention.md",
  "docs/dependency-security.md",
  "docs/deployment.md",
  "docs/environment.md",
  "docs/permissions.md",
  "firebase.json",
  "firestore.indexes.json",
  "firestore.rules",
  "package-lock.json",
  "package.json",
  "scripts/validate-contracts.mjs",
  "scripts/validate-production-web-config.mjs",
  "scripts/verify-pages-artifacts.mjs",
  "tests/contracts/repository-contract.test.mjs",
  "tests/contracts/spark-architecture.contract.test.mjs",
  "tests/contracts/tool-registry.test.mjs",
  "tests/contracts/usage-event-schema.test.mjs",
  "tests/pages-artifacts.contract.test.mjs",
  "tests/rules/firestore.rules.test.mjs",
  "web/index.html",
  "web/package.json",
  "web/public/.nojekyll",
  "web/src/App.vue",
  "web/src/main.ts",
  "web/tsconfig.json",
  "web/vite.config.ts",
];

const removedPaths = [
  ".github/workflows/deploy-firebase.yml",
  "config/firebase-runtime-parameters.json",
  "functions",
  "scripts/sync-firebase-secrets.mjs",
  "scripts/validate-firebase-runtime-config.mjs",
  "web/src/plugin-pairing",
];

function fromRoot(relativePath) {
  return path.join(repositoryRoot, ...relativePath.split("/"));
}

function readText(relativePath) {
  return fs.readFileSync(fromRoot(relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readWorkflow(relativePath) {
  return parseYaml(readText(relativePath));
}

function findStep(steps, name) {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `Missing workflow step: ${name}`);
  return step;
}

test("repository scaffold exposes only the Spark web workspace", () => {
  const missingFiles = requiredFiles.filter((relativePath) => {
    try {
      return !fs.statSync(fromRoot(relativePath)).isFile();
    } catch {
      return true;
    }
  });
  assert.deepEqual(missingFiles, [], `Missing required files: ${missingFiles.join(", ")}`);
  assert.deepEqual(
    removedPaths.filter((relativePath) => fs.existsSync(fromRoot(relativePath))),
    [],
    "Server and browser-pairing paths must stay removed",
  );

  const rootPackage = readJson("package.json");
  assert.deepEqual(rootPackage.workspaces, ["web"]);
  assert.equal(rootPackage.private, true);
  assert.equal(rootPackage.engines.node, ">=22.12.0 <23");
  assert.equal(
    rootPackage.scripts["test:structure"],
    "node --test tests/structure.contract.test.mjs tests/environment.contract.test.mjs",
  );
  assert.equal(
    rootPackage.scripts["test:pages-artifacts"],
    "node --test tests/pages-artifacts.contract.test.mjs && node scripts/verify-pages-artifacts.mjs web/dist",
  );
  assert.match(rootPackage.scripts["build:web"], /-- --mode production$/);
  assert.equal(rootPackage.scripts.build, "npm run build:web");
  assert.match(rootPackage.scripts["test:rules"], /firebase emulators:exec --only firestore/);
  assert.match(rootPackage.scripts["test:cross"], /importtool-registry-parity/);
  assert.match(rootPackage.scripts["test:e2e"], /playwright test/);
  assert.equal(Object.hasOwn(rootPackage.scripts, "build:functions"), false);

  const webPackage = readJson("web/package.json");
  assert.match(webPackage.scripts.build, /vite build/);
  const viteConfig = readText("web/vite.config.ts");
  assert.match(viteConfig, /PORTAL_PUBLIC_BASE_PATH/);
  assert.match(viteConfig, /404\.html/);

  for (const environment of ["production", "test", "emulator"]) {
    const text = readText(`config/environments/.env.${environment}.example`);
    const keys = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    assert.ok(keys.length > 0);
    assert.ok(keys.every((key) => key.startsWith("PORTAL_")));
  }
});

test("verification and Pages workflows keep only static web and Firestore checks", () => {
  const verifyWorkflow = readWorkflow(".github/workflows/verify.yml");
  assert.ok(Object.hasOwn(verifyWorkflow.on, "pull_request"));
  assert.ok(Object.hasOwn(verifyWorkflow.on, "push"));
  assert.ok(Object.hasOwn(verifyWorkflow.on, "workflow_dispatch"));
  assert.deepEqual(verifyWorkflow.on.push.branches, ["main"]);
  assert.deepEqual(verifyWorkflow.permissions, { contents: "read" });
  const verifySteps = verifyWorkflow.jobs.verify.steps;
  assert.equal(findStep(verifySteps, "Set up Node.js").with["node-version"], 22);
  assert.equal(findStep(verifySteps, "Verify structure and builds").run, "npm run verify:core");
  assert.equal(verifySteps.some((step) => /plugin auth|usage ingestion/i.test(step.name ?? "")), false);

  const pagesWorkflow = readWorkflow(".github/workflows/deploy-pages.yml");
  assert.deepEqual(pagesWorkflow.on.push.branches, ["main"]);
  assert.deepEqual(pagesWorkflow.permissions, {
    contents: "read",
    pages: "write",
    "id-token": "write",
  });
  const pagesSteps = pagesWorkflow.jobs["build-and-deploy"].steps;
  const pagesGate = findStep(pagesSteps, "Require main ref");
  const pagesBuild = findStep(pagesSteps, "Build portal");
  const pagesArtifacts = findStep(pagesSteps, "Verify Pages artifacts");
  const pagesUpload = findStep(pagesSteps, "Upload Pages artifact");
  assert.ok(pagesSteps.indexOf(pagesGate) < pagesSteps.indexOf(pagesBuild));
  assert.ok(pagesSteps.indexOf(pagesBuild) < pagesSteps.indexOf(pagesArtifacts));
  assert.ok(pagesSteps.indexOf(pagesArtifacts) < pagesSteps.indexOf(pagesUpload));
  assert.equal(pagesArtifacts.run, "npm run test:pages-artifacts");
  assert.doesNotMatch(readText(".github/workflows/deploy-pages.yml"), /functions|secret manager|cloud scheduler/i);
});

test("Firebase configuration stays within Firestore and local Auth emulation", () => {
  const firebaseConfig = readJson("firebase.json");
  assert.deepEqual(Object.keys(firebaseConfig).sort(), ["emulators", "firestore"]);
  assert.equal(Object.hasOwn(firebaseConfig.emulators, "functions"), false);
  assert.equal(firebaseConfig.emulators.auth.port, 9099);
  assert.equal(firebaseConfig.emulators.firestore.port, 8080);
  assert.equal(firebaseConfig.emulators.ui.enabled, true);

  const readme = readText("README.md");
  assert.match(readme, /Firebase Spark/i);
  assert.match(readme, /independent from the PCG Firebase project/i);
});
