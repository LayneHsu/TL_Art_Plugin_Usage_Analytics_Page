import assert from "node:assert/strict";
import test from "node:test";

import {
  PluginAuthDecisionService,
  assertLeaseAuthorizesBinding,
} from "../src/plugin-auth/auth-decision";
import { PluginAuthError } from "../src/plugin-auth/errors";
import { signLeaseToken } from "../src/plugin-auth/crypto";
import { PluginOpsApprovalService } from "../src/plugin-auth/ops-approval-service";
import type { PluginOpsAction, VerifiedPluginOpsIdentity } from "../src/plugin-auth/types";
import {
  createHarness,
  leaseSigningKeyMetadata,
  pairAndIssueDeviceCredential,
} from "./helpers";

const requester: VerifiedPluginOpsIdentity = {
  actorId: "serviceAccount:requester@example.iam.gserviceaccount.com",
  issuer: "https://accounts.google.com",
  subject: "requester-subject",
  email: "requester@example.iam.gserviceaccount.com",
};
const approver: VerifiedPluginOpsIdentity = {
  actorId: "serviceAccount:approver@example.iam.gserviceaccount.com",
  issuer: "https://accounts.google.com",
  subject: "approver-subject",
  email: "approver@example.iam.gserviceaccount.com",
};

async function executeOperation(
  harness: ReturnType<typeof createHarness>,
  action: PluginOpsAction,
  targetId: string,
  parameters: Record<string, string>,
): Promise<void> {
  const ops = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  const review = await ops.request({
    identity: requester,
    action,
    targetId,
    parameters,
  });
  await ops.approve({ identity: approver, reviewId: review.reviewId });
  await ops.execute({ identity: requester, reviewId: review.reviewId });
}

test("issues a server-controlled lease for no more than one hour", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const lease = await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  assert.equal(lease.expiresAt.getTime() - lease.issuedAt.getTime(), 3_600_000);
  assert.equal(lease.bindingId, issued.bindingId);
  assert.equal(lease.pluginPrincipalId, issued.pluginPrincipalId);
  assert.equal(lease.email, "artist.b@xd.com");
  assert.equal(lease.display_name, "Artist B");
  assert.equal(lease.avatar_url, "https://images.example/avatar-b.png");
  assert.equal(lease.profile_updated_at, "2026-07-22T02:00:00.000Z");
  assert.equal(lease.keyId, "lease-key-2");
  assert.equal(lease.version, 1);
  assert.ok(lease.jti.length >= 16);

  await harness.store.runTransaction(async (transaction) => {
    const principal = await transaction.getPrincipal(issued.pluginPrincipalId);
    assert.ok(principal);
    principal.displayName = "Artist B Updated";
    principal.profileUpdatedAt = new Date("2026-07-22T02:01:00.000Z");
    await transaction.putPrincipal(principal);
  });
  const refreshedLease = await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  assert.equal(refreshedLease.display_name, "Artist B Updated");
  assert.equal(refreshedLease.profile_updated_at, "2026-07-22T02:01:00.000Z");

  const claims = assertLeaseAuthorizesBinding({
    token: lease.token,
    expectedBindingId: issued.bindingId,
    now: harness.clock.now(),
    configuration: harness.lease.configuration,
  });
  assert.equal(claims.pluginPrincipalId, issued.pluginPrincipalId);
});

test("rejects tampered and expired lease tokens and old-binding queue uploads", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const lease = await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  assert.throws(
    () =>
      assertLeaseAuthorizesBinding({
        token: `${lease.token.slice(0, -1)}x`,
        expectedBindingId: issued.bindingId,
        now: harness.clock.now(),
        configuration: harness.lease.configuration,
      }),
    PluginAuthError,
  );
  assert.throws(
    () =>
      assertLeaseAuthorizesBinding({
        token: lease.token,
        expectedBindingId: "different-binding",
        now: harness.clock.now(),
        configuration: harness.lease.configuration,
      }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "BINDING_MISMATCH",
  );
  harness.clock.advance(3_600_001);
  assert.throws(
    () =>
      assertLeaseAuthorizesBinding({
        token: lease.token,
        expectedBindingId: issued.bindingId,
        now: harness.clock.now(),
        configuration: harness.lease.configuration,
      }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "LEASE_EXPIRED",
  );
});

test("rejects lease tokens whose issued-at is materially in the future", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const nowSeconds = Math.floor(harness.clock.now().getTime() / 1000);
  const futureToken = signLeaseToken(
    {
      version: 1,
      issuer: harness.lease.configuration.leaseIssuer,
      audience: harness.lease.configuration.leaseAudience,
      keyId: "lease-key-2",
      jti: "lease-future-issued-at",
      issuedAtSeconds: nowSeconds + 301,
      expiresAtSeconds: nowSeconds + 3901,
      bindingId: issued.bindingId,
      pluginPrincipalId: issued.pluginPrincipalId,
    },
    harness.lease.configuration.leaseSigningKeys.verificationKeys[
      "lease-key-2"
    ],
  );
  assert.throws(
    () =>
      assertLeaseAuthorizesBinding({
        token: futureToken,
        expectedBindingId: issued.bindingId,
        now: harness.clock.now(),
        configuration: harness.lease.configuration,
      }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "LEASE_INVALID",
  );
});

test("unlink and plugin-domain revocation immediately block renewal", async () => {
  const first = await pairAndIssueDeviceCredential();
  const firstLease = await first.harness.lease.renew({
    bindingId: first.issued.bindingId,
    deviceCredential: first.issued.deviceCredential,
  });
  await first.harness.credentials.unlink({
    bindingId: first.issued.bindingId,
    currentCredential: first.issued.deviceCredential,
  });
  await assert.rejects(
    first.harness.lease.renew({
      bindingId: first.issued.bindingId,
      deviceCredential: first.issued.deviceCredential,
    }),
    PluginAuthError,
  );
  const firstDecisions = new PluginAuthDecisionService({
    store: first.harness.store,
    configuration: first.harness.lease.configuration,
    clock: first.harness.clock,
    random: first.harness.random,
  });
  await assert.rejects(
    firstDecisions.authorizeEvent({
      leaseToken: firstLease.token,
      queueBindingId: first.issued.bindingId,
    }),
    PluginAuthError,
  );

  const second = await pairAndIssueDeviceCredential();
  const secondLease = await second.harness.lease.renew({
    bindingId: second.issued.bindingId,
    deviceCredential: second.issued.deviceCredential,
  });
  await executeOperation(second.harness, "revoke_binding", second.issued.bindingId, {
    reason: "lost_device",
  });
  await assert.rejects(
    second.harness.lease.renew({
      bindingId: second.issued.bindingId,
      deviceCredential: second.issued.deviceCredential,
    }),
    PluginAuthError,
  );
  const secondDecisions = new PluginAuthDecisionService({
    store: second.harness.store,
    configuration: second.harness.lease.configuration,
    clock: second.harness.clock,
    random: second.harness.random,
  });
  await assert.rejects(
    secondDecisions.authorizeEvent({
      leaseToken: secondLease.token,
      queueBindingId: second.issued.bindingId,
    }),
    PluginAuthError,
  );
});

test("audits every event authorization denial without tokens or untrusted queue IDs", async () => {
  const first = await pairAndIssueDeviceCredential();
  const firstLease = await first.harness.lease.renew({
    bindingId: first.issued.bindingId,
    deviceCredential: first.issued.deviceCredential,
  });
  const decisions = new PluginAuthDecisionService({
    store: first.harness.store,
    configuration: first.harness.lease.configuration,
    clock: first.harness.clock,
    random: first.harness.random,
  });
  await assert.rejects(
    decisions.authorizeEvent({
      leaseToken: `${firstLease.token.slice(0, -1)}x`,
      queueBindingId: "pdc_untrusted_queue_value_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    }),
    PluginAuthError,
  );
  await assert.rejects(
    decisions.authorizeEvent({
      leaseToken: firstLease.token,
      queueBindingId: "bind_substituted_queue",
    }),
    PluginAuthError,
  );
  first.harness.clock.advance(3_600_001);
  await assert.rejects(
    decisions.authorizeEvent({
      leaseToken: firstLease.token,
      queueBindingId: first.issued.bindingId,
    }),
    PluginAuthError,
  );

  const missing = await pairAndIssueDeviceCredential();
  const nowSeconds = Math.floor(missing.harness.clock.now().getTime() / 1000);
  const missingToken = signLeaseToken(
    {
      version: 1,
      issuer: missing.harness.lease.configuration.leaseIssuer,
      audience: missing.harness.lease.configuration.leaseAudience,
      keyId: "lease-key-2",
      jti: "lease-missing-binding",
      issuedAtSeconds: nowSeconds,
      expiresAtSeconds: nowSeconds + 3600,
      bindingId: "bind_missing",
      pluginPrincipalId: missing.issued.pluginPrincipalId,
    },
    missing.harness.lease.configuration.leaseSigningKeys.verificationKeys[
      "lease-key-2"
    ],
  );
  const missingDecisions = new PluginAuthDecisionService({
    store: missing.harness.store,
    configuration: missing.harness.lease.configuration,
    clock: missing.harness.clock,
    random: missing.harness.random,
  });
  await assert.rejects(
    missingDecisions.authorizeEvent({
      leaseToken: missingToken,
      queueBindingId: "bind_missing",
    }),
    PluginAuthError,
  );

  const disabled = await pairAndIssueDeviceCredential();
  const disabledLease = await disabled.harness.lease.renew({
    bindingId: disabled.issued.bindingId,
    deviceCredential: disabled.issued.deviceCredential,
  });
  await disabled.harness.store.runTransaction(async (transaction) => {
    const principal = await transaction.getPrincipal(disabled.issued.pluginPrincipalId);
    assert.ok(principal);
    principal.enabled = false;
    await transaction.putPrincipal(principal);
  });
  const disabledDecisions = new PluginAuthDecisionService({
    store: disabled.harness.store,
    configuration: disabled.harness.lease.configuration,
    clock: disabled.harness.clock,
    random: disabled.harness.random,
  });
  await assert.rejects(
    disabledDecisions.authorizeEvent({
      leaseToken: disabledLease.token,
      queueBindingId: disabled.issued.bindingId,
    }),
    PluginAuthError,
  );

  const audits = [
    ...first.harness.store.exportForTest().audits,
    ...missing.harness.store.exportForTest().audits,
    ...disabled.harness.store.exportForTest().audits,
  ].filter((audit) => audit.action === "auth_denied");
  const reasons = new Set(audits.map((audit) => audit.details.reason));
  for (const reason of [
    "event_lease_invalid",
    "event_binding_mismatch",
    "event_lease_expired",
    "event_binding_missing",
    "event_principal_disabled",
  ]) {
    assert.ok(reasons.has(reason), `missing denial reason ${reason}`);
  }
  const serialized = JSON.stringify(audits);
  assert.doesNotMatch(serialized, /pdc_untrusted_queue_value/);
  assert.doesNotMatch(serialized, new RegExp(firstLease.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("preserves the original lease denial when denial audit storage fails", async () => {
  const harness = createHarness();
  const auditFailingStore = {
    async runTransaction<T>(handler: Parameters<typeof harness.store.runTransaction>[0]): Promise<T> {
      return harness.store.runTransaction((transaction) => handler({
        ...transaction,
        putAudit: async () => {
          throw new Error("audit store unavailable");
        },
      }));
    },
  };
  const decisions = new PluginAuthDecisionService({
    store: auditFailingStore,
    configuration: harness.lease.configuration,
    clock: harness.clock,
    random: harness.random,
  });

  let thrown: unknown;
  try {
    await decisions.authorizeEvent({
      leaseToken: "malformed-lease-token",
      queueBindingId: "bind-untrusted",
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof PluginAuthError);
  assert.equal((thrown as PluginAuthError).code, "LEASE_INVALID");
});

test("reports denial audit degradation without allowing the denied request", async () => {
  const harness = createHarness();
  const auditFailingStore = {
    async runTransaction<T>(handler: Parameters<typeof harness.store.runTransaction>[0]): Promise<T> {
      return harness.store.runTransaction((transaction) => handler({
        ...transaction,
        putAudit: async () => {
          throw new Error("audit store unavailable");
        },
      }));
    },
  };
  const failures: string[] = [];
  const decisions = new PluginAuthDecisionService({
    store: auditFailingStore,
    configuration: harness.lease.configuration,
    clock: harness.clock,
    random: harness.random,
    onAuditFailure: async (reason: string) => {
      failures.push(reason);
    },
  } as ConstructorParameters<typeof PluginAuthDecisionService>[0]);

  await assert.rejects(
    decisions.authorizeEvent({ leaseToken: "malformed-lease-token", queueBindingId: "bind-untrusted" }),
    PluginAuthError,
  );
  assert.deepEqual(failures, ["event_lease_invalid"]);
});

test("principal disable requires IAM plugin ops and is independent of portal roles", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const ops = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });

  await assert.rejects(
    ops.request({
      identity: {
        actorId: "portal-admin-uid",
        issuer: "https://accounts.google.com",
        subject: "portal-admin",
        email: "portal-admin@xd.com",
      },
      action: "disable_principal",
      targetId: issued.pluginPrincipalId,
      parameters: { reason: "portal_role_changed" },
    }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "OPS_IDENTITY_REQUIRED",
  );

  await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  await executeOperation(harness, "disable_principal", issued.pluginPrincipalId, {
    reason: "employment_ended",
  });
  await assert.rejects(
    harness.lease.renew({
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    }),
    PluginAuthError,
  );
});

test("signing-key rotation audit uses the IAM plugin ops surface and preserves overlap verification", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const lease = await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  await executeOperation(harness, "record_signing_key_rotation", "lease-signing-keys", {
    previous_key_id: "lease-key-1",
    current_key_id: "lease-key-2",
  });
  assertLeaseAuthorizesBinding({
    token: lease.token,
    expectedBindingId: issued.bindingId,
    now: harness.clock.now(),
    configuration: harness.lease.configuration,
  });
});

test("plugin ops rejects an empty or non-service-account identity", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const ops = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  for (const identity of [
    {
      actorId: "serviceAccount:",
      issuer: "https://accounts.google.com",
      subject: "empty-service-account",
      email: "reviewer@xd.com",
    },
    {
      actorId: "portal-admin-uid",
      issuer: "https://accounts.google.com",
      subject: "portal-admin",
      email: "portal-admin@xd.com",
    },
  ]) {
    await assert.rejects(
      ops.request({
        identity,
        action: "revoke_binding",
        targetId: issued.bindingId,
        parameters: { reason: "lost_device" },
      }),
      (error: unknown) =>
        error instanceof PluginAuthError && error.code === "OPS_IDENTITY_REQUIRED",
    );
  }
});
