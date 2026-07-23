import assert from "node:assert/strict";
import test from "node:test";

import {
  BUNDLED_TOOL_REGISTRY,
  assertBundledRegistry,
  validateRegistryAgainstAuthoritativeSchema,
} from "../src/usage/contract-artifacts";
import type { ToolRegistry } from "../src/usage/types";

const activeTool = {
  tool_key: "asset.export",
  display_name: "Asset Export",
  page: "asset",
  introduced_version: "1.0.0",
  retired_version: null,
  accept_until: null,
  display_state: "active" as const,
  actions: [
    {
      action_key: "export",
      display_name: "Export",
      page: "asset",
      introduced_version: "1.0.0",
      retired_version: null,
      accept_until: null,
      display_state: "active" as const,
    },
  ],
};

function activeRegistry(tools = [activeTool]): ToolRegistry {
  return {
    schema_version: "1.0.0",
    registry_version: "1.0.0",
    registry_status: "active",
    tools,
  };
}

test("runtime registry validation rejects duplicate stable keys", () => {
  const duplicate = activeRegistry([activeTool, { ...activeTool, display_name: "Duplicate" }]);
  const validation = validateRegistryAgainstAuthoritativeSchema(duplicate);
  assert.equal(validation.valid, false);
  if (!validation.valid) assert.match(validation.diagnostic, /duplicate stable key/i);
});

test("bundled registry assertion rejects caller-supplied content even with a matching schema version", () => {
  assert.throws(
    () => assertBundledRegistry(activeRegistry()),
    /bundled|hash|artifact/i,
  );
});

test("bundled registry assertion keeps draft artifacts out of production", () => {
  assert.throws(
    () => assertBundledRegistry({ ...BUNDLED_TOOL_REGISTRY, registry_status: "draft" }),
    /hash|active.*nonempty|production/i,
  );
});
