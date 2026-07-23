import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");
const schemaPath = path.join(repositoryRoot, "contracts", "usage-event-schema.json");

const eventTypes = [
  "entry_clicked",
  "dialog_opened",
  "dialog_open_failed",
  "run_rejected",
  "run_started",
  "run_succeeded",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "unexpected_exception",
];

function loadValidators() {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: "x-event-types" });
  ajv.addKeyword({ keyword: "x-usage-counted-event-type" });
  ajv.addKeyword({ keyword: "x-time-policy" });
  ajv.addKeyword({ keyword: "x-operation-recovery-policy" });
  ajv.addSchema(schema);
  return {
    schema,
    client: ajv.compile({ $ref: `${schema.$id}#/$defs/clientEvent` }),
    stored: ajv.compile({ $ref: `${schema.$id}#/$defs/storedEvent` }),
  };
}

function clientEvent(overrides = {}) {
  return {
    schema_version: "1.0.0",
    registry_version: "1.0.0",
    event_id: "evt-01JZ0000000000000000000000",
    binding_id: "binding-01JZ000000000000000000",
    tool_key: "asset.image_exporter",
    action_key: "asset.image_exporter.open",
    event_type: "entry_clicked",
    client_observed_at: "2026-07-22T07:00:00.000Z",
    plugin_version: "8.0.0",
    ue_version: "4.26.2",
    ui_version: "8.0.0",
    process_instance_id: "process-01JZ00000000000000000",
    session_id: "session-01JZ00000000000000000",
    operation_id: "operation-01JZ000000000000000",
    ...overrides,
  };
}

function storedEvent(overrides = {}) {
  return {
    ...clientEvent(),
    plugin_principal_id: "principal_9c82d453d751",
    server_received_at: "2026-07-22T07:00:01.000Z",
    time_correction: {
      applied: false,
      corrected_observed_at: "2026-07-22T07:00:00.000Z",
      clock_offset_ms: 1000,
      reason: "within_tolerance",
    },
    ...overrides,
  };
}

function storedEventWithCorrection({ applied, clock_offset_ms, reason }) {
  const value = storedEvent();
  value.time_correction = {
    ...value.time_correction,
    applied,
    corrected_observed_at: applied
      ? value.server_received_at
      : value.client_observed_at,
    clock_offset_ms,
    reason,
  };
  return value;
}

test("accepts every fixed event category", () => {
  const { client } = loadValidators();
  for (const eventType of eventTypes) {
    assert.equal(
      client(clientEvent({ event_type: eventType })),
      true,
      `${eventType}: ${JSON.stringify(client.errors)}`,
    );
  }
});

test("enforces SemVer 2.0 for event version fields", () => {
  const { client } = loadValidators();
  for (const plugin_version of ["8.0.0", "8.0.0-beta.1+build.5"]) {
    assert.equal(
      client(clientEvent({ plugin_version })),
      true,
      `${plugin_version}: ${JSON.stringify(client.errors)}`,
    );
  }
  for (const plugin_version of ["8.0.0-01", "08.0.0"]) {
    assert.equal(
      client(clientEvent({ plugin_version })),
      false,
      `Invalid SemVer unexpectedly passed: ${plugin_version}`,
    );
  }
});

test("declares run_started as the only usage-counting event", () => {
  const { schema } = loadValidators();
  assert.deepEqual(schema["x-event-types"], eventTypes);
  assert.equal(schema["x-usage-counted-event-type"], "run_started");
});

test("requires operation_id for every run lifecycle event", () => {
  const { client } = loadValidators();
  for (const eventType of eventTypes.filter((value) => value.startsWith("run_"))) {
    const value = clientEvent({ event_type: eventType });
    delete value.operation_id;
    assert.equal(client(value), false, `${eventType} unexpectedly passed`);
  }
});

test("keeps portal Firebase identity outside client and stored events", () => {
  const { client, stored } = loadValidators();
  assert.equal(client(clientEvent({ portal_uid: "firebase-user-1" })), false);
  assert.equal(client(clientEvent({ firebase_uid: "firebase-user-1" })), false);
  assert.equal(stored(storedEvent({ portal_uid: "firebase-user-1" })), false);
});

test("requires server-owned principal, receipt time, and clock correction on stored events", () => {
  const { client, stored } = loadValidators();
  assert.equal(stored(storedEvent()), true, JSON.stringify(stored.errors));
  assert.equal(client(storedEvent()), false);

  for (const field of [
    "plugin_principal_id",
    "server_received_at",
    "time_correction",
  ]) {
    const value = storedEvent();
    delete value[field];
    assert.equal(stored(value), false, `${field} unexpectedly optional`);
  }
});

test("accepts only bounded, redacted error details", () => {
  const { client } = loadValidators();
  const redactedError = {
    error_category: "validation",
    summary: "Selected asset did not satisfy the input contract.",
    call_site: "asset_validator.validate_selection",
    fingerprint: "9a".repeat(32),
  };
  assert.equal(
    client(clientEvent({ event_type: "run_failed", error: redactedError })),
    true,
    JSON.stringify(client.errors),
  );

  const rejectedErrors = [
    { ...redactedError, traceback: "Traceback (most recent call last):" },
    { ...redactedError, local_path: "C:\\Users\\artist\\scene.uasset" },
    { ...redactedError, token: "secret-token" },
    { ...redactedError, summary: "x".repeat(513) },
    { ...redactedError, summary: "Traceback (most recent call last): failure" },
    { ...redactedError, summary: "Could not open C:\\Users\\artist\\scene.uasset" },
    { ...redactedError, summary: "Authorization: Bearer abc.def.ghi" },
  ];

  for (const error of rejectedErrors) {
    assert.equal(
      client(clientEvent({ event_type: "run_failed", error })),
      false,
      `Sensitive error unexpectedly passed: ${JSON.stringify(error)}`,
    );
  }
});

test("requires a bounded symbolic call site for error fingerprints", () => {
  const { client } = loadValidators();
  const error = {
    error_category: "validation",
    summary: "Selected asset did not satisfy the input contract.",
    call_site: "asset_validator.validate_selection",
    fingerprint: "9a".repeat(32),
  };
  assert.equal(
    client(clientEvent({ event_type: "run_failed", error })),
    true,
    JSON.stringify(client.errors),
  );
  assert.equal(
    client(clientEvent({ event_type: "run_failed", error: { ...error, call_site: "C:\\Users\\artist\\tool.py:42" } })),
    false,
  );
});

test("rejects secret assignments in free-form UE version metadata", () => {
  const { client } = loadValidators();
  assert.equal(client(clientEvent({ ue_version: "token=secret-value" })), false);
  assert.equal(client(clientEvent({ ue_version: "4.26.2-15973114+++UE4+Release-4.26" })), true, JSON.stringify(client.errors));
});

const sensitiveSummaryCases = [
  ["Unix absolute paths", "Could not open /opt/tl/assets/scene.uasset"],
  ["email addresses", "Contact artist.name@example.com for access"],
  ["refresh tokens", "Request failed: refresh_token=secret-value"],
  ["cookie headers", "Request failed: Cookie: session=secret-value"],
  ["bare JWT credentials", "Request failed with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhcnRpc3QtMTIzIn0.invalid_signature_123456"],
  ["Python stack frames", "File \"tool.py\", line 42, in run"],
];

for (const [label, summary] of sensitiveSummaryCases) {
  test(`rejects ${label} in error summaries`, () => {
    const { client } = loadValidators();
    const error = {
      error_category: "internal",
      summary,
      call_site: "usage.ingest",
      fingerprint: "9a".repeat(32),
    };
    assert.equal(
      client(clientEvent({ event_type: "run_failed", error })),
      false,
      `Sensitive summary unexpectedly passed: ${summary}`,
    );
  });
}

const credentialSummaryCases = [
  ["lowercase authorization headers", "authorization: bearer secret-value"],
  ["mixed-case bearer credentials", "bEaReR secret-value"],
  ["lowercase cookie headers", "cookie: session=secret-value"],
  ["access tokens", "access_token=secret-value"],
  ["refresh tokens", "refresh_token: secret-value"],
  ["ID tokens", "id_token=secret-value"],
  ["generic tokens", "token: secret-value"],
  ["passwords", "password=secret-value"],
  ["passwd values", "passwd: secret-value"],
  ["secret values", "secret=secret-value"],
  ["credential values", "credential: secret-value"],
  ["underscore API keys", "api_key=secret-value"],
  ["hyphen API keys", "api-key: secret-value"],
  ["hyphen access tokens", "access-token=secret-value"],
  ["underscore client secrets", "client_secret=secret-value"],
  ["hyphen client secrets", "CLIENT-SECRET: secret-value"],
  ["camel-case client secrets", "cLiEnTsEcReT=secret-value"],
  ["underscore private keys", "private_key=secret-value"],
  ["hyphen private keys", "PRIVATE-KEY: secret-value"],
  ["camel-case private keys", "pRiVaTeKeY=secret-value"],
  ["camel-case API keys", "aPiKeY: secret-value"],
  ["namespaced OAuth tokens", "oauth_token=secret-value"],
  ["namespaced session tokens", "session_token: secret-value"],
  ["namespaced client secrets", "oauth_client_secret=secret-value"],
  ["namespaced hyphen secrets", "oauth-client-secret=secret-value"],
  ["camel-case namespaced secrets", "oauthClientSecret: secret-value"],
  ["mixed-case namespaced tokens", "OaUtH_ToKeN=secret-value"],
  ["quoted JSON token keys", "{\"access_token\":\"secret-value\"}"],
];

for (const [label, summary] of credentialSummaryCases) {
  test(`rejects ${label} in error summaries`, () => {
    const { client } = loadValidators();
    const error = {
      error_category: "internal",
      summary,
      call_site: "usage.ingest",
      fingerprint: "9a".repeat(32),
    };
    assert.equal(
      client(clientEvent({ event_type: "run_failed", error })),
      false,
      `Credential summary unexpectedly passed: ${summary}`,
    );
  });
}

test("allows credential words without a value marker", () => {
  const { client } = loadValidators();
  for (const summary of [
    "Token refresh failed after identity provider timeout.",
    "OAuth token refresh failed after identity provider timeout.",
    "The access_token field was not returned.",
    "token=\"\"",
  ]) {
    const error = {
      error_category: "internal",
      summary,
      call_site: "usage.ingest",
      fingerprint: "9a".repeat(32),
    };
    assert.equal(
      client(clientEvent({ event_type: "run_failed", error })),
      true,
      `${summary}: ${JSON.stringify(client.errors)}`,
    );
  }
});

const terminalEventTypes = [
  "run_succeeded",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
];

test("accepts bounded duration_ms on terminal client and stored events", () => {
  const { client, stored } = loadValidators();
  for (const [validate, createEvent] of [
    [client, clientEvent],
    [stored, storedEvent],
  ]) {
    for (const eventType of terminalEventTypes) {
      for (const duration_ms of [0, 604800000]) {
        assert.equal(
          validate(createEvent({ event_type: eventType, duration_ms })),
          true,
          `${eventType}/${duration_ms}: ${JSON.stringify(validate.errors)}`,
        );
      }
    }
  }
});

test("rejects invalid duration_ms bounds and types", () => {
  const { client, stored } = loadValidators();
  for (const [validate, createEvent] of [
    [client, clientEvent],
    [stored, storedEvent],
  ]) {
    for (const duration_ms of [-1, 604800001, 1.5, "1000"]) {
      assert.equal(
        validate(createEvent({ event_type: "run_failed", duration_ms })),
        false,
        `Invalid duration unexpectedly passed: ${duration_ms}`,
      );
    }
  }
});

test("rejects duration_ms on nonterminal client and stored events", () => {
  const { client, stored } = loadValidators();
  for (const [validate, createEvent] of [
    [client, clientEvent],
    [stored, storedEvent],
  ]) {
    for (const eventType of eventTypes.filter(
      (value) => !terminalEventTypes.includes(value),
    )) {
      assert.equal(
        validate(createEvent({ event_type: eventType, duration_ms: 10 })),
        false,
        `${eventType} unexpectedly accepted duration_ms`,
      );
    }
  }
});

test("publishes executable time correction and operation recovery constants", () => {
  const { schema, stored } = loadValidators();
  assert.deepEqual(schema["x-time-policy"], {
    company_timezone: "Asia/Shanghai",
    utc_offset_minutes: 480,
    observes_daylight_saving_time: false,
    max_client_behind_ms: 2592000000,
    max_client_ahead_ms: 86400000,
    permanent_rejection_outside_hard_range: true,
    correct_if_client_ahead_over_ms: 600000,
    correct_if_client_behind_over_ms: 604800000,
    correction_target: "server_received_at",
    bucket_time_field: "corrected_observed_at",
  });
  assert.deepEqual(schema["x-operation-recovery-policy"], {
    startup_recovery_event_type: "run_interrupted",
    startup_recovery_requires_persisted_operation: true,
    startup_recovery_requires_missing_terminal: true,
    startup_recovery_idempotency_scope: ["operation_id", "run_interrupted"],
    abandoned_after_ms: 86400000,
    abandoned_is_derived_display_state: true,
    source_event_type_is_immutable: true,
    later_run_interrupted_supersedes_abandoned: true,
  });

  for (const value of [
    storedEventWithCorrection({
      applied: true,
      clock_offset_ms: -86400000,
      reason: "client_clock_ahead",
    }),
    storedEventWithCorrection({
      applied: true,
      clock_offset_ms: 2592000000,
      reason: "client_clock_behind",
    }),
  ]) {
    assert.equal(stored(value), true, JSON.stringify(stored.errors));
  }
  for (const value of [
    storedEventWithCorrection({
      applied: true,
      clock_offset_ms: -86400001,
      reason: "client_clock_ahead",
    }),
    storedEventWithCorrection({
      applied: true,
      clock_offset_ms: 2592000001,
      reason: "client_clock_behind",
    }),
  ]) {
    assert.equal(
      stored(value),
      false,
      `${value.time_correction.clock_offset_ms} unexpectedly passed`,
    );
  }
});

test("enforces reason-specific time correction consistency", () => {
  const { stored } = loadValidators();
  const validCases = [
    { applied: false, clock_offset_ms: -600000, reason: "within_tolerance" },
    { applied: false, clock_offset_ms: 604800000, reason: "within_tolerance" },
    { applied: true, clock_offset_ms: -86400000, reason: "client_clock_ahead" },
    { applied: true, clock_offset_ms: -600001, reason: "client_clock_ahead" },
    { applied: true, clock_offset_ms: 604800001, reason: "client_clock_behind" },
    { applied: true, clock_offset_ms: 2592000000, reason: "client_clock_behind" },
  ];
  for (const correction of validCases) {
    assert.equal(
      stored(storedEventWithCorrection(correction)),
      true,
      `${JSON.stringify(correction)}: ${JSON.stringify(stored.errors)}`,
    );
  }

  const invalidCases = [
    { applied: true, clock_offset_ms: 0, reason: "within_tolerance" },
    { applied: false, clock_offset_ms: -600001, reason: "within_tolerance" },
    { applied: false, clock_offset_ms: 604800001, reason: "within_tolerance" },
    { applied: false, clock_offset_ms: -600001, reason: "client_clock_ahead" },
    { applied: true, clock_offset_ms: -600000, reason: "client_clock_ahead" },
    { applied: false, clock_offset_ms: 604800001, reason: "client_clock_behind" },
    { applied: true, clock_offset_ms: 604800000, reason: "client_clock_behind" },
    { applied: true, clock_offset_ms: 0, reason: "invalid_client_time" },
  ];
  for (const correction of invalidCases) {
    assert.equal(
      stored(storedEventWithCorrection(correction)),
      false,
      `Contradictory correction unexpectedly passed: ${JSON.stringify(correction)}`,
    );
  }
});

test("rejects unknown events and arbitrary top-level fields", () => {
  const { client } = loadValidators();
  assert.equal(client(clientEvent({ event_type: "button_clicked" })), false);
  assert.equal(client(clientEvent({ arbitrary_payload: { any: "value" } })), false);
});
