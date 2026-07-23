import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..");

const requiredFiles = [
  ".github/workflows/deploy-firebase.yml",
  ".github/workflows/deploy-pages.yml",
  ".github/workflows/verify.yml",
  "README.md",
  "config/environments/.env.emulator.example",
  "config/environments/.env.production.example",
  "config/environments/.env.test.example",
  "contracts/auth-domain-boundaries.md",
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
  "functions/package.json",
  "functions/src/index.ts",
  "functions/tsconfig.json",
  "package-lock.json",
  "package.json",
  "scripts/verify-pages-artifacts.mjs",
  "scripts/validate-contracts.mjs",
  "tests/contracts/repository-contract.test.mjs",
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

test("repository scaffold satisfies the Task 1 structure contract", () => {
  const missingFiles = requiredFiles.filter((relativePath) => {
    try {
      return !fs.statSync(fromRoot(relativePath)).isFile();
    } catch {
      return true;
    }
  });
  assert.deepEqual(
    missingFiles,
    [],
    `Missing required files: ${missingFiles.join(", ")}`,
  );

  const rootPackage = readJson("package.json");
  assert.deepEqual(rootPackage.workspaces, ["web", "functions"]);
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
  assert.ok(rootPackage.scripts["build:web"]);
  assert.match(rootPackage.scripts["build:web"], /-- --mode production$/);
  assert.ok(rootPackage.scripts["build:functions"]);
  assert.equal(
    rootPackage.scripts.verify,
    "npm run verify:core && npm run test:e2e",
  );
  assert.equal(
    rootPackage.scripts["verify:core"],
    "npm run test:structure && npm run test:contracts && npm run test:plugin-auth && npm run test:usage && npm run test:plugin-pairing-web && npm run test:portal && node --test tests/web/e2e-gate.contract.test.mjs && npm run test:pages-deployment-gates && npm run build:web && npm run test:pages-artifacts && npm run build:functions",
  );
  assert.ok(rootPackage.scripts["test:contracts"]);
  assert.ok(rootPackage.scripts["test:rules"]);
  assert.equal(
    rootPackage.scripts["validate:production-registry"],
    "node scripts/validate-contracts.mjs --require-active",
  );
  assert.match(rootPackage.devDependencies["firebase-tools"], /^\d+\.\d+\.\d+$/);
  assert.match(rootPackage.devDependencies.yaml, /^\d+\.\d+\.\d+$/);

  const functionsPackage = readJson("functions/package.json");
  assert.equal(functionsPackage.engines.node, ">=22.12.0 <23");

  const webPackage = readJson("web/package.json");
  assert.match(webPackage.scripts.build, /vite build/);
  const viteConfig = readText("web/vite.config.ts");
  assert.match(viteConfig, /PORTAL_PUBLIC_BASE_PATH/);
  assert.match(viteConfig, /404\.html/);

  for (const environment of ["production", "test", "emulator"]) {
    const text = readText(`config/environments/.env.${environment}.example`);
    const keys = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    assert.ok(keys.some((key) => key.startsWith("PORTAL_")));
    assert.ok(keys.some((key) => key.startsWith("PLUGIN_")));
    assert.ok(
      keys.every(
        (key) =>
          key.startsWith("PORTAL_") ||
          key.startsWith("PLUGIN_") ||
          key.startsWith("VITE_PLUGIN_"),
      ),
      `${environment} contains a key without a PORTAL_, PLUGIN_, or VITE_PLUGIN_ prefix`,
    );
  }

  const verifyWorkflow = readWorkflow(".github/workflows/verify.yml");
  assert.ok(Object.hasOwn(verifyWorkflow.on, "pull_request"));
  assert.ok(Object.hasOwn(verifyWorkflow.on, "push"));
  assert.ok(Object.hasOwn(verifyWorkflow.on, "workflow_dispatch"));
  assert.deepEqual(verifyWorkflow.on.push.branches, ["main"]);
  assert.deepEqual(verifyWorkflow.permissions, { contents: "read" });
  assert.equal(Object.hasOwn(verifyWorkflow.jobs.verify, "environment"), false);
  const verifySteps = verifyWorkflow.jobs.verify.steps;
  assert.equal(findStep(verifySteps, "Set up Node.js").with["node-version"], 22);
  assert.equal(findStep(verifySteps, "Verify structure and builds").run, "npm run verify:core");

  const pagesWorkflow = readWorkflow(".github/workflows/deploy-pages.yml");
  assert.ok(Object.hasOwn(pagesWorkflow.on, "push"));
  assert.ok(Object.hasOwn(pagesWorkflow.on, "workflow_dispatch"));
  assert.deepEqual(pagesWorkflow.on.push.branches, ["main"]);
  assert.deepEqual(pagesWorkflow.permissions, {
    contents: "read",
    pages: "write",
    "id-token": "write",
  });
  const pagesJob = pagesWorkflow.jobs["build-and-deploy"];
  assert.equal(pagesJob.environment.name, "github-pages");
  const pagesSteps = pagesJob.steps;
  assert.equal(findStep(pagesSteps, "Set up Node.js").with["node-version"], 22);
  const pagesGate = findStep(pagesSteps, "Require main ref");
  assert.equal(pagesGate.if, "github.ref != 'refs/heads/main'");
  assert.match(pagesGate.run, /exit 1/);
  assert.ok(
    pagesSteps.indexOf(pagesGate) <
      pagesSteps.indexOf(findStep(pagesSteps, "Configure Pages")),
  );
  const pagesBuildIndex = pagesSteps.indexOf(findStep(pagesSteps, "Build portal"));
  const pagesContractIndex = pagesSteps.indexOf(
    findStep(pagesSteps, "Verify Pages artifacts"),
  );
  const pagesUploadIndex = pagesSteps.indexOf(
    findStep(pagesSteps, "Upload Pages artifact"),
  );
  assert.ok(pagesBuildIndex < pagesContractIndex);
  assert.ok(pagesContractIndex < pagesUploadIndex);
  assert.equal(pagesSteps[pagesContractIndex].run, "npm run test:pages-artifacts");

  const firebaseWorkflow = readWorkflow(".github/workflows/deploy-firebase.yml");
  assert.deepEqual(Object.keys(firebaseWorkflow.on), ["workflow_dispatch"]);
  assert.deepEqual(firebaseWorkflow.permissions, {
    contents: "read",
    "id-token": "write",
  });
  const firebaseJob = firebaseWorkflow.jobs.deploy;
  assert.equal(firebaseJob.environment, "firebase-production");
  const firebaseSteps = firebaseJob.steps;
  assert.equal(findStep(firebaseSteps, "Set up Node.js").with["node-version"], 22);
  const firebaseGate = findStep(firebaseSteps, "Require main ref");
  assert.equal(firebaseGate.if, "github.ref != 'refs/heads/main'");
  assert.match(firebaseGate.run, /exit 1/);
  assert.ok(
    firebaseSteps.indexOf(firebaseGate) <
      firebaseSteps.indexOf(findStep(firebaseSteps, "Authenticate to Google Cloud")),
  );
  const firebaseVerifyIndex = firebaseSteps.indexOf(
    findStep(firebaseSteps, "Verify repository"),
  );
  const firebaseRegistryGateIndex = firebaseSteps.indexOf(
    findStep(firebaseSteps, "Require active production registry"),
  );
  const firebaseAuthIndex = firebaseSteps.indexOf(
    findStep(firebaseSteps, "Authenticate to Google Cloud"),
  );
  const firebaseDeployIndex = firebaseSteps.indexOf(
    findStep(firebaseSteps, "Deploy functions and Firestore configuration"),
  );
  assert.ok(firebaseVerifyIndex < firebaseRegistryGateIndex);
  assert.ok(firebaseRegistryGateIndex < firebaseAuthIndex);
  assert.ok(firebaseRegistryGateIndex < firebaseDeployIndex);
  assert.equal(firebaseSteps[firebaseVerifyIndex].run, "npm run verify");
  assert.equal(
    firebaseSteps[firebaseRegistryGateIndex].run,
    "npm run validate:production-registry",
  );
  assert.match(firebaseSteps[firebaseDeployIndex].run, /npm run firebase -- deploy/);
  assert.equal(
    firebaseSteps.some((step) =>
      String(step.run || "").includes("npm install -g firebase-tools"),
    ),
    false,
  );

  const firebaseConfig = readJson("firebase.json");
  assert.equal(firebaseConfig.functions.source, "functions");
  assert.equal(firebaseConfig.functions.runtime, "nodejs22");
  assert.equal(Object.hasOwn(firebaseConfig, "projects"), false);
  assert.match(readText("functions/src/index.ts"), /firebase-functions\/v2/);
  const firestoreRules = readText("firestore.rules");
  assert.match(firestoreRules, /allow read, write: if false;/);

  const readme = readText("README.md");
  assert.match(readme, /independent from the PCG Firebase project/i);
  assert.match(readme, /authentication domains? (?:are|must remain) isolated/i);

  const gitignore = readText(".gitignore").split(/\r?\n/);
  assert.ok(gitignore.includes("gha-creds-*.json"));

  const dependencySecurity = readText("docs/dependency-security.md");
  assert.match(dependencySecurity, /firebase-tools.*5 moderate/i);
  assert.match(dependencySecurity, /functions.*7 moderate/i);
  assert.match(dependencySecurity, /TL Art Tool maintainers/);
  assert.match(dependencySecurity, /2026-08-22/);
  assert.match(dependencySecurity, /first runtime handler/i);
  assert.match(dependencySecurity, /Storage/i);
});
