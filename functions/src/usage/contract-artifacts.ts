import { createHash } from "node:crypto";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import eventSchema from "../generated/usage-event-schema.json";
import registrySchema from "../generated/tool-registry.schema.json";
import bundledRegistry from "../generated/tool-registry.json";
import artifactManifest from "../generated/contract-artifact-manifest.json";
import type { ClientUsageEvent, ToolRegistry } from "./types";

const { validateToolRegistrySemantics, requireActiveToolRegistry } = require("../generated/tool-registry-semantics.cjs") as {
  validateToolRegistrySemantics(value: ToolRegistry): ToolRegistry;
  requireActiveToolRegistry(value: ToolRegistry): ToolRegistry;
};

const ajv = new Ajv2020({ allErrors: false, strict: true });
addFormats(ajv);
for (const keyword of ["x-event-types", "x-usage-counted-event-type", "x-time-policy", "x-operation-recovery-policy"]) {
  ajv.addKeyword({ keyword, schemaType: ["array", "string", "object"] });
}
const validateEventSchema: ValidateFunction = ajv.compile(eventSchema);
const validateRegistrySchema: ValidateFunction = ajv.compile(registrySchema);

export const SUPPORTED_EVENT_SCHEMA_VERSIONS = new Set(["1.0.0"]);
export const BUNDLED_TOOL_REGISTRY = bundledRegistry as ToolRegistry;
export const BUNDLED_TOOL_REGISTRY_SHA256 = createHash("sha256")
  .update(JSON.stringify(BUNDLED_TOOL_REGISTRY), "utf8")
  .digest("hex");

export function validateEventAgainstAuthoritativeSchema(value: unknown): { valid: true } | { valid: false; diagnostic: string } {
  if (!validateEventSchema(value)) {
    const error = validateEventSchema.errors?.[0];
    return { valid: false, diagnostic: `${error?.instancePath || "event"}:${error?.keyword || "schema"}`.slice(0, 160) };
  }
  const event = value as { schema_version?: unknown };
  if (typeof event.schema_version !== "string" || !SUPPORTED_EVENT_SCHEMA_VERSIONS.has(event.schema_version)) {
    return { valid: false, diagnostic: "schema_version_unsupported" };
  }
  return { valid: true };
}

export function validateRegistryAgainstAuthoritativeSchema(value: unknown): { valid: true } | { valid: false; diagnostic: string } {
  if (!validateRegistrySchema(value)) {
    const error = validateRegistrySchema.errors?.[0];
    return { valid: false, diagnostic: `${error?.instancePath || "registry"}:${error?.keyword || "schema"}`.slice(0, 160) };
  }
  try {
    validateToolRegistrySemantics(value as ToolRegistry);
  } catch (error) {
    return { valid: false, diagnostic: String(error instanceof Error ? error.message : error).slice(0, 160) };
  }
  return { valid: true };
}

export function canonicalRegistryHash(value: ToolRegistry): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function canonicalArtifactHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertBundledArtifactManifest(): void {
  if (artifactManifest.event_schema_sha256 !== canonicalArtifactHash(eventSchema) || artifactManifest.event_schema_id !== eventSchema.$id || !SUPPORTED_EVENT_SCHEMA_VERSIONS.has(artifactManifest.event_schema_version)) {
    throw new Error("Bundled event schema differs from artifact manifest");
  }
  if (artifactManifest.registry_schema_sha256 !== canonicalArtifactHash(registrySchema) || artifactManifest.registry_schema_id !== registrySchema.$id) {
    throw new Error("Bundled registry schema differs from artifact manifest");
  }
  if (artifactManifest.registry_schema_version !== BUNDLED_TOOL_REGISTRY.schema_version || artifactManifest.registry_version !== BUNDLED_TOOL_REGISTRY.registry_version || artifactManifest.registry_sha256 !== BUNDLED_TOOL_REGISTRY_SHA256) {
    throw new Error("Bundled tool registry differs from artifact manifest");
  }
}

export function assertBundledRegistry(value: ToolRegistry): ToolRegistry {
  assertBundledArtifactManifest();
  const validation = validateRegistryAgainstAuthoritativeSchema(value);
  if (!validation.valid) throw new Error("Invalid deployed tool registry artifact");
  if (canonicalRegistryHash(value) !== artifactManifest.registry_sha256) throw new Error("Tool registry hash differs from bundled artifact");
  return requireActiveToolRegistry(value);
}

export type { ClientUsageEvent };
