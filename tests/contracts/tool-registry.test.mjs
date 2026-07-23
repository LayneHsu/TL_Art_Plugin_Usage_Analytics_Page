import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");
const validatorUrl = pathToFileURL(
  path.join(repositoryRoot, "scripts", "validate-contracts.mjs"),
).href;

async function loadValidator() {
  return import(validatorUrl);
}

function entry(overrides = {}) {
  return {
    tool_key: "asset.image_exporter",
    display_name: "资产图像导出",
    page: "asset",
    introduced_version: "8.0.0",
    retired_version: null,
    accept_until: null,
    display_state: "active",
    actions: [
      {
        action_key: "asset.image_exporter.open",
        display_name: "打开资产图像导出",
        page: "asset",
        introduced_version: "8.0.0",
        retired_version: null,
        accept_until: null,
        display_state: "active",
      },
    ],
    ...overrides,
  };
}

function registry(tools = [], registryStatus = "draft") {
  return {
    schema_version: "1.0.0",
    registry_version: "1.0.0",
    registry_status: registryStatus,
    tools,
  };
}

test("accepts the checked-in versioned active registry for ingestion", async () => {
  const {
    isRegistryIngestionEnabled,
    loadToolRegistry,
    validateToolRegistry,
  } = await loadValidator();
  const value = loadToolRegistry();
  assert.equal(value.registry_status, "active");
  assert.equal(value.tools.length, 68);
  assert.doesNotThrow(() => validateToolRegistry(value));
  assert.equal(isRegistryIngestionEnabled(value), true);
});

test("enforces SemVer 2.0 for registry version fields", async () => {
  const { validateToolRegistry } = await loadValidator();
  for (const registry_version of ["8.0.0", "8.0.0-beta.1+build.5"]) {
    assert.doesNotThrow(
      () => validateToolRegistry({ ...registry(), registry_version }),
      registry_version,
    );
  }
  for (const registry_version of ["8.0.0-01", "08.0.0"]) {
    assert.throws(
      () => validateToolRegistry({ ...registry(), registry_version }),
      /registry_version.*pattern/i,
      registry_version,
    );
  }
});

test("requires active registries to contain tools and actions", async () => {
  const { isRegistryIngestionEnabled, validateToolRegistry } = await loadValidator();
  assert.throws(
    () => validateToolRegistry(registry([], "active")),
    /active registry.*at least one tool/i,
  );
  assert.throws(
    () =>
      validateToolRegistry(
        registry([entry({ actions: [] })], "active"),
      ),
    /active registry.*at least one action/i,
  );
  const active = registry([entry()], "active");
  assert.doesNotThrow(() => validateToolRegistry(active));
  assert.equal(isRegistryIngestionEnabled(active), true);
});

test("rejects unknown registry states", async () => {
  const { validateToolRegistry } = await loadValidator();
  assert.throws(
    () => validateToolRegistry(registry([], "published")),
    /registry_status/i,
  );
});

test("rejects duplicate tool keys", async () => {
  const { validateToolRegistry } = await loadValidator();
  assert.throws(
    () => validateToolRegistry(registry([entry(), entry()])),
    /duplicate stable key/i,
  );
});

test("rejects duplicate action keys across tools", async () => {
  const { validateToolRegistry } = await loadValidator();
  const second = entry({
    tool_key: "asset.reference_exporter",
    display_name: "资产引用导出",
  });
  assert.throws(
    () => validateToolRegistry(registry([entry(), second])),
    /duplicate stable key/i,
  );
});

test("rejects reuse of a stable key across tool and action namespaces", async () => {
  const { validateToolRegistry } = await loadValidator();
  const value = entry({
    actions: [
      {
        ...entry().actions[0],
        action_key: "asset.image_exporter",
      },
    ],
  });
  assert.throws(
    () => validateToolRegistry(registry([value])),
    /reused across tool and action/i,
  );
});

test("rejects invalid display states and inconsistent retirement deadlines", async () => {
  const { validateToolRegistry } = await loadValidator();
  assert.throws(
    () => validateToolRegistry(registry([entry({ display_state: "deleted" })])),
    /display_state/i,
  );
  assert.throws(
    () =>
      validateToolRegistry(
        registry([
          entry({
            display_state: "retired",
            retired_version: null,
            accept_until: null,
          }),
        ]),
      ),
    /retired_version|accept_until/i,
  );
  assert.throws(
    () =>
      validateToolRegistry(
        registry([
          entry({
            display_state: "active",
            retired_version: "8.1.0",
            accept_until: "2026-12-31T23:59:59Z",
          }),
        ]),
      ),
    /active.*retired_version|retired_version.*active/i,
  );
});

test("does not reject a retired stable key before accept_until", async () => {
  const { isRegistryEntryAccepted, validateToolRegistry } = await loadValidator();
  const retired = entry({
    display_state: "retired",
    retired_version: "8.1.0",
    accept_until: "2026-12-31T23:59:59Z",
    actions: [
      {
        ...entry().actions[0],
        display_state: "retired",
        retired_version: "8.1.0",
        accept_until: "2026-12-31T23:59:59Z",
      },
    ],
  });
  assert.doesNotThrow(() => validateToolRegistry(registry([retired])));
  assert.equal(
    isRegistryEntryAccepted(retired, new Date("2026-12-31T23:59:58Z")),
    true,
  );
  assert.equal(
    isRegistryEntryAccepted(retired, new Date("2027-01-01T00:00:00Z")),
    false,
  );
});

test("uses SemVer prerelease precedence for lifecycle versions", async () => {
  const { validateToolRegistry } = await loadValidator();
  assert.throws(
    () =>
      validateToolRegistry(
        registry([
          entry({
            introduced_version: "8.0.0",
            display_state: "retired",
            retired_version: "8.0.0-beta.1",
            accept_until: "2026-12-31T23:59:59Z",
          }),
        ]),
      ),
    /retired_version precedes introduced_version/i,
  );
  assert.doesNotThrow(() =>
    validateToolRegistry(
      registry([
        entry({
          introduced_version: "8.0.0-beta.1",
          display_state: "retired",
          retired_version: "8.0.0",
          accept_until: "2026-12-31T23:59:59Z",
          actions: [
            {
              ...entry().actions[0],
              display_state: "retired",
              retired_version: "8.0.0",
              accept_until: "2026-12-31T23:59:59Z",
            },
          ],
        }),
      ]),
    ),
  );
});

test("rejects actions introduced before their tool", async () => {
  const { validateToolRegistry } = await loadValidator();
  const value = entry({
    introduced_version: "8.0.0",
    actions: [
      {
        ...entry().actions[0],
        introduced_version: "7.9.0",
      },
    ],
  });
  assert.throws(
    () => validateToolRegistry(registry([value])),
    /action.*introduced_version.*tool/i,
  );
});

test("rejects actions that outlive a retired tool", async () => {
  const { validateToolRegistry } = await loadValidator();
  const parentRetirement = {
    display_state: "retired",
    retired_version: "9.0.0",
    accept_until: "2026-12-31T23:59:59Z",
  };
  const baseAction = entry().actions[0];

  assert.throws(
    () => validateToolRegistry(registry([entry(parentRetirement)])),
    /action.*retired tool.*must be retired/i,
  );
  assert.throws(
    () =>
      validateToolRegistry(
        registry([
          entry({
            ...parentRetirement,
            actions: [
              {
                ...baseAction,
                display_state: "retired",
                retired_version: "9.1.0",
                accept_until: "2026-12-31T23:59:59Z",
              },
            ],
          }),
        ]),
      ),
    /action.*retired_version.*tool/i,
  );
  assert.throws(
    () =>
      validateToolRegistry(
        registry([
          entry({
            ...parentRetirement,
            actions: [
              {
                ...baseAction,
                display_state: "retired",
                retired_version: "8.5.0",
                accept_until: "2027-01-01T00:00:00Z",
              },
            ],
          }),
        ]),
      ),
    /action.*accept_until.*tool/i,
  );
});
