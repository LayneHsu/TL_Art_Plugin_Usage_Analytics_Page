import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

test("error collection contract limits and redacts client reports", () => {
  const redaction = read("contracts/error-redaction.md");
  assert.match(redaction, /8\s*KiB/i);
  assert.match(redaction, /traceback|stack/i);
  assert.match(redaction, /absolute path/i);
  assert.match(redaction, /token|credential/i);
  assert.match(redaction, /request body/i);
});

test("dependency policy covers the Spark static portal boundary", () => {
  const policy = read("docs/dependency-security.md");
  assert.match(policy, /web/i);
  assert.match(policy, /Firestore Rules/i);
  assert.match(policy, /package-lock\.json/i);
  assert.doesNotMatch(policy, /server runtime|service account|workload identity/i);
});

test("retired enterprise contracts, operations, and tests are absent", () => {
  for (const relativePath of [
    "contracts/auth-domain-boundaries.md",
    "contracts/plugin-auth-contract.md",
    "docs/plugin-auth-operations.md",
    "docs/usage-ingestion.md",
    "docs/usage-operations.md",
    "tests/contracts/firebase-secret-sync.test.mjs",
    "tests/contracts/plugin-auth-production.contract.test.mjs",
    "tests/web/plugin-pairing-page.contract.test.mjs",
  ]) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, relativePath)), false, relativePath);
  }
});
