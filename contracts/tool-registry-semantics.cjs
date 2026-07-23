const semver = require("semver");

function validateLifecycle(entry, label) {
  if (entry.display_state === "retired") {
    if (entry.retired_version === null || entry.accept_until === null) {
      throw new Error(`${label}: retired entries require retired_version and accept_until`);
    }
    if (semver.lt(entry.retired_version, entry.introduced_version)) {
      throw new Error(`${label}: retired_version precedes introduced_version`);
    }
    return;
  }
  if (entry.retired_version !== null || entry.accept_until !== null) {
    throw new Error(`${label}: ${entry.display_state} entries must not set retired_version or accept_until`);
  }
}

function validateToolRegistrySemantics(registry) {
  if (!registry || !Array.isArray(registry.tools) || registry.tools.length === 0) {
    throw new Error("Tool registry requires at least one tool");
  }
  const toolKeys = new Set();
  const actionKeys = new Set();
  for (const tool of registry.tools) {
    if (toolKeys.has(tool.tool_key)) throw new Error(`Duplicate stable key: ${tool.tool_key}`);
    toolKeys.add(tool.tool_key);
  }
  for (const tool of registry.tools) {
    validateLifecycle(tool, `tool ${tool.tool_key}`);
    if (tool.actions.length === 0) {
      throw new Error(`Tool ${tool.tool_key} requires at least one action`);
    }
    for (const action of tool.actions) {
      if (toolKeys.has(action.action_key)) throw new Error(`Stable key reused across tool and action: ${action.action_key}`);
      if (actionKeys.has(action.action_key)) throw new Error(`Duplicate stable key: ${action.action_key}`);
      actionKeys.add(action.action_key);
      if (!action.action_key.startsWith(`${tool.tool_key}.`)) {
        throw new Error(`Action ${action.action_key}: action_key must use the parent tool_key prefix`);
      }
      validateLifecycle(action, `action ${action.action_key}`);
      if (semver.lt(action.introduced_version, tool.introduced_version)) {
        throw new Error(`Action ${action.action_key}: introduced_version precedes tool introduced_version`);
      }
      if (tool.display_state === "retired") {
        if (action.display_state !== "retired") throw new Error(`Action ${action.action_key} under a retired tool must be retired`);
        if (semver.gt(action.retired_version, tool.retired_version)) throw new Error(`Action ${action.action_key}: retired_version exceeds tool retired_version`);
        if (new Date(action.accept_until).getTime() > new Date(tool.accept_until).getTime()) {
          throw new Error(`Action ${action.action_key}: accept_until exceeds tool accept_until`);
        }
      }
    }
  }
  return registry;
}

function validateRegisteredToolAction(registry, toolKey, actionKey) {
  validateToolRegistrySemantics(registry);
  const tool = registry.tools.find((entry) => entry.tool_key === toolKey);
  if (!tool) throw new Error(`Unknown tool key: ${toolKey}`);
  if (!tool.actions.some((entry) => entry.action_key === actionKey)) {
    throw new Error(`Unknown action key for tool ${toolKey}: ${actionKey}`);
  }
  return true;
}

module.exports = { validateToolRegistrySemantics, validateRegisteredToolAction };
