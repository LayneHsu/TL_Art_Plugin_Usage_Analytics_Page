import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const require = createRequire(import.meta.url);
const { validateToolRegistrySemantics, requireActiveToolRegistry } = require("../contracts/tool-registry-semantics.cjs");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const registryPath = path.join(repositoryRoot, "contracts", "tool-registry.json");
const registrySchemaPath = path.join(
  repositoryRoot,
  "contracts",
  "tool-registry.schema.json",
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadToolRegistry() {
  return readJson(registryPath);
}

export function validateToolRegistry(registry) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
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

export function isRegistryIngestionEnabled(registry) {
  validateToolRegistry(registry);
  return registry.registry_status === "active";
}

export function requireActiveProductionRegistry(registry) {
  const validated = validateToolRegistry(registry);
  return requireActiveToolRegistry(validated);
}

export function isRegistryEntryAccepted(entry, observedAt = new Date()) {
  if (entry.display_state !== "retired") {
    return true;
  }
  if (!entry.accept_until) {
    return false;
  }
  return observedAt.getTime() <= new Date(entry.accept_until).getTime();
}

function main(arguments_) {
  const supportedArguments = new Set(["--require-active"]);
  const unknownArguments = arguments_.filter(
    (argument) => !supportedArguments.has(argument),
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments.join(", ")}`);
  }

  const registry = arguments_.includes("--require-active")
    ? requireActiveProductionRegistry(loadToolRegistry())
    : validateToolRegistry(loadToolRegistry());
  process.stdout.write(
    `Validated registry ${registry.registry_version} (${registry.tools.length} tools).\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
