import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const validatorUrl = pathToFileURL(path.join(repositoryRoot, "scripts", "validate-contracts.mjs")).href;

async function loadValidator() {
  return import(validatorUrl);
}

function action(overrides = {}) {
  return {
    action_key: "asset.image_exporter.run",
    display_name: "运行",
    page: "asset",
    introduced_version: "8.0.0",
    retired_version: null,
    accept_until: null,
    display_state: "active",
    ...overrides,
  };
}

function tool(overrides = {}) {
  return {
    tool_key: "asset.image_exporter",
    display_name: "资产图像导出",
    page: "asset",
    introduced_version: "8.0.0",
    retired_version: null,
    accept_until: null,
    display_state: "active",
    actions: [action()],
    ...overrides,
  };
}

function registry(tools = [tool()]) {
  return { schema_version: "1.0.0", registry_version: "1.0.0", tools };
}

test("checked-in registry validates without server activation or generation state", async () => {
  const { loadToolRegistry, validateToolRegistry } = await loadValidator();
  const value = loadToolRegistry();
  assert.equal(value.tools.length, 68);
  assert.equal("registry_status" in value, false);
  assert.doesNotThrow(() => validateToolRegistry(value));
  assert.equal(JSON.stringify(value).includes("generation"), false);
});

test("requires stable registry and action keys with lifecycle consistency", async () => {
  const { validateToolRegistry } = await loadValidator();
  assert.doesNotThrow(() => validateToolRegistry(registry()));
  assert.throws(() => validateToolRegistry(registry([tool(), tool()])), /duplicate stable key/i);
  assert.throws(() => validateToolRegistry(registry([tool({ actions: [action(), action()] })])), /duplicate stable key/i);
  assert.throws(() => validateToolRegistry(registry([tool({ actions: [action({ action_key: "asset.image_exporter" })] })])), /reused across tool and action/i);
  assert.throws(() => validateToolRegistry(registry([tool({ display_state: "retired" })])), /retired entries require/i);
});

test("rejects actions introduced before their parent tool", async () => {
  const { validateToolRegistry } = await loadValidator();
  assert.throws(
    () => validateToolRegistry(registry([tool({ actions: [action({ introduced_version: "7.9.0" })] })])),
    /introduced_version precedes tool/i,
  );
});

test("rejects actions whose stable key belongs to another tool", async () => {
  const { validateToolRegistry } = await loadValidator();
  assert.throws(
    () => validateToolRegistry(registry([tool({ actions: [action({ action_key: "other_tool.run" })] })])),
    /parent tool_key prefix/i,
  );
});

test("rejects unknown tool/action pairs used by an event", async () => {
  const { loadToolRegistry, validateRegisteredToolAction } = await loadValidator();
  const value = loadToolRegistry();
  assert.doesNotThrow(() => validateRegisteredToolAction(value, "asset_ref_exporter", "asset_ref_exporter.open"));
  assert.throws(() => validateRegisteredToolAction(value, "missing.tool", "missing.tool.run"), /unknown tool key/i);
  assert.throws(() => validateRegisteredToolAction(value, "asset_ref_exporter", "asset_ref_exporter.missing"), /unknown action key/i);
});

test("does not expose enterprise activation helpers", async () => {
  const validator = await loadValidator();
  assert.equal("isRegistryIngestionEnabled" in validator, false);
  assert.equal("requireActiveProductionRegistry" in validator, false);
});
