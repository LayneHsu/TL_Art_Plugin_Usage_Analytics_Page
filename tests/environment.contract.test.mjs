import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile, loadEnv } from "vite";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..");
const environmentDirectory = path.join(repositoryRoot, "config", "environments");

test("standard environment samples are trackable", () => {
  for (const mode of ["production", "test", "emulator"]) {
    const relativePath = `config/environments/.env.${mode}.example`;
    const result = spawnSync(
      "git",
      ["check-ignore", "--quiet", "--no-index", relativePath],
      { cwd: repositoryRoot },
    );
    assert.equal(result.status, 1, `${relativePath} must not be ignored`);
  }
});

for (const mode of ["production", "test", "emulator"]) {
  test(`loads the ${mode} template with Vite mode semantics`, () => {
    const samplePath = path.join(
      environmentDirectory,
      `.env.${mode}.example`,
    );
    assert.ok(fs.existsSync(samplePath), `Missing environment sample: ${samplePath}`);

    const temporaryEnvironmentDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), `vite-env-${mode}-`),
    );
    try {
      fs.copyFileSync(
        samplePath,
        path.join(temporaryEnvironmentDirectory, `.env.${mode}.local`),
      );

      const portalEnvironment = loadEnv(
        mode,
        temporaryEnvironmentDirectory,
        "PORTAL_",
      );
      const completeEnvironment = loadEnv(
        mode,
        temporaryEnvironmentDirectory,
        "",
      );

      assert.equal(portalEnvironment.PORTAL_DEPLOY_ENV, mode);
      assert.ok(portalEnvironment.PORTAL_PUBLIC_BASE_PATH);
      assert.equal(
        Object.keys(portalEnvironment).some((key) => key.startsWith("PLUGIN_")),
        false,
      );
      assert.equal(completeEnvironment.PLUGIN_DEPLOY_ENV, mode);
    } finally {
      fs.rmSync(temporaryEnvironmentDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
}

test("web configuration exposes only portal and explicitly public plugin values", async () => {
  const loadedConfig = await loadConfigFromFile(
    { command: "build", mode: "production" },
    path.join(repositoryRoot, "web", "vite.config.ts"),
    repositoryRoot,
  );
  assert.ok(loadedConfig);
  assert.deepEqual(loadedConfig.config.envPrefix, ["PORTAL_", "VITE_PLUGIN_"]);
  for (const mode of ["production", "test", "emulator"]) {
    const sample = fs.readFileSync(
      path.join(environmentDirectory, `.env.${mode}.example`),
      "utf8",
    );
    assert.match(sample, /^VITE_PLUGIN_AUTH_BASE_URL=/m);
    assert.doesNotMatch(
      sample,
      /PLUGIN_(?:OAUTH_CLIENT_SECRET|CREDENTIAL_PEPPER|PRINCIPAL_KEY_PEPPER|LEASE_SIGNING_KEYS)/,
    );
  }
});

test("repository commands document explicit Vite modes", () => {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const documentation = fs.readFileSync(
    path.join(repositoryRoot, "docs", "environment.md"),
    "utf8",
  );

  assert.match(rootPackage.scripts["build:web"], /-- --mode production$/);
  for (const mode of ["production", "test", "emulator"]) {
    assert.match(documentation, new RegExp(`--mode ${mode}`));
    assert.match(documentation, new RegExp(`\\.env\\.${mode}\\.local`));
  }
});
