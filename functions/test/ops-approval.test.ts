import assert from "node:assert/strict";
import test from "node:test";

import { PluginAuthError } from "../src/plugin-auth/errors";
import { PluginOpsApprovalService } from "../src/plugin-auth/ops-approval-service";
import type { VerifiedPluginOpsIdentity } from "../src/plugin-auth/types";
import { leaseSigningKeyMetadata, pairAndIssueDeviceCredential } from "./helpers";

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

test("requires separate verified identities for immutable request, approval, and atomic execute", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const ops = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  const requested = await ops.request({
    identity: requester,
    action: "revoke_binding",
    targetId: issued.bindingId,
    parameters: { reason: "lost_device" },
  });
  assert.match(requested.reviewId, /^opsrev_[A-Za-z0-9_-]+$/);

  await assert.rejects(
    ops.approve({ identity: requester, reviewId: requested.reviewId }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "OPS_APPROVAL_REQUIRED",
  );
  await ops.approve({ identity: approver, reviewId: requested.reviewId });
  await ops.execute({ identity: requester, reviewId: requested.reviewId });

  const binding = harness.store
    .exportForTest()
    .bindings.find((item) => item.bindingId === issued.bindingId);
  assert.equal(binding?.revocationReason, "lost_device");
  await assert.rejects(
    ops.execute({ identity: requester, reviewId: requested.reviewId }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "OPS_REVIEW_UNAVAILABLE",
  );
});

test("approval cannot substitute action, target, or parameters", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const ops = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  const requested = await ops.request({
    identity: requester,
    action: "revoke_binding",
    targetId: issued.bindingId,
    parameters: { reason: "lost_device" },
  });
  await ops.approve({ identity: approver, reviewId: requested.reviewId });
  await ops.execute({ identity: approver, reviewId: requested.reviewId });
  const review = harness.store
    .exportForTest()
    .opsReviews.find((item) => item.reviewId === requested.reviewId);
  assert.deepEqual(review?.parameters, { reason: "lost_device" });
  assert.equal(review?.targetId, issued.bindingId);
  assert.equal(review?.status, "executed");
});

test("expired reviews cannot be approved or executed", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const ops = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 60,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  const requested = await ops.request({
    identity: requester,
    action: "revoke_binding",
    targetId: issued.bindingId,
    parameters: { reason: "lost_device" },
  });
  harness.clock.advance(60_001);
  await assert.rejects(
    ops.approve({ identity: approver, reviewId: requested.reviewId }),
    PluginAuthError,
  );
});

test("accepts only stable operation reason codes and never stores credential-like details", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const ops = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  for (const reason of [
    "4/0AbCdEfGhIjKlMnOpQrStUvWxYz",
    "opaque-device-secret-3f9b9b0f3b9f9b0f3b9f9b0f3b9f9b0f",
  ]) {
    await assert.rejects(
      ops.request({
        identity: requester,
        action: "revoke_binding",
        targetId: issued.bindingId,
        parameters: { reason },
      }),
      (error: unknown) =>
        error instanceof PluginAuthError && error.code === "INVALID_REQUEST",
    );
  }
  const requested = await ops.request({
    identity: requester,
    action: "revoke_binding",
    targetId: issued.bindingId,
    parameters: { reason: "lost_device" },
  });
  await ops.approve({ identity: approver, reviewId: requested.reviewId });
  await ops.execute({ identity: requester, reviewId: requested.reviewId });

  const audits = harness.store.exportForTest().audits;
  const serialized = JSON.stringify(audits);
  assert.doesNotMatch(serialized, /4\/0AbCdEfGhIjKlMnOpQrStUvWxYz/);
  assert.doesNotMatch(serialized, /opaque-device-secret/);
  assert.match(serialized, /lost_device/);
});

test("rejects secret-bearing operation targets, key transitions, and review IDs before storage or audit", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const ops = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  const oauthCode = "4/0AbCdEfGhIjKlMnOpQrStUvWxYz";
  const deviceSecret = `${issued.deviceCredential}-opaque`;
  const invalidRequests = [
    {
      action: "revoke_binding" as const,
      targetId: oauthCode,
      parameters: { reason: "lost_device" },
    },
    {
      action: "disable_principal" as const,
      targetId: deviceSecret,
      parameters: { reason: "employment_ended" },
    },
    {
      action: "record_signing_key_rotation" as const,
      targetId: "lease-signing-keys",
      parameters: {
        previous_key_id: oauthCode,
        current_key_id: "lease-key-2",
      },
    },
    {
      action: "record_signing_key_rotation" as const,
      targetId: "lease-signing-keys",
      parameters: {
        previous_key_id: "lease-key-1",
        current_key_id: "unknown-lease-key",
      },
    },
  ];
  for (const request of invalidRequests) {
    await assert.rejects(
      ops.request({ identity: requester, ...request }),
      (error: unknown) =>
        error instanceof PluginAuthError && error.code === "INVALID_REQUEST",
    );
  }
  for (const reviewId of [oauthCode, deviceSecret]) {
    await assert.rejects(
      ops.approve({ identity: approver, reviewId }),
      (error: unknown) =>
        error instanceof PluginAuthError && error.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      ops.execute({ identity: requester, reviewId }),
      (error: unknown) =>
        error instanceof PluginAuthError && error.code === "INVALID_REQUEST",
    );
  }

  const snapshot = harness.store.exportForTest();
  assert.equal(snapshot.opsReviews.length, 0);
  const serialized = JSON.stringify({
    reviews: snapshot.opsReviews,
    audits: snapshot.audits,
  });
  assert.doesNotMatch(serialized, /4\/0AbCdEfGhIjKlMnOpQrStUvWxYz/);
  assert.doesNotMatch(serialized, new RegExp(issued.deviceCredential));
  assert.doesNotMatch(serialized, /unknown-lease-key/);
});

test("accepts only the configured lease signing key transition", async () => {
  const { harness } = await pairAndIssueDeviceCredential();
  const ops = new PluginOpsApprovalService({
    store: harness.store,
    clock: harness.clock,
    random: harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(harness.lease.configuration),
  });
  const requested = await ops.request({
    identity: requester,
    action: "record_signing_key_rotation",
    targetId: "lease-signing-keys",
    parameters: {
      previous_key_id: "lease-key-1",
      current_key_id: "lease-key-2",
    },
  });
  await ops.approve({ identity: approver, reviewId: requested.reviewId });
  await ops.execute({ identity: requester, reviewId: requested.reviewId });
  const review = harness.store
    .exportForTest()
    .opsReviews.find((item) => item.reviewId === requested.reviewId);
  assert.deepEqual(review?.parameters, {
    previous_key_id: "lease-key-1",
    current_key_id: "lease-key-2",
  });
});
