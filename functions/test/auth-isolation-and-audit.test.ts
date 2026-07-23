import assert from "node:assert/strict";
import test from "node:test";

import { assertPluginEndpointHeaders } from "../src/plugin-auth/http-boundary";
import { createAuditRecord } from "../src/plugin-auth/audit";
import { PluginAuthError } from "../src/plugin-auth/errors";
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

test("plugin endpoints reject portal Firebase bearer sessions", () => {
  assert.throws(
    () =>
      assertPluginEndpointHeaders({
        authorization: "Bearer portal-firebase-id-token",
      }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "AUTH_DOMAIN_MISMATCH",
  );
  assert.doesNotThrow(() => assertPluginEndpointHeaders({}));
});

test("records plugin auth lifecycle and denied decisions without credentials or tokens", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  await assert.rejects(
    harness.lease.renew({
      bindingId: issued.bindingId,
      deviceCredential: `${issued.deviceCredential}tampered`,
    }),
    PluginAuthError,
  );

  await executeOperation(harness, "revoke_binding", issued.bindingId, {
    reason: "lost_device",
  });

  const audits = harness.store.exportForTest().audits;
  const actions = new Set(audits.map((audit) => audit.action));
  for (const action of [
    "pairing_created",
    "pairing_claimed",
    "binding_created",
    "lease_issued",
    "auth_denied",
    "binding_revoked",
  ]) {
    assert.ok(actions.has(action), `missing audit action ${action}`);
  }
  const serialized = JSON.stringify(audits);
  assert.doesNotMatch(serialized, new RegExp(issued.deviceCredential));
  assert.doesNotMatch(serialized, /authorization-code|id-token|bearer/i);
  for (const audit of audits) {
    assert.ok(!Object.hasOwn(audit.details, "credential"));
    assert.ok(!Object.hasOwn(audit.details, "token"));
  }
});

test("plugin binding keeps identity B even when portal account A is present", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const lease = await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  assert.equal(lease.pluginPrincipalId, issued.pluginPrincipalId);
  assert.notEqual(lease.pluginPrincipalId, "portal-firebase-uid-account-a");
  assert.equal(harness.oidc.identity.email, "artist.b@xd.com");
});

test("redacts credential-like values even when an allowed audit field name is used", () => {
  const { clock, random } = createHarness();
  const audit = createAuditRecord({
    clock,
    random,
    action: "auth_denied",
    outcome: "denied",
    details: {
      reason: "operator pasted pdc_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      note: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    },
  });
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, /pdc_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(serialized, /Bearer\s+|eyJhbGci/i);
  assert.match(serialized, /\[REDACTED\]/);
});

test("hardens audit top-level fields against secret-bearing and invalid values", () => {
  const { clock, random } = createHarness();
  const audit = createAuditRecord({
    clock,
    random,
    action: "pdc_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" as never,
    outcome: "Bearer forged-token" as never,
    pluginPrincipalId: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
    bindingId: "pdc_short",
    pairingId: "pps_short",
    actorId: "Bearer forged-token",
    reviewId: "opsrev_valid-but-pdc_short",
    targetId: "pdn_short",
  });
  assert.equal(audit.action, "auth_denied");
  assert.equal(audit.outcome, "denied");
  assert.equal(audit.pluginPrincipalId, null);
  assert.equal(audit.bindingId, null);
  assert.equal(audit.pairingId, null);
  assert.equal(audit.actorId, null);
  assert.equal(audit.reviewId, null);
  assert.equal(audit.targetId, null);
  assert.doesNotMatch(JSON.stringify(audit), /pdc_|pps_|pdn_|Bearer|eyJ/);
});
