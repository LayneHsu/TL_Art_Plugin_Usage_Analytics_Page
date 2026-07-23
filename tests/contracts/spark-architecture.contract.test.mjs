import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const retiredEnterprisePaths = [
  ".github/workflows/deploy-firebase.yml",
  "config/firebase-runtime-parameters.json",
  "contracts/auth-domain-boundaries.md",
  "contracts/plugin-auth-contract.md",
  "docs/plugin-auth-operations.md",
  "docs/usage-ingestion.md",
  "docs/usage-operations.md",
  "functions",
  "scripts/sync-firebase-secrets.mjs",
  "scripts/validate-firebase-runtime-config.mjs",
  "tests/contracts/firebase-secret-sync.test.mjs",
  "tests/contracts/plugin-auth-production.contract.test.mjs",
  "tests/web/plugin-pairing-page.contract.test.mjs",
  "web/src/plugin-pairing",
];

const forbiddenServerRuntimePackages = new Set([
  "firebase-admin",
  "firebase-functions",
]);

function findForbiddenServerRuntimeReferences(lock) {
  const references = [];
  const dependencyFields = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];

  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    const normalizedPath = packagePath.replaceAll("\\", "/");
    const installedPackage = normalizedPath.match(
      /(?:^|\/)node_modules\/(firebase-admin|firebase-functions)$/,
    )?.[1];
    if (installedPackage) references.push(`${packagePath}:installed:${installedPackage}`);

    for (const field of dependencyFields) {
      for (const dependencyName of Object.keys(entry?.[field] ?? {})) {
        if (forbiddenServerRuntimePackages.has(dependencyName)) {
          references.push(`${packagePath || "<root>"}:${field}:${dependencyName}`);
        }
      }
    }
  }

  return references.sort();
}

test("production architecture stays inside Firebase Spark", () => {
  for (const relativePath of retiredEnterprisePaths) {
    assert.equal(
      fs.existsSync(path.join(root, relativePath)),
      false,
      `Retired enterprise path must not exist: ${relativePath}`,
    );
  }

  const firebaseConfig = JSON.parse(read("firebase.json"));
  assert.equal("functions" in firebaseConfig, false);

  const packageConfig = JSON.parse(read("package.json"));
  assert.deepEqual(packageConfig.workspaces, ["web"]);
  for (const value of Object.values(packageConfig.scripts)) {
    assert.doesNotMatch(value, /functions|plugin-auth|secret|scheduler/i);
  }
});

test("dependency lock has no Functions workspace or server runtime packages", () => {
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(Object.hasOwn(lock.packages, "functions"), false);
  assert.deepEqual(findForbiddenServerRuntimeReferences(lock), []);
});

test("dependency lock audit detects nested installs and indirect declarations", () => {
  const fixture = {
    packages: {
      "node_modules/example/node_modules/firebase-admin": {},
      "node_modules/example": {
        optionalDependencies: {
          "firebase-functions": "7.3.0",
        },
      },
      "node_modules/peer-example": {
        peerDependencies: {
          "firebase-admin": "^14.0.0",
        },
      },
    },
  };

  assert.deepEqual(findForbiddenServerRuntimeReferences(fixture), [
    "node_modules/example/node_modules/firebase-admin:installed:firebase-admin",
    "node_modules/example:optionalDependencies:firebase-functions",
    "node_modules/peer-example:peerDependencies:firebase-admin",
  ]);
});

test("web app has no server endpoint or browser pairing route", () => {
  assert.equal(fs.existsSync(path.join(root, "web/src/plugin-pairing")), false);
  assert.doesNotMatch(read("web/src/App.vue"), /plugin\/pair|PluginPairing/i);
  assert.doesNotMatch(read("web/src/vite-env.d.ts"), /FUNCTIONS|VITE_PLUGIN/i);
  assert.doesNotMatch(read("web/vite.config.ts"), /VITE_PLUGIN/i);
});

test("runtime repository contains no server-secret or scheduled deployment wiring", () => {
  const checkedFiles = [
    "README.md",
    ".github/workflows/deploy-pages.yml",
    ".github/workflows/verify.yml",
    "scripts/validate-production-web-config.mjs",
  ];
  const source = checkedFiles.map(read).join("\n");
  assert.doesNotMatch(source, /Secret Manager|Cloud Scheduler|PORTAL_FUNCTIONS_BASE_URL|deploy.*functions/i);
});
