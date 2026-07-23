import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const target = path.join(repositoryRoot, "functions", "src", "generated");
const libTarget = path.join(repositoryRoot, "functions", "lib", "generated");
fs.mkdirSync(target, { recursive: true });
fs.mkdirSync(libTarget, { recursive: true });
for (const name of ["usage-event-schema.json", "tool-registry.schema.json", "tool-registry.json"]) {
  fs.copyFileSync(path.join(repositoryRoot, "contracts", name), path.join(target, name));
}
fs.copyFileSync(path.join(repositoryRoot, "config", "firebase-runtime-parameters.json"), path.join(target, "firebase-runtime-parameters.json"));

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, "contracts", name), "utf8"));
const hashJson = (value) => crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const eventSchema = readJson("usage-event-schema.json");
const registrySchema = readJson("tool-registry.schema.json");
const registry = readJson("tool-registry.json");
const manifestPath = path.join(target, "contract-artifact-manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify({
  manifest_version: "1.0.0",
  event_schema_sha256: hashJson(eventSchema),
  event_schema_id: eventSchema.$id,
  event_schema_version: "1.0.0",
  registry_schema_sha256: hashJson(registrySchema),
  registry_schema_id: registrySchema.$id,
  registry_schema_version: registry.schema_version,
  registry_version: registry.registry_version,
  registry_sha256: hashJson(registry),
}, null, 2) + "\n", "utf8");

const semanticsSource = path.join(repositoryRoot, "contracts", "tool-registry-semantics.cjs");
fs.copyFileSync(semanticsSource, path.join(target, "tool-registry-semantics.cjs"));
fs.copyFileSync(manifestPath, path.join(libTarget, "contract-artifact-manifest.json"));
fs.copyFileSync(semanticsSource, path.join(libTarget, "tool-registry-semantics.cjs"));
