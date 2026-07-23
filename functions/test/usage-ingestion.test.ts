import assert from "node:assert/strict";
import test from "node:test";

import { signLeaseToken } from "../src/plugin-auth/crypto";
import { InMemoryPluginAuthStore } from "../src/plugin-auth/in-memory-store";
import { PluginAuthDecisionService } from "../src/plugin-auth/auth-decision";
import type {
  Clock,
  PluginAuthConfiguration,
  PluginDeviceBindingRecord,
  PluginLeaseClaims,
  PluginPrincipalRecord,
  RandomSource,
} from "../src/plugin-auth/types";
import {
  InMemoryUsageStore,
  UsageIngestionService,
} from "../src/usage/ingestion";
import { createUsageIngestionEndpointHandler } from "../src/usage/endpoints";
import { errorFingerprint } from "../src/usage/redaction";
import { InMemoryUsageQuota } from "../src/usage/quota";
import type { RateLimitConfiguration, ToolRegistry, UsageQuota } from "../src/usage/types";

const now = new Date("2026-07-22T04:00:00.000Z");
const clock: Clock = { now: () => new Date(now) };
const random: RandomSource = { bytes: (length) => Buffer.alloc(length, 7) };
const configuration: PluginAuthConfiguration = {
  companyDomain: "xindong.com",
  allowedIssuers: ["https://accounts.google.com"],
  oauthAudience: "client",
  allowedCallbackUris: ["https://analytics.invalid/callback"],
  pairingTtlSeconds: 300,
  pairingPollIntervalSeconds: 2,
  rotationTtlSeconds: 300,
  credentialPepper: "credential-pepper",
  credentialDeliveryKeys: { currentKeyId: "delivery-1", verificationKeys: { "delivery-1": "delivery" } },
  principalKeyPepper: "principal-pepper",
  principalKeyId: "principal-1",
  principalPepperMigrationMode: "disabled",
  leaseIssuer: "tl-art-analytics",
  leaseAudience: "tl-art-tool-usage-ingestion",
  leaseTtlSeconds: 3600,
  leaseClockSkewSeconds: 30,
  leaseSigningKeys: { currentKeyId: "lease-1", verificationKeys: { "lease-1": "lease-secret" } },
};

const registry: ToolRegistry = {
  schema_version: "1.0.0",
  registry_version: "1.0.0",
  registry_status: "active",
  tools: [
    {
      tool_key: "asset.export",
      display_name: "Asset Export",
      page: "asset",
      introduced_version: "1.0.0",
      retired_version: null,
      accept_until: null,
      display_state: "active",
      actions: [
        {
          action_key: "export",
          display_name: "Export",
          page: "asset",
          introduced_version: "1.0.0",
          retired_version: null,
          accept_until: null,
          display_state: "active",
        },
      ],
    },
  ],
};

function principal(): PluginPrincipalRecord {
  return {
    principalId: "principal-a",
    issuer: "https://accounts.google.com",
    subject: "subject-a",
    email: "artist@xindong.com",
    displayName: "Artist",
    avatarUrl: null,
    enabled: true,
    createdAt: new Date(now),
    profileUpdatedAt: new Date(now),
    disabledAt: null,
    disabledReason: null,
  };
}

function binding(): PluginDeviceBindingRecord {
  return {
    bindingId: "binding-a",
    pluginPrincipalId: "principal-a",
    deviceIdDigest: "device-digest",
    credentialDigest: "credential-digest",
    credentialVersion: 1,
    clientVersion: "1.0.0",
    createdAt: new Date(now),
    lastVerifiedAt: new Date(now),
    revokedAt: null,
    revocationReason: null,
    pendingRotation: null,
    lastConfirmedRotation: null,
  };
}

function leaseToken(): string {
  const claims: PluginLeaseClaims = {
    version: 1,
    issuer: configuration.leaseIssuer,
    audience: configuration.leaseAudience,
    keyId: "lease-1",
    jti: "lease-a",
    issuedAtSeconds: Math.floor(now.getTime() / 1000),
    expiresAtSeconds: Math.floor(now.getTime() / 1000) + 3600,
    bindingId: "binding-a",
    pluginPrincipalId: "principal-a",
  };
  return signLeaseToken(claims, "lease-secret");
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0.0",
    registry_version: "1.0.0",
    event_id: "evt-a",
    binding_id: "binding-a",
    tool_key: "asset.export",
    action_key: "export",
    event_type: "run_started",
    client_observed_at: "2026-07-22T04:00:00.000Z",
    plugin_version: "1.0.0",
    ue_version: "4.26",
    ui_version: "1.0.0",
    process_instance_id: "process-a",
    session_id: "session-a",
    operation_id: "operation-a",
    ...overrides,
  };
}

async function service(options: {
  registryOverride?: ToolRegistry;
  allowDraftForTests?: boolean;
  quota?: UsageQuota;
  rateLimit?: RateLimitConfiguration;
} = {}) {
  const authStore = new InMemoryPluginAuthStore();
  await authStore.runTransaction(async (tx) => {
    await tx.putPrincipal(principal());
    await tx.putBinding(binding());
  });
  const auth = new PluginAuthDecisionService({ store: authStore, configuration, clock, random });
  const usageStore = new InMemoryUsageStore();
  const ingestion = new UsageIngestionService({
    auth,
    store: usageStore,
    clock,
    registry: options.registryOverride ?? registry,
    allowDraftForTests: options.allowDraftForTests,
    quota: options.quota,
    rateLimit: options.rateLimit,
  });
  return { ingestion, usageStore, authStore };
}

test("only lease-derived identity is accepted and portal identity fields are rejected", async () => {
  const { ingestion } = await service();
  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ plugin_principal_id: "forged", portal_uid: "portal-user" })],
  });
  assert.equal(result.results[0].status, "permanent_rejected");
  assert.match(result.results[0].code ?? "", /schema_invalid|unknown_field|identity/i);
});

test("draft registry disables production ingestion but fixtures can explicitly opt in", async () => {
  const draft = { ...registry, registry_status: "draft" as const };
  const blocked = await service({ registryOverride: draft });
  const blockedResult = await blocked.ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event()],
  });
  assert.equal(blockedResult.results[0].code, "registry_not_active");
  const fixture = await service({ registryOverride: draft, allowDraftForTests: true });
  const fixtureResult = await fixture.ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event()],
  });
  assert.equal(fixtureResult.results[0].status, "confirmed");
});

test("duplicate and out-of-order events atomically update aggregates once", async () => {
  const { ingestion, usageStore } = await service();
  const first = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event(), event({ event_id: "evt-terminal", event_type: "run_succeeded", duration_ms: 120 })],
  });
  const retry = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event(), event({ event_id: "evt-terminal", event_type: "run_succeeded", duration_ms: 120 })],
  });
  assert.deepEqual(first.results.map((item) => item.status), ["confirmed", "confirmed"]);
  assert.deepEqual(retry.results.map((item) => item.status), ["confirmed", "confirmed"]);
  const aggregate = usageStore.exportForTest().daily[0];
  assert.equal(aggregate.run_started, 1);
  assert.equal(aggregate.run_succeeded, 1);
  assert.equal(aggregate.duration_total_ms, 120);
});

test("aggregates retain observed time, receive time, correction state and affected versions", async () => {
  const summary = "Safe failure";
  const callSite = "asset_exporter.run";
  const fingerprint = errorFingerprint("internal", summary, callSite);
  const { ingestion, usageStore } = await service();
  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [
      event({
        event_id: "evt-observed-time",
        operation_id: "operation-observed-time",
        event_type: "dialog_open_failed",
        client_observed_at: "2026-07-16T04:00:00.000Z",
        plugin_version: "1.2.0",
        error: { error_category: "internal", summary, call_site: callSite, fingerprint },
      }),
      event({
        event_id: "evt-corrected-time",
        operation_id: "operation-corrected-time",
        event_type: "dialog_open_failed",
        client_observed_at: "2026-07-14T04:00:00.000Z",
        plugin_version: "1.3.0",
        error: { error_category: "internal", summary, call_site: callSite, fingerprint },
      }),
    ],
  });

  assert.deepEqual(result.results.map((item) => item.status), ["confirmed", "confirmed"]);
  const output = usageStore.exportForTest();
  const observedDaily = output.daily.find((aggregate) => aggregate.date === "2026-07-16");
  const correctedDaily = output.daily.find((aggregate) => aggregate.date === "2026-07-22");
  assert.equal(observedDaily?.last_observed_at, "2026-07-16T04:00:00.000Z");
  assert.equal(observedDaily?.last_received_at, now.toISOString());
  assert.equal(observedDaily?.time_corrected_count, 0);
  assert.equal(correctedDaily?.last_observed_at, now.toISOString());
  assert.equal(correctedDaily?.time_corrected_count, 1);
  assert.deepEqual(output.errors.map((aggregate) => ({
    date: aggregate.date,
    first_seen_at: aggregate.first_seen_at,
    first_received_at: aggregate.first_received_at,
    time_corrected_count: aggregate.time_corrected_count,
    affected_versions: aggregate.affected_versions,
    principal_ids: aggregate.principal_ids,
  })).sort((left, right) => left.date.localeCompare(right.date)), [
    { date: "2026-07-16", first_seen_at: "2026-07-16T04:00:00.000Z", first_received_at: now.toISOString(), time_corrected_count: 0, affected_versions: ["1.2.0"], principal_ids: ["principal-a"] },
    { date: "2026-07-22", first_seen_at: now.toISOString(), first_received_at: now.toISOString(), time_corrected_count: 1, affected_versions: ["1.3.0"], principal_ids: ["principal-a"] },
  ]);
});

test("error aggregates isolate counts, timestamps, principals and summaries by plugin version", async () => {
  const callSite = "asset_exporter.run";
  const fingerprint = errorFingerprint("internal", "Safe failure", callSite);
  const { ingestion, usageStore } = await service();
  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [
      event({
        event_id: "evt-version-1",
        operation_id: "operation-version-1",
        event_type: "dialog_open_failed",
        client_observed_at: "2026-07-22T03:58:00.000Z",
        plugin_version: "1.2.0",
        error: { error_category: "internal", summary: "Safe failure", call_site: callSite, fingerprint },
      }),
      event({
        event_id: "evt-version-2",
        operation_id: "operation-version-2",
        event_type: "dialog_open_failed",
        client_observed_at: "2026-07-22T03:59:00.000Z",
        plugin_version: "1.3.0",
        error: { error_category: "internal", summary: "Safe failure", call_site: callSite, fingerprint },
      }),
    ],
  });

  assert.deepEqual(result.results.map((item) => item.status), ["confirmed", "confirmed"]);
  assert.deepEqual(usageStore.exportForTest().errors.map((aggregate) => ({
    plugin_version: (aggregate as typeof aggregate & { plugin_version?: string }).plugin_version,
    count: aggregate.count,
    first_seen_at: aggregate.first_seen_at,
    recent_seen_at: aggregate.recent_seen_at,
    affected_versions: aggregate.affected_versions,
    principal_ids: aggregate.principal_ids,
    summaries: aggregate.summaries,
  })).sort((left, right) => String(left.plugin_version).localeCompare(String(right.plugin_version))), [
    { plugin_version: "1.2.0", count: 1, first_seen_at: "2026-07-22T03:58:00.000Z", recent_seen_at: "2026-07-22T03:58:00.000Z", affected_versions: ["1.2.0"], principal_ids: ["principal-a"], summaries: [{ summary: "Safe failure", count: 1 }] },
    { plugin_version: "1.3.0", count: 1, first_seen_at: "2026-07-22T03:59:00.000Z", recent_seen_at: "2026-07-22T03:59:00.000Z", affected_versions: ["1.3.0"], principal_ids: ["principal-a"], summaries: [{ summary: "Safe failure", count: 1 }] },
  ]);
});

test("an exact duplicate retry bypasses quota and rate-limit consumption", async () => {
  const quota = new InMemoryUsageQuota({ eventsPerMinute: 1, requestsPerMinute: 1 });
  const { ingestion } = await service({ quota, rateLimit: { capacity: 1, refillPerSecond: 0 } });
  const request = {
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-lost-response" })],
  };
  assert.equal((await ingestion.ingestBatch(request)).results[0].status, "confirmed");
  const retry = await ingestion.ingestBatch(request);
  assert.equal(retry.results[0].status, "confirmed");
  assert.equal(retry.results[0].code, "duplicate");
});

test("duplicate bypass is evaluated per payload when a batch reuses one event ID", async () => {
  const consumed: number[] = [];
  const quota: UsageQuota = {
    async consume(input) {
      consumed.push(input.eventCount);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
  const { ingestion } = await service({ quota });
  await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-mixed-retry" })],
  });
  const mixed = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [
      event({ event_id: "evt-mixed-retry", operation_id: "conflicting-operation" }),
      event({ event_id: "evt-mixed-retry" }),
    ],
  });
  assert.deepEqual(consumed, [1, 1]);
  assert.equal(mixed.results[0].code, "event_id_conflict");
  assert.equal(mixed.results[1].code, "duplicate");
});

test("one invalid event is quarantined without poisoning valid siblings and sensitive data is absent", async () => {
  const { ingestion, usageStore } = await service();
  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [
      event({ event_id: "evt-good" }),
      event({ event_id: "evt-bad", summary: "C:\\Users\\artist\\token=secret", "password=secret": "leak" }),
    ],
  });
  assert.deepEqual(result.results.map((item) => item.status), ["confirmed", "permanent_rejected"]);
  const output = JSON.stringify(usageStore.exportForTest());
  assert.doesNotMatch(output, /C:\\Users|token=secret|secret/);
});

test("revoked and expired leases fail before accepting queued events", async () => {
  const { ingestion, authStore } = await service();
  await authStore.runTransaction(async (tx) => {
    const current = await tx.getBinding("binding-a");
    assert.ok(current);
    current.revokedAt = new Date(now);
    current.revocationReason = "test";
    await tx.putBinding(current);
  });
  await assert.rejects(
    ingestion.ingestBatch({ queue_binding_id: "binding-a", lease_token: leaseToken(), events: [event()] }),
    /authorization|failed|revoked/i,
  );
});

test("rate limits return retryable overload and dead letters remain bounded", async () => {
  const { ingestion } = await service();
  const limited = new UsageIngestionService({
    auth: ingestion.auth,
    store: ingestion.store,
    clock,
    registry,
    rateLimit: { capacity: 1, refillPerSecond: 0 },
  });
  const first = await limited.ingestBatch({ queue_binding_id: "binding-a", lease_token: leaseToken(), events: [event()] });
  assert.equal(first.results[0].status, "confirmed");
  const second = await limited.ingestBatch({ queue_binding_id: "binding-a", lease_token: leaseToken(), events: [event({ event_id: "evt-second" })] });
  assert.equal(second.results[0].status, "retryable");
  assert.equal(second.results[0].code, "rate_limited");
});

test("portal bearer sessions cannot call the plugin event endpoint", async () => {
  const { ingestion } = await service();
  const handler = createUsageIngestionEndpointHandler(ingestion);
  let status = 0;
  let body: unknown;
  await handler(
    {
      method: "POST",
      protocol: "https",
      headers: { authorization: "Bearer portal-firebase-token" },
      rawBody: Buffer.from("{}"),
      body: { queue_binding_id: "binding-a", lease_token: leaseToken(), events: [event()] },
      get: (name: string) => name.toLowerCase() === "authorization" ? "Bearer portal-firebase-token" : undefined,
      is: (name: string) => name === "application/json",
    } as never,
    { status: (value: number) => { status = value; return { json: (result: unknown) => { body = result; } }; } } as never,
  );
  assert.equal(status, 401);
  assert.deepEqual(body, { ok: false, error: { code: "AUTH_DOMAIN_MISMATCH", message: "Portal sessions are not accepted by plugin endpoints" } });
});

test("ingestion preserves auth denial status when audit recording fails", async () => {
  const cases: Array<{ code: "BINDING_MISMATCH" | "BINDING_REVOKED" | "PRINCIPAL_DISABLED" | "LEASE_INVALID" | "LEASE_EXPIRED"; status: number }> = [
    { code: "BINDING_MISMATCH", status: 403 },
    { code: "BINDING_REVOKED", status: 403 },
    { code: "PRINCIPAL_DISABLED", status: 403 },
    { code: "LEASE_INVALID", status: 401 },
    { code: "LEASE_EXPIRED", status: 401 },
  ];
  for (const item of cases) {
    const { authStore } = await service();
    if (item.code === "BINDING_REVOKED") {
      await authStore.runTransaction(async (tx) => {
        const current = await tx.getBinding("binding-a");
        assert.ok(current);
        current.revokedAt = new Date(now);
        current.revocationReason = "test";
        await tx.putBinding(current);
      });
    } else if (item.code === "PRINCIPAL_DISABLED") {
      await authStore.runTransaction(async (tx) => {
        const current = await tx.getPrincipal("principal-a");
        assert.ok(current);
        current.enabled = false;
        current.disabledAt = new Date(now);
        current.disabledReason = "test";
        await tx.putPrincipal(current);
      });
    }
    const auditFailingStore = {
      async runTransaction<T>(handler: Parameters<typeof authStore.runTransaction>[0]): Promise<T> {
        return authStore.runTransaction((transaction) => handler({
          ...transaction,
          putAudit: async () => {
            throw new Error("audit store unavailable");
          },
        })) as Promise<T>;
      },
    };
    const auth = new PluginAuthDecisionService({
      store: auditFailingStore,
      configuration,
      clock,
      random,
    } as never);
    const ingestion = new UsageIngestionService({
      auth,
      store: new InMemoryUsageStore(),
      clock,
      registry,
    });
    const handler = createUsageIngestionEndpointHandler(ingestion, {
      recordAuthFailure: async () => {
        throw new Error("audit store unavailable");
      },
    });
    const token = item.code === "LEASE_INVALID"
      ? "malformed-lease-token"
      : item.code === "LEASE_EXPIRED"
        ? signLeaseToken({
            version: 1,
            issuer: configuration.leaseIssuer,
            audience: configuration.leaseAudience,
            keyId: "lease-1",
            jti: "lease-expired",
            issuedAtSeconds: Math.floor(now.getTime() / 1000) - 100,
            expiresAtSeconds: Math.floor(now.getTime() / 1000) - 1,
            bindingId: "binding-a",
            pluginPrincipalId: "principal-a",
          }, "lease-secret")
        : leaseToken();
    const queueBindingId = item.code === "BINDING_MISMATCH" ? "binding-other" : "binding-a";
    let status = 0;
    let body: unknown;
    await handler(
      {
        method: "POST",
        protocol: "https",
        headers: {},
        rawBody: Buffer.from("{}"),
        body: { queue_binding_id: queueBindingId, lease_token: token, events: [event()] },
        get: () => undefined,
        is: (name: string) => name === "application/json",
      } as never,
      {
        status(value: number) { status = value; return this; },
        json(result: unknown) { body = result; return this; },
      } as never,
    );
    assert.equal(status, item.status, item.code);
    assert.deepEqual(body, {
      ok: false,
      error: {
        code: item.code,
        message: item.code === "BINDING_MISMATCH"
          ? "Plugin lease does not authorize this queue binding"
          : item.code === "LEASE_EXPIRED"
            ? "Plugin lease has expired"
            : item.code === "LEASE_INVALID"
              ? "Plugin lease is invalid"
            : "Plugin authorization failed",
      },
    });
  }
});

test("authoritative schema rejects unsupported versions and traceback text without persisting it", async () => {
  const { ingestion, usageStore } = await service();
  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [
      event({ event_id: "evt-version", schema_version: "1.1.0" }),
      event({
        event_id: "evt-traceback",
        event_type: "run_failed",
        error: { error_category: "internal", summary: "Traceback most recent call failed", fingerprint: "a".repeat(64) },
      }),
    ],
  });
  assert.deepEqual(result.results.map((item) => item.status), ["permanent_rejected", "permanent_rejected"]);
  assert.doesNotMatch(JSON.stringify(usageStore.exportForTest()), /Traceback|most recent call/i);
});

test("rejects secret-bearing free-form metadata without breaking controlled versions", async () => {
  const { ingestion, usageStore } = await service();
  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [
      event({ event_id: "evt-secret-ue", operation_id: "operation-secret-ue", ue_version: "token=secret-value" }),
      event({ event_id: "evt-secret-process", operation_id: "operation-secret-process", process_instance_id: "token:secret-value" }),
      event({
        event_id: "evt-safe-versions",
        operation_id: "operation-safe-versions",
        plugin_version: "1.2.3-token-word",
        ui_version: "2.3.4+controlled.build",
        ue_version: "4.26.2-15973114+++UE4+Release-4.26",
      }),
    ],
  });

  assert.deepEqual(
    result.results.map((item) => item.status),
    ["permanent_rejected", "permanent_rejected", "confirmed"],
  );
  assert.doesNotMatch(JSON.stringify(usageStore.exportForTest()), /secret-value/);
});

test("requires a producer fingerprint matching the redacted summary and bounded call site", async () => {
  const fingerprint = (errorFingerprint as unknown as (
    category: string,
    summary: string,
    callSite: string,
  ) => string)("internal", "Failed to load SM_Chair_001", "asset_exporter.run");
  const { ingestion, usageStore } = await service();
  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [
      event({
        event_id: "evt-fingerprint-match",
        event_type: "dialog_open_failed",
        error: {
          error_category: "internal",
          summary: "Failed to load SM_Chair_001",
          call_site: "asset_exporter.run",
          fingerprint,
        },
      }),
      event({
        event_id: "evt-fingerprint-mismatch",
        operation_id: "operation-mismatch",
        event_type: "dialog_open_failed",
        error: {
          error_category: "internal",
          summary: "Failed to load SM_Table_999",
          call_site: "asset_exporter.run",
          fingerprint: "a".repeat(64),
        },
      }),
    ],
  });

  assert.equal(result.results[0].status, "confirmed");
  assert.equal(result.results[1].code, "error_fingerprint_mismatch");
  const storedError = usageStore.exportForTest().events[0]?.error;
  assert.equal(storedError?.fingerprint, fingerprint);
  assert.equal(storedError?.call_site, "asset_exporter.run");
});

test("rejects sensitive summaries even when the producer fingerprint matches", async () => {
  const summaries = [
    "Request failed with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhcnRpc3QtMTIzIn0.invalid_signature_123456",
    "File \"tool.py\", line 42, in run",
  ];
  const { ingestion, usageStore } = await service();
  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: summaries.map((summary, index) => event({
      event_id: `evt-sensitive-summary-${index}`,
      operation_id: `operation-sensitive-summary-${index}`,
      event_type: "run_failed",
      error: {
        error_category: "internal",
        summary,
        call_site: "usage.ingest",
        fingerprint: errorFingerprint("internal", summary, "usage.ingest"),
      },
    })),
  });

  assert.deepEqual(result.results.map((item) => item.status), ["permanent_rejected", "permanent_rejected"]);
  const persisted = JSON.stringify(usageStore.exportForTest());
  assert.doesNotMatch(persisted, /eyJhbGci|tool\.py|line 42/);
});

test("retired tool and action remain ingestible only during their explicit grace window", async () => {
  const grace = {
    ...registry,
    tools: registry.tools.map((tool) => ({
      ...tool,
      display_state: "retired" as const,
      retired_version: "1.0.0",
      accept_until: "2026-07-23T04:00:00.000Z",
      actions: tool.actions.map((action) => ({
        ...action,
        display_state: "retired" as const,
        retired_version: "1.0.0",
        accept_until: "2026-07-23T04:00:00.000Z",
      })),
    })),
  };
  const { ingestion } = await service({ registryOverride: grace });
  const result = await ingestion.ingestBatch({ queue_binding_id: "binding-a", lease_token: leaseToken(), events: [event({ event_id: "evt-grace" })] });
  assert.equal(result.results[0].status, "confirmed");
});

test("operation state counts one matching terminal and rejects a second terminal", async () => {
  const { ingestion, usageStore } = await service();
  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [
      event({ event_id: "evt-op-start", operation_id: "operation-terminal" }),
      event({ event_id: "evt-op-success", operation_id: "operation-terminal", event_type: "run_succeeded", duration_ms: 10 }),
      event({ event_id: "evt-op-failed", operation_id: "operation-terminal", event_type: "run_failed", duration_ms: 20 }),
    ],
  });
  assert.deepEqual(result.results.map((item) => item.status), ["confirmed", "confirmed", "permanent_rejected"]);
  const aggregate = usageStore.exportForTest().daily[0];
  assert.equal(aggregate.run_started, 1);
  assert.equal(aggregate.run_succeeded, 1);
  assert.equal(aggregate.run_failed, 0);
});

test("terminal-first operation remains pending and reconciles exactly once when start arrives", async () => {
  const { ingestion, usageStore } = await service();
  const terminal = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-terminal-first", operation_id: "operation-terminal-first", event_type: "run_succeeded", duration_ms: 25 })],
  });
  assert.equal(terminal.results[0].status, "confirmed");
  assert.equal(terminal.results[0].code, "pending_start");
  assert.equal(usageStore.exportForTest().events.length, 0);
  const started = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-start-after-terminal", operation_id: "operation-terminal-first" })],
  });
  assert.equal(started.results[0].status, "confirmed");
  const output = usageStore.exportForTest();
  assert.equal(output.events.length, 2);
  assert.equal(output.daily[0].run_started, 1);
  assert.equal(output.daily[0].run_succeeded, 1);
  assert.equal(output.daily[0].duration_total_ms, 25);
});

test("terminal-first reserves its event ID until the matching start commits it", async () => {
  const { ingestion, usageStore } = await service();
  const terminalEvent = event({
    event_id: "evt-terminal-reserved",
    operation_id: "operation-terminal-reserved",
    event_type: "run_succeeded",
    duration_ms: 25,
  });
  const pending = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [terminalEvent],
  });
  assert.equal(pending.results[0].code, "pending_start");

  const conflict = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: terminalEvent.event_id, operation_id: "operation-that-must-not-claim-the-id" })],
  });
  assert.equal(conflict.results[0].status, "permanent_rejected");
  assert.equal(conflict.results[0].code, "event_id_conflict");

  const started = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-start-for-reserved-terminal", operation_id: "operation-terminal-reserved" })],
  });
  assert.equal(started.results[0].status, "confirmed");
  assert.deepEqual(
    usageStore.exportForTest().events.map((stored) => stored.event_id).sort(),
    ["evt-start-for-reserved-terminal", "evt-terminal-reserved"],
  );
});

test("terminal-first cross-tool correlation is rejected without counting the terminal", async () => {
  const { ingestion, usageStore } = await service();
  await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-pending-conflict", operation_id: "operation-pending-conflict", event_type: "run_failed" })],
  });
  const conflict = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-pending-conflict-start", operation_id: "operation-pending-conflict", session_id: "different-session" })],
  });
  assert.equal(conflict.results[0].status, "permanent_rejected");
  assert.equal(conflict.results[0].code, "operation_conflict");
  assert.equal(usageStore.exportForTest().daily.length, 0);
});

test("event ID reuse with a different payload is a permanent conflict", async () => {
  const { ingestion, usageStore } = await service();
  await ingestion.ingestBatch({ queue_binding_id: "binding-a", lease_token: leaseToken(), events: [event({ event_id: "evt-reused" })] });
  const conflict = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-reused", operation_id: "different-operation" })],
  });
  assert.equal(conflict.results[0].status, "permanent_rejected");
  assert.equal(conflict.results[0].code, "event_id_conflict");
  assert.equal(usageStore.exportForTest().events.length, 1);
});

test("empty ingestion batches are rejected", async () => {
  const { ingestion } = await service();
  await assert.rejects(
    ingestion.ingestBatch({ queue_binding_id: "binding-a", lease_token: leaseToken(), events: [] }),
    /invalid|empty/i,
  );
});

test("invalid retry updates one deterministic bounded dead letter", async () => {
  const { ingestion, usageStore } = await service();
  const request = { queue_binding_id: "binding-a", lease_token: leaseToken(), events: [event({ event_id: "evt-invalid-retry", portal_uid: "portal-a" })] };
  await ingestion.ingestBatch(request);
  await ingestion.ingestBatch(request);
  const output = usageStore.exportForTest();
  assert.equal(output.deadLetters.length, 1);
  assert.equal(output.deadLetters[0].attempts, 2);
  assert.equal("event_id" in output.deadLetters[0], false);
  assert.equal("binding_id" in output.deadLetters[0], false);
  assert.equal("plugin_principal_id" in output.deadLetters[0], false);
});

test("accepted events dual-write active generations and advance the replay source pointer", async () => {
  const { ingestion, usageStore } = await service();
  await usageStore.runTransaction(async (transaction) => {
    await transaction.putAggregatePointer({
      id: "active",
      active_generation: "shadow-1",
      write_generations: ["shadow-1", "online"],
      rollback_generation: "online",
      source_revision: 7,
      source_watermark: {
        corrected_observed_at: "2026-07-22T03:59:00.000Z",
        server_received_at: "2026-07-22T03:59:00.000Z",
        event_id: "evt-before",
      },
      updated_at: "2026-07-22T03:59:00.000Z",
    });
  });

  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-after" })],
  });

  assert.equal(result.results[0].status, "confirmed");
  const output = usageStore.exportForTest();
  assert.deepEqual(
    output.daily.map((aggregate) => aggregate.generation).sort(),
    ["online", "shadow-1"],
  );
  assert.equal(output.pointers[0].source_revision, 8);
  assert.deepEqual(output.pointers[0].source_watermark, {
    corrected_observed_at: "2026-07-22T04:00:00.000Z",
    server_received_at: "2026-07-22T04:00:00.000Z",
    event_id: "evt-after",
  });
  assert.deepEqual(output.sourceRevisions, [{
    date: "2026-07-22",
    revision: 1,
    updated_at: "2026-07-22T04:00:00.000Z",
  }]);
});

test("finalized date partitions route new events only to their selected generation", async () => {
  const { ingestion, usageStore } = await service();
  await usageStore.runTransaction(async (transaction) => {
    await transaction.putAggregatePointer({
      id: "active",
      active_generation: "online",
      write_generations: ["online", "shadow-partition"],
      rollback_generation: null,
      source_revision: 0,
      source_watermark: null,
      generation_partitions: [{
        from: "2026-07-21T16:00:00.000Z",
        to: "2026-07-22T16:00:00.000Z",
        generation: "shadow-partition",
        rollback_generation: null,
      }],
      updated_at: "2026-07-22T03:59:00.000Z",
    });
  });

  const result = await ingestion.ingestBatch({
    queue_binding_id: "binding-a",
    lease_token: leaseToken(),
    events: [event({ event_id: "evt-partition-finalized" })],
  });

  assert.equal(result.results[0].status, "confirmed");
  assert.deepEqual(usageStore.exportForTest().daily.map((aggregate) => aggregate.generation), ["shadow-partition"]);
});
