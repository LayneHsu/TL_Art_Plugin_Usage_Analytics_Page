import assert from "node:assert/strict";
import test from "node:test";

import { PluginAuthError } from "../src/plugin-auth/errors";
import { PluginOpsApprovalService } from "../src/plugin-auth/ops-approval-service";
import {
  leaseSigningKeyMetadata,
  pairAndIssueDeviceCredential,
  pkceChallengeFor,
} from "./helpers";

const requester = {
  actorId: "serviceAccount:requester@example.iam.gserviceaccount.com",
  issuer: "https://accounts.google.com",
  subject: "requester-subject",
  email: "requester@example.iam.gserviceaccount.com",
};
const approver = {
  actorId: "serviceAccount:approver@example.iam.gserviceaccount.com",
  issuer: "https://accounts.google.com",
  subject: "approver-subject",
  email: "approver@example.iam.gserviceaccount.com",
};

test("canonicalizes Google issuer aliases and does not recreate a disabled principal", async () => {
  const first = await pairAndIssueDeviceCredential();
  const ops = new PluginOpsApprovalService({
    store: first.harness.store,
    clock: first.harness.clock,
    random: first.harness.random,
    reviewTtlSeconds: 600,
    leaseSigningKeyMetadata: leaseSigningKeyMetadata(first.harness.lease.configuration),
  });
  const review = await ops.request({
    identity: requester,
    action: "disable_principal",
    targetId: first.issued.pluginPrincipalId,
    parameters: { reason: "employment_ended" },
  });
  await ops.approve({ identity: approver, reviewId: review.reviewId });
  await ops.execute({ identity: requester, reviewId: review.reviewId });

  first.harness.oidc.identity = {
    ...first.harness.oidc.identity,
    issuer: "accounts.google.com",
  };
  const created = await first.harness.pairing.create({
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
    clientVersion: "8.0.0",
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await first.harness.pairing.beginBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-a-2",
    nonce: "browser-nonce-a-2",
    pkceChallenge: pkceChallengeFor("pkce-verifier-a-2"),
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await first.harness.pairing.completeBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-a-2",
    callbackUri: "https://analytics.example/plugin/pair/callback",
    authorizationCode: "google-authorization-code-2",
    pkceVerifier: "pkce-verifier-a-2",
  });
  await assert.rejects(
    first.harness.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
    }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "PAIRING_UNAVAILABLE",
  );
  assert.equal(
    first.harness.store
      .exportForTest()
      .principals.filter(
        (principal) => principal.principalId === first.issued.pluginPrincipalId,
      ).length,
    1,
  );
});

test("refuses a principal pepper key change unless explicit migration mode is enabled", async () => {
  const principalService = (await import("../src/plugin-auth/principal-service")) as Record<
    string,
    unknown
  >;
  const validate = principalService.assertPrincipalPepperConfiguration;
  assert.equal(typeof validate, "function");
  assert.throws(
    () =>
      (validate as (input: unknown) => void)({
        keyId: "v2",
        migrationMode: "disabled",
      }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "INVALID_REQUEST",
  );
  assert.doesNotThrow(() =>
    (validate as (input: unknown) => void)({
      keyId: "v2",
      migrationMode: "explicit",
    }),
  );
});
