import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function loadValidators() {
  const schema = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "contracts", "usage-event-schema.json"), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: "x-event-types" });
  ajv.addKeyword({ keyword: "x-usage-counted-event-type" });
  ajv.addKeyword({ keyword: "x-company-timezone" });
  ajv.addKeyword({ keyword: "x-shard-count" });
  ajv.addKeyword({ keyword: "x-max-events-per-shard" });
  ajv.addKeyword({ keyword: "x-max-event-json-bytes" });
  ajv.addKeyword({ keyword: "x-max-shard-json-bytes" });
  ajv.addKeyword({ keyword: "x-max-stack-utf8-bytes" });
  ajv.addKeyword({
    keyword: "x-max-utf8-bytes",
    type: "string",
    schemaType: "number",
    validate: (limit, value) => Buffer.byteLength(value, "utf8") <= limit,
  });
  ajv.addSchema(schema);
  return {
    schema,
    event: ajv.compile({ $ref: `${schema.$id}#/$defs/event` }),
    dailyShard: ajv.compile({ $ref: `${schema.$id}#/$defs/dailyShard` }),
    errorLog: ajv.compile({ $ref: `${schema.$id}#/$defs/errorLog` }),
    pluginUser: ajv.compile({ $ref: `${schema.$id}#/$defs/pluginUser` }),
    portalMember: ajv.compile({ $ref: `${schema.$id}#/$defs/portalMember` }),
  };
}

function event(overrides = {}) {
  return {
    event_id: "evt-01JZ0000000000000000000000",
    operation_id: "op-01JZ0000000000000000000000",
    tool_key: "asset_ref_exporter",
    action_key: "asset_ref_exporter.open",
    event_type: "run_succeeded",
    occurred_at: "2026-07-23T07:00:00.000Z",
    result: "succeeded",
    duration_ms: 250,
    plugin_version: "8.0.0",
    ...overrides,
  };
}

function errorLog(overrides = {}) {
  return {
    event_id: "evt-01JZ0000000000000000000000",
    uid: "firebase-user-1",
    company_date: "2026-07-23",
    tool_key: "asset_ref_exporter",
    action_key: "asset_ref_exporter.open",
    occurred_at: "2026-07-23T07:00:00.000Z",
    error_type: "ue_runtime",
    summary: "Asset processing failed.",
    call_site: "asset.image_exporter.run",
    fingerprint: "9a".repeat(32),
    stack: "RuntimeError: processing failed\\n  at asset_image_exporter.run",
    plugin_version: "8.0.0",
    ...overrides,
  };
}

function pluginUser(overrides = {}) {
  return {
    uid: "firebase-user-1",
    email: "artist@xindong.com",
    display_name: "Artist",
    avatar_url: "https://lh3.googleusercontent.com/avatar",
    last_login_at: "2026-07-23T07:00:00.000Z",
    last_active_at: "2026-07-23T07:00:00.000Z",
    plugin_version: "8.0.0",
    updated_at: "2026-07-23T07:00:00.000Z",
    ...overrides,
  };
}

function portalMember(overrides = {}) {
  return {
    email: "admin@xindong.com",
    role: "admin",
    enabled: true,
    created_at: "2026-07-23T07:00:00.000Z",
    created_by: "firebase-admin",
    updated_at: "2026-07-23T07:00:00.000Z",
    updated_by: "firebase-admin",
    ...overrides,
  };
}

test("accepts every supported event type with its matching result", () => {
  const { event: validate } = loadValidators();
  const pairs = {
    entry_clicked: "started",
    dialog_opened: "started",
    dialog_open_failed: "failed",
    run_rejected: "rejected",
    run_started: "started",
    run_succeeded: "succeeded",
    run_failed: "failed",
    run_cancelled: "cancelled",
    run_interrupted: "interrupted",
    unexpected_exception: "unexpected",
  };
  for (const [event_type, result] of Object.entries(pairs)) {
    const value = event({ event_type, result });
    if (!["run_succeeded", "run_failed", "run_cancelled", "run_interrupted"].includes(value.event_type)) delete value.duration_ms;
    assert.equal(validate(value), true, `${event_type}: ${JSON.stringify(validate.errors)}`);
  }
  assert.equal(validate(event({ event_type: "run_failed", result: "succeeded", duration_ms: 100 })), false);
});

test("rejects unknown tools-shaped fields, missing identity, and unsupported event types", () => {
  const { event: validate } = loadValidators();
  assert.equal(validate(event({ event_type: "button_clicked" })), false);
  for (const field of ["event_id", "operation_id", "tool_key", "action_key", "occurred_at", "result", "plugin_version"]) {
    const value = event();
    delete value[field];
    assert.equal(validate(value), false, `${field} unexpectedly optional`);
  }
  assert.equal(validate(event({ portal_uid: "portal-user" })), false);
});

test("allows duration only on terminal run events and keeps it bounded", () => {
  const { event: validate } = loadValidators();
  for (const event_type of ["run_succeeded", "run_failed", "run_cancelled", "run_interrupted"]) {
    assert.equal(validate(event({ event_type, result: event_type.slice(4), duration_ms: 604800000 })), true);
  }
  for (const duration_ms of [-1, 604800001, 1.5, "250"]) {
    assert.equal(validate(event({ duration_ms })), false, `${duration_ms} unexpectedly valid`);
  }
  assert.equal(validate(event({ event_type: "run_started", result: "started", duration_ms: 1 })), false);
});

test("requires redacted bounded error metadata when an event references an error log", () => {
  const { event: validate } = loadValidators();
  const valid = event({ event_type: "run_failed", result: "failed", error_log_id: "evt-01JZ0000000000000000000000", error_summary: "Asset processing failed." });
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...valid, error_summary: "Traceback marker retained after redaction." }), true, JSON.stringify(validate.errors));
  for (const error_summary of ["C:\\Users\\artist\\scene.uasset", "\\\\server\\share\\scene.uasset", "/tmp", "/a", "foo /tmp", "token=secret", "request body: {\"password\":\"x\"}", "response body: {\"access_token\":\"x\"}", "x".repeat(513)]) {
    assert.equal(validate({ ...valid, error_summary }), false, error_summary);
  }
});

test("enforces the declared 32-shard and event-size limits", () => {
  const { schema } = loadValidators();
  assert.equal(schema["x-company-timezone"], "Asia/Shanghai");
  assert.equal(schema["x-shard-count"], 32);
  assert.equal(schema["x-max-events-per-shard"], 500);
  assert.equal(schema["x-max-event-json-bytes"], 1536);
  assert.equal(schema["x-max-shard-json-bytes"], 917504);
  assert.ok(schema["x-max-events-per-shard"] * schema["x-max-event-json-bytes"] + 65536 < schema["x-max-shard-json-bytes"]);
  assert.ok(schema["x-max-shard-json-bytes"] < 1048576);
});

test("bounds error log stack by UTF-8 bytes and rejects secrets or absolute paths", () => {
  const { errorLog: validate } = loadValidators();
  assert.equal(validate(errorLog()), true, JSON.stringify(validate.errors));
  assert.equal(validate(errorLog({ stack: "Traceback (most recent call last):\\n  File \\\"tool.py\\\", line 42, in run" })), true, JSON.stringify(validate.errors));
  assert.equal(validate(errorLog({ stack: "中".repeat(3000) })), false, "UTF-8 byte limit bypassed");
  for (const stack of [
    "C:\\Users\\artist\\scene.uasset",
    "\\\\server\\share\\scene.uasset",
    "/tmp",
    "/a",
    "foo /tmp",
    "/home/artist/scene.uasset",
    "authorization: Bearer secret-value",
    "Bearer secret-value",
    "refresh_token=secret-value",
    "request body: {\"password\":\"x\"}",
    "response body: {\"access_token\":\"x\"}",
    "artist@example.com",
  ]) {
    assert.equal(validate(errorLog({ stack })), false, stack);
  }
});

test("requires all identity and member fields with separate plugin and portal email boundaries", () => {
  const { pluginUser: validatePluginUser, portalMember: validatePortalMember } = loadValidators();
  assert.equal(validatePluginUser(pluginUser()), true, JSON.stringify(validatePluginUser.errors));
  assert.equal(validatePortalMember(portalMember()), true, JSON.stringify(validatePortalMember.errors));
  for (const field of ["uid", "email", "display_name", "avatar_url", "last_login_at", "last_active_at", "plugin_version", "updated_at"]) {
    const value = pluginUser();
    delete value[field];
    assert.equal(validatePluginUser(value), false, `pluginUsers.${field} unexpectedly optional`);
  }
  for (const field of ["email", "role", "enabled", "created_at", "created_by", "updated_at", "updated_by"]) {
    const value = portalMember();
    delete value[field];
    assert.equal(validatePortalMember(value), false, `portalMembers.${field} unexpectedly optional`);
  }
  assert.equal(validatePluginUser(pluginUser({ email: "artist@example.com" })), false);
  assert.equal(validatePortalMember(portalMember({ email: "snkhtm@gmail.com" })), true);
  assert.equal(validatePortalMember(portalMember({ email: "other@gmail.com" })), false);
  assert.equal(validatePortalMember(portalMember({ email: "Admin@xindong.com" })), false);
  assert.equal(validatePortalMember(portalMember({ role: "owner" })), false);
});

test("rejects an oversized event document in the contract validator", () => {
  const { schema, dailyShard } = loadValidators();
  assert.equal(schema["x-max-events-per-shard"], 500);
  const events = Array.from({ length: 501 }, () => event());
  const daily = {
    company_date: "2026-07-23",
    uid: "firebase-user-1",
    tool_key: "asset.image_exporter",
    shard: "07",
    events,
    first_occurred_at: "2026-07-23T07:00:00.000Z",
    last_occurred_at: "2026-07-23T07:00:00.000Z",
    last_result: "succeeded",
    plugin_version: "8.0.0",
  };
  assert.equal(dailyShard(daily), false, "oversized event array unexpectedly valid");
});

test("enforces the per-event UTF-8 JSON budget in the runtime validator", async () => {
  const { validateUsageEvent } = await import(
    pathToFileURL(path.join(repositoryRoot, "scripts", "validate-contracts.mjs")).href,
  );
  const large = event({
    event_id: `e${"a".repeat(127)}`,
    operation_id: `o${"a".repeat(127)}`,
    error_log_id: `e${"a".repeat(127)}`,
    error_summary: "中".repeat(512),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(large), "utf8") > 1536);
  assert.throws(() => validateUsageEvent(large), /UTF-8 JSON bytes/i);
});

test("runtime validator binds tool and action keys to the checked-in registry", async () => {
  const { validateUsageEvent, validateErrorLog } = await import(
    pathToFileURL(path.join(repositoryRoot, "scripts", "validate-contracts.mjs")).href,
  );
  assert.doesNotThrow(() => validateUsageEvent(event()));
  assert.throws(() => validateUsageEvent(event({ tool_key: "missing.tool", action_key: "missing.tool.run" })), /unknown tool key/i);
  assert.throws(() => validateUsageEvent(event({ action_key: "asset_ref_exporter.missing" })), /unknown action key/i);
  assert.doesNotThrow(() => validateErrorLog(errorLog()));
  assert.throws(() => validateErrorLog(errorLog({ action_key: "asset_ref_exporter.missing" })), /unknown action key/i);
});
