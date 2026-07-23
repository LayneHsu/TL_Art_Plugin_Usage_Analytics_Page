import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const require = createRequire(import.meta.url);
const { validateToolRegistrySemantics, validateRegisteredToolAction: validateRegisteredToolActionSemantics } = require("../contracts/tool-registry-semantics.cjs");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const registryPath = path.join(repositoryRoot, "contracts", "tool-registry.json");
const registrySchemaPath = path.join(repositoryRoot, "contracts", "tool-registry.schema.json");
const usageSchemaPath = path.join(repositoryRoot, "contracts", "usage-event-schema.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertEventJsonBudget(value, schema) {
  const limit = schema["x-max-event-json-bytes"];
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > limit) {
    throw new Error(`Usage event exceeds ${limit} UTF-8 JSON bytes (received ${bytes})`);
  }
}

function assertDailyShardBudget(value, schema) {
  const limit = schema["x-max-shard-json-bytes"];
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > limit) {
    throw new Error(`usageDaily shard exceeds ${limit} UTF-8 JSON bytes (received ${bytes})`);
  }
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const keyword of [
    "x-company-timezone",
    "x-shard-count",
    "x-max-events-per-shard",
    "x-max-event-json-bytes",
    "x-max-shard-json-bytes",
    "x-max-stack-utf8-bytes",
    "x-event-types",
    "x-usage-counted-event-type",
  ]) {
    ajv.addKeyword({ keyword });
  }
  ajv.addKeyword({
    keyword: "x-max-utf8-bytes",
    type: "string",
    schemaType: "number",
    validate: (limit, value) => Buffer.byteLength(value, "utf8") <= limit,
  });
  return ajv;
}

export function loadToolRegistry() {
  return readJson(registryPath);
}

export function validateToolRegistry(registry) {
  const ajv = createAjv();
  const validateSchema = ajv.compile(readJson(registrySchemaPath));
  if (!validateSchema(registry)) {
    const details = validateSchema.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid tool registry: ${details}`);
  }
  validateToolRegistrySemantics(registry);
  return registry;
}

export function validateRegisteredToolAction(registry, toolKey, actionKey) {
  return validateRegisteredToolActionSemantics(validateToolRegistry(registry), toolKey, actionKey);
}

export function loadUsageSchema() {
  return readJson(usageSchemaPath);
}

export function validateUsageEvent(value) {
  const schema = loadUsageSchema();
  const ajv = createAjv();
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/event` });
  if (!validate(value)) {
    const details = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid usage event: ${details}`);
  }
  assertEventJsonBudget(value, schema);
  validateRegisteredToolAction(loadToolRegistry(), value.tool_key, value.action_key);
  return value;
}

export function validateUsageDaily(value) {
  const schema = loadUsageSchema();
  const ajv = createAjv();
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/dailyShard` });
  if (!validate(value)) {
    const details = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid usageDaily shard: ${details}`);
  }
  for (const item of value.events) {
    if (item.tool_key !== value.tool_key) {
      throw new Error(`usageDaily event tool_key ${item.tool_key} does not match shard tool_key ${value.tool_key}`);
    }
    validateUsageEvent(item);
    assertEventJsonBudget(item, schema);
  }
  assertDailyShardBudget(value, schema);
  return value;
}

function validateCollectionShape(value, definition, label) {
  const schema = loadUsageSchema();
  const ajv = createAjv();
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
  if (!validate(value)) {
    const details = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid ${label}: ${details}`);
  }
  return value;
}

export function validatePluginUser(value) {
  return validateCollectionShape(value, "pluginUser", "pluginUsers document");
}

export function validatePortalMember(value) {
  return validateCollectionShape(value, "portalMember", "portalMembers document");
}

export function validateErrorLog(value) {
  const schema = loadUsageSchema();
  const ajv = createAjv();
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/errorLog` });
  if (!validate(value)) {
    const details = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid error log: ${details}`);
  }
  validateRegisteredToolAction(loadToolRegistry(), value.tool_key, value.action_key);
  return value;
}

function main(arguments_) {
  const supportedArguments = new Set(["--validate-usage"]);
  const unknownArguments = arguments_.filter((argument) => !supportedArguments.has(argument));
  if (unknownArguments.length > 0) throw new Error(`Unknown argument: ${unknownArguments.join(", ")}`);
  const registry = validateToolRegistry(loadToolRegistry());
  const usageSchema = loadUsageSchema();
  if (arguments_.includes("--validate-usage")) {
    const ajv = createAjv();
    ajv.compile(usageSchema);
  }
  process.stdout.write(`Validated registry ${registry.registry_version} (${registry.tools.length} tools) and Spark data schema.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
