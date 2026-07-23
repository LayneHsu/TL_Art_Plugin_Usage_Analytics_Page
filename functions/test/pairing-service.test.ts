import assert from "node:assert/strict";
import test from "node:test";

import { PluginAuthDecisionService } from "../src/plugin-auth/auth-decision";
import { PluginAuthError } from "../src/plugin-auth/errors";
import {
  createHarness,
  pairAndIssueDeviceCredential,
  pkceChallengeFor,
} from "./helpers";

test("binds a one-time pairing to browser OAuth state and the initiating device", async () => {
  const harness = createHarness();
  const created = await harness.pairing.create({
    deviceId: "device-a",
    deviceChallenge: "challenge-a",
    clientVersion: "8.0.0",
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });

  await harness.pairing.beginBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-a",
    nonce: "browser-nonce-a",
    pkceChallenge: pkceChallengeFor("verifier-a"),
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await harness.pairing.completeBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-a",
    callbackUri: "https://analytics.example/plugin/pair/callback",
    authorizationCode: "authorization-code-a",
    pkceVerifier: "verifier-a",
  });

  await assert.rejects(
    harness.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-b",
      deviceChallenge: "challenge-b",
    }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "PAIRING_UNAVAILABLE",
  );

  const result = await harness.pairing.poll({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "challenge-a",
  });
  assert.equal(result.status, "completed");
  assert.match(result.deviceCredential, /^pdc_[A-Za-z0-9_-]{32,}$/);
  assert.equal(harness.oidc.requests[0]?.expectedNonce, "browser-nonce-a");
  assert.equal(
    harness.oidc.requests[0]?.callbackUri,
    "https://analytics.example/plugin/pair/callback",
  );
});

test("creates one binding and never stores plaintext device credentials", async () => {
  const { harness, created, issued } = await pairAndIssueDeviceCredential();

  const replay = await harness.pairing.poll({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
  });
  assert.equal(replay.status, "completed");
  assert.equal(replay.bindingId, issued.bindingId);
  assert.equal(replay.deviceCredential, issued.deviceCredential);

  const snapshot = harness.store.exportForTest();
  assert.equal(snapshot.bindings.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(issued.deviceCredential));
  assert.equal(snapshot.bindings[0]?.credentialDigest.length, 64);
});

test("returns only the declared completed pairing response fields", async () => {
  const { issued } = await pairAndIssueDeviceCredential();
  assert.deepEqual(Object.keys(issued).sort(), [
    "avatar_url",
    "bindingId",
    "deviceCredential",
    "display_name",
    "email",
    "pluginPrincipalId",
    "profile_updated_at",
    "status",
  ]);
  assert.equal(Object.hasOwn(issued, "kind"), false);
});

test("pairing response and response-loss replay expose the latest server principal profile", async () => {
  const { harness, created, issued } = await pairAndIssueDeviceCredential();
  assert.equal(issued.email, "artist.b@xd.com");
  assert.equal(issued.display_name, "Artist B");
  assert.equal(issued.avatar_url, "https://images.example/avatar-b.png");
  assert.equal(issued.profile_updated_at, "2026-07-22T02:00:00.000Z");

  const refreshedAt = new Date("2026-07-22T02:01:00.000Z");
  await harness.store.runTransaction(async (transaction) => {
    const principal = await transaction.getPrincipal(issued.pluginPrincipalId);
    assert.ok(principal);
    principal.displayName = "Artist B Updated";
    principal.avatarUrl = "http://attacker.example/avatar.png";
    principal.profileUpdatedAt = refreshedAt;
    await transaction.putPrincipal(principal);
  });

  const replay = await harness.pairing.poll({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
  });
  assert.equal(replay.status, "completed");
  assert.equal(replay.email, "artist.b@xd.com");
  assert.equal(replay.display_name, "Artist B Updated");
  assert.equal(replay.avatar_url, null);
  assert.equal(replay.profile_updated_at, refreshedAt.toISOString());
});

test("consumed pairing does not disclose profile data after principal disable", async () => {
  const { harness, created, issued } = await pairAndIssueDeviceCredential();
  await harness.store.runTransaction(async (transaction) => {
    const principal = await transaction.getPrincipal(issued.pluginPrincipalId);
    assert.ok(principal);
    principal.enabled = false;
    principal.disabledAt = harness.clock.now();
    principal.disabledReason = "account_disabled";
    await transaction.putPrincipal(principal);
  });

  await assert.rejects(
    harness.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
    }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "PAIRING_UNAVAILABLE",
  );
});

test("missing or untrusted OIDC profile values are returned as null", async () => {
  const harness = createHarness();
  harness.oidc.identity = {
    ...harness.oidc.identity,
    displayName: "   ",
    avatarUrl: "http://images.example/avatar.png",
  };
  const { issued } = await pairAndIssueDeviceCredential(harness);
  assert.equal(issued.email, "artist.b@xd.com");
  assert.equal(issued.display_name, null);
  assert.equal(issued.avatar_url, null);
  assert.equal(issued.profile_updated_at, "2026-07-22T02:00:00.000Z");
});

test("expires, cancels, and rate limits pairings with one generic response", async () => {
  const harness = createHarness();
  const created = await harness.pairing.create({
    deviceId: "device-a",
    deviceChallenge: "challenge-a",
    clientVersion: "8.0.0",
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  const pending = await harness.pairing.poll({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "challenge-a",
  });
  assert.equal(pending.status, "pending");
  await assert.rejects(
    harness.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "challenge-a",
    }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "POLL_RATE_LIMITED",
  );

  await harness.pairing.cancel({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "challenge-a",
  });
  await assert.rejects(
    harness.pairing.beginBrowserClaim({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      state: "browser-state-a",
      nonce: "browser-nonce-a",
      pkceChallenge: pkceChallengeFor("verifier-a"),
      callbackUri: "https://analytics.example/plugin/pair/callback",
    }),
    (error: unknown) =>
      error instanceof PluginAuthError &&
      error.publicMessage === "Pairing request unavailable",
  );

  const expired = await harness.pairing.create({
    deviceId: "device-c",
    deviceChallenge: "challenge-c",
    clientVersion: "8.0.0",
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  harness.clock.advance(301_000);
  await assert.rejects(
    harness.pairing.beginBrowserClaim({
      pairingId: expired.pairingId,
      pairingSecret: expired.pairingSecret,
      state: "browser-state-c",
      nonce: "browser-nonce-c",
      pkceChallenge: pkceChallengeFor("verifier-c"),
      callbackUri: "https://analytics.example/plugin/pair/callback",
    }),
    (error: unknown) =>
      error instanceof PluginAuthError &&
      error.publicMessage === "Pairing request unavailable",
  );
});

test("rejects callback substitution, state replay, and failed identity verification without a partial binding", async () => {
  const harness = createHarness();
  const created = await harness.pairing.create({
    deviceId: "device-a",
    deviceChallenge: "challenge-a",
    clientVersion: "8.0.0",
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await harness.pairing.beginBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-a",
    nonce: "browser-nonce-a",
    pkceChallenge: pkceChallengeFor("verifier-a"),
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });

  await assert.rejects(
    harness.pairing.completeBrowserClaim({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      state: "browser-state-a",
      callbackUri: "https://attacker.example/callback",
      authorizationCode: "authorization-code-a",
      pkceVerifier: "verifier-a",
    }),
    PluginAuthError,
  );
  assert.equal(harness.store.exportForTest().bindings.length, 0);

  await assert.rejects(
    harness.pairing.completeBrowserClaim({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      state: "browser-state-a",
      callbackUri: "https://analytics.example/plugin/pair/callback",
      authorizationCode: "authorization-code-a",
      pkceVerifier: "verifier-a",
    }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "PAIRING_UNAVAILABLE",
  );
  assert.equal(harness.store.exportForTest().bindings.length, 0);
});

test("creates immutable issuer-subject principals without portal roles", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const principal = harness.store.exportForTest().principals[0];
  assert.equal(principal?.principalId, issued.pluginPrincipalId);
  assert.equal(principal?.issuer, "https://accounts.google.com");
  assert.equal(principal?.subject, "google-subject-b");
  assert.equal(principal?.email, "artist.b@xd.com");
  assert.equal(principal?.enabled, true);
  assert.ok(!Object.hasOwn(principal ?? {}, "role"));
  assert.doesNotMatch(JSON.stringify(harness.store.exportForTest()), /portalUsers|visitor|admin/);
});

test("browser cancellation invalidates its one-time OAuth claim without a device secret", async () => {
  const harness = createHarness();
  const created = await harness.pairing.create({
    deviceId: "device-a",
    deviceChallenge: "challenge-a",
    clientVersion: "8.0.0",
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await harness.pairing.beginBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-a",
    nonce: "browser-nonce-a",
    pkceChallenge: pkceChallengeFor("verifier-a"),
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await harness.pairing.cancelBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
  });
  await harness.pairing.cancelBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
  });
  await assert.rejects(
    harness.pairing.completeBrowserClaim({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      state: "browser-state-a",
      callbackUri: "https://analytics.example/plugin/pair/callback",
      authorizationCode: "authorization-code-a",
      pkceVerifier: "verifier-a",
    }),
    (error: unknown) =>
      error instanceof PluginAuthError && error.code === "PAIRING_UNAVAILABLE",
  );
});

test("replays the same initial credential after response loss until delivery acknowledgement", async () => {
  const { harness, created, issued } = await pairAndIssueDeviceCredential();
  const replay = await harness.pairing.poll({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
  });
  assert.equal(replay.status, "completed");
  assert.equal(replay.bindingId, issued.bindingId);
  assert.equal(replay.deviceCredential, issued.deviceCredential);
  assert.equal(harness.store.exportForTest().bindings.length, 1);

  await harness.pairing.acknowledgeDelivery({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  await harness.pairing.acknowledgeDelivery({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  await assert.rejects(
    harness.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
    }),
    PluginAuthError,
  );
  const snapshot = JSON.stringify(harness.store.exportForTest());
  assert.doesNotMatch(snapshot, new RegExp(issued.deviceCredential));
});

test("rejects initial credential replay with wrong proof or after delivery expiry", async () => {
  const first = await pairAndIssueDeviceCredential();
  await assert.rejects(
    first.harness.pairing.poll({
      pairingId: first.created.pairingId,
      pairingSecret: first.created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "wrong-device-proof",
    }),
    PluginAuthError,
  );
  const second = await pairAndIssueDeviceCredential();
  second.harness.clock.advance(121_000);
  await assert.rejects(
    second.harness.pairing.poll({
      pairingId: second.created.pairingId,
      pairingSecret: second.created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
    }),
    PluginAuthError,
  );
});

test("revokes an orphan binding when initial delivery expires and preserves unrelated bindings", async () => {
  const harness = createHarness();
  const first = await pairAndIssueDeviceCredential(harness);
  const second = await pairAndIssueDeviceCredential(harness);
  const firstLease = await harness.lease.renew({
    bindingId: first.issued.bindingId,
    deviceCredential: first.issued.deviceCredential,
  });
  const secondLease = await harness.lease.renew({
    bindingId: second.issued.bindingId,
    deviceCredential: second.issued.deviceCredential,
  });

  harness.clock.advance(120_001);
  await assert.rejects(
    harness.pairing.poll({
      pairingId: first.created.pairingId,
      pairingSecret: first.created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
    }),
    PluginAuthError,
  );

  const firstBinding = harness.store
    .exportForTest()
    .bindings.find((binding) => binding.bindingId === first.issued.bindingId);
  const secondBinding = harness.store
    .exportForTest()
    .bindings.find((binding) => binding.bindingId === second.issued.bindingId);
  assert.ok(firstBinding?.revokedAt);
  assert.equal(firstBinding?.revocationReason, "initial_delivery_expired");
  assert.equal(secondBinding?.revokedAt, null);
  assert.ok(
    harness.store
      .exportForTest()
      .audits.some(
        (audit) =>
          audit.action === "auth_denied" &&
          audit.details.reason === "pairing_delivery_expired_binding_revoked",
      ),
  );

  await assert.rejects(
    harness.lease.renew({
      bindingId: first.issued.bindingId,
      deviceCredential: first.issued.deviceCredential,
    }),
    PluginAuthError,
  );
  const decisions = new PluginAuthDecisionService({
    store: harness.store,
    configuration: harness.lease.configuration,
    clock: harness.clock,
    random: harness.random,
  });
  await assert.rejects(
    decisions.authorizeEvent({
      leaseToken: firstLease.token,
      queueBindingId: first.issued.bindingId,
    }),
    PluginAuthError,
  );
  await decisions.authorizeEvent({
    leaseToken: secondLease.token,
    queueBindingId: second.issued.bindingId,
  });

  const revokedAt = firstBinding?.revokedAt?.getTime();
  await assert.rejects(
    harness.pairing.poll({
      pairingId: first.created.pairingId,
      pairingSecret: first.created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
    }),
    PluginAuthError,
  );
  const afterRetry = harness.store
    .exportForTest()
    .bindings.find((binding) => binding.bindingId === first.issued.bindingId);
  assert.equal(afterRetry?.revokedAt?.getTime(), revokedAt);
  assert.equal(
    harness.store
      .exportForTest()
      .audits.filter(
        (audit) =>
          audit.action === "binding_revoked" &&
          audit.bindingId === first.issued.bindingId &&
          audit.details.reason === "initial_delivery_expired",
      ).length,
    1,
  );
});

test("consumed pairing delivery outlives the pairing TTL and revokes at delivery expiry", async () => {
  const harness = createHarness();
  const created = await harness.pairing.create({
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
    clientVersion: "8.0.0",
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await harness.pairing.beginBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-near-ttl",
    nonce: "browser-nonce-near-ttl",
    pkceChallenge: pkceChallengeFor("pkce-verifier-near-ttl"),
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  harness.clock.advance(
    harness.lease.configuration.pairingTtlSeconds * 1000 - 1_000,
  );
  await harness.pairing.completeBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-near-ttl",
    callbackUri: "https://analytics.example/plugin/pair/callback",
    authorizationCode: "google-authorization-code-near-ttl",
    pkceVerifier: "pkce-verifier-near-ttl",
  });
  const issued = await harness.pairing.poll({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
  });
  assert.equal(issued.status, "completed");
  const lease = await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });

  harness.clock.advance(1_001);
  const replay = await harness.pairing.poll({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
  });
  assert.equal(replay.status, "completed");
  assert.equal(replay.deviceCredential, issued.deviceCredential);

  harness.clock.advance(119_000);
  await assert.rejects(
    harness.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
    }),
    PluginAuthError,
  );
  const snapshot = harness.store.exportForTest();
  const pairing = snapshot.pairings.find(
    (item) => item.pairingId === created.pairingId,
  );
  const binding = snapshot.bindings.find(
    (item) => item.bindingId === issued.bindingId,
  );
  assert.equal(pairing?.status, "expired");
  assert.ok(binding?.revokedAt);
  assert.equal(binding?.revocationReason, "initial_delivery_expired");
  await assert.rejects(
    harness.lease.renew({
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    }),
    PluginAuthError,
  );
  const decisions = new PluginAuthDecisionService({
    store: harness.store,
    configuration: harness.lease.configuration,
    clock: harness.clock,
    random: harness.random,
  });
  await assert.rejects(
    decisions.authorizeEvent({
      leaseToken: lease.token,
      queueBindingId: issued.bindingId,
    }),
    PluginAuthError,
  );
});

test("expired delivery acknowledgement atomically revokes its binding", async () => {
  const { harness, created, issued } = await pairAndIssueDeviceCredential();
  harness.clock.advance(120_001);
  await assert.rejects(
    harness.pairing.acknowledgeDelivery({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    }),
    PluginAuthError,
  );
  const snapshot = harness.store.exportForTest();
  const pairing = snapshot.pairings.find(
    (item) => item.pairingId === created.pairingId,
  );
  const binding = snapshot.bindings.find(
    (item) => item.bindingId === issued.bindingId,
  );
  assert.equal(pairing?.status, "expired");
  assert.ok(binding?.revokedAt);
  assert.equal(binding?.revocationReason, "initial_delivery_expired");
  assert.equal(
    snapshot.audits.filter(
      (audit) =>
        audit.action === "binding_revoked" &&
        audit.bindingId === issued.bindingId &&
        audit.details.reason === "initial_delivery_expired",
    ).length,
    1,
  );
});

test("delivery acknowledgement revokes when a key value is replaced under the same ID", async () => {
  const { harness, created, issued } = await pairAndIssueDeviceCredential();
  harness.lease.configuration.credentialDeliveryKeys.verificationKeys[
    "delivery-key-1"
  ] = "test-only-replaced-secret-under-the-same-key-id";

  await assert.rejects(
    harness.pairing.acknowledgeDelivery({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    }),
    PluginAuthError,
  );
  const snapshot = harness.store.exportForTest();
  const pairing = snapshot.pairings.find(
    (item) => item.pairingId === created.pairingId,
  );
  const binding = snapshot.bindings.find(
    (item) => item.bindingId === issued.bindingId,
  );
  assert.equal(pairing?.status, "expired");
  assert.ok(binding?.revokedAt);
  assert.equal(binding?.revocationReason, "delivery_key_mismatch");
  assert.equal(pairing?.deliveryAcknowledgedAt, null);
});

test("acknowledged delivery retry stays idempotent after its old key leaves overlap", async () => {
  const harness = createHarness();
  harness.lease.configuration.credentialDeliveryKeys = {
    currentKeyId: "delivery-key-idempotency",
    verificationKeys: {
      "delivery-key-idempotency": "test-only-idempotency-delivery-key",
    },
  };
  const { harness: pairedHarness, created, issued } =
    await pairAndIssueDeviceCredential(harness);
  await pairedHarness.pairing.acknowledgeDelivery({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  delete pairedHarness.lease.configuration.credentialDeliveryKeys.verificationKeys[
    "delivery-key-idempotency"
  ];

  await pairedHarness.pairing.acknowledgeDelivery({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  await assert.rejects(
    pairedHarness.pairing.acknowledgeDelivery({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
      bindingId: issued.bindingId,
      deviceCredential: `${issued.deviceCredential}-wrong`,
    }),
    PluginAuthError,
  );
  const snapshot = pairedHarness.store.exportForTest();
  const binding = snapshot.bindings.find(
    (item) => item.bindingId === issued.bindingId,
  );
  assert.equal(binding?.revokedAt, null);
  assert.equal(binding?.revocationReason, null);
  assert.equal(
    snapshot.audits.filter(
      (audit) =>
        audit.action === "binding_revoked" &&
        audit.bindingId === issued.bindingId,
    ).length,
    0,
  );
});

test("uses the original delivery key during the replay window and revokes on missing overlap key", async () => {
  const harness = createHarness();
  const paired = await pairAndIssueDeviceCredential(harness);
  const deliveryKeys = {
    currentKeyId: "delivery-key-1",
    verificationKeys: {
      "delivery-key-1":
        harness.lease.configuration.credentialDeliveryKeys.verificationKeys[
          "delivery-key-1"
        ],
    },
  };
  (harness.lease.configuration as unknown as { credentialDeliveryKeys: typeof deliveryKeys })
    .credentialDeliveryKeys = deliveryKeys;

  const rotatedKey = "test-only-rotated-delivery-key";
  deliveryKeys.verificationKeys["delivery-key-2"] = rotatedKey;
  deliveryKeys.currentKeyId = "delivery-key-2";
  const replay = await harness.pairing.poll({
    pairingId: paired.created.pairingId,
    pairingSecret: paired.created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
  });
  assert.equal(replay.status, "completed");
  assert.equal(replay.deviceCredential, paired.issued.deviceCredential);

  delete deliveryKeys.verificationKeys["delivery-key-1"];
  await assert.rejects(
    harness.pairing.acknowledgeDelivery({
      pairingId: paired.created.pairingId,
      pairingSecret: paired.created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
      bindingId: paired.issued.bindingId,
      deviceCredential: paired.issued.deviceCredential,
    }),
    PluginAuthError,
  );
  const binding = harness.store
    .exportForTest()
    .bindings.find((item) => item.bindingId === paired.issued.bindingId);
  assert.ok(binding?.revokedAt);
  assert.equal(binding?.revocationReason, "delivery_key_unavailable");
});

test("revokes a delivery binding when the current key changes without overlap metadata", async () => {
  const harness = createHarness();
  const paired = await pairAndIssueDeviceCredential(harness);
  harness.lease.configuration.credentialDeliveryKeys.currentKeyId =
    "delivery-key-unannounced";
  harness.lease.configuration.credentialDeliveryKeys.verificationKeys = {
    "delivery-key-unannounced": "test-only-unannounced-delivery-key",
  };
  await assert.rejects(
    harness.pairing.poll({
      pairingId: paired.created.pairingId,
      pairingSecret: paired.created.pairingSecret,
      deviceId: "device-a",
      deviceChallenge: "device-a-secret-challenge",
    }),
    PluginAuthError,
  );
  const binding = harness.store
    .exportForTest()
    .bindings.find((item) => item.bindingId === paired.issued.bindingId);
  assert.ok(binding?.revokedAt);
  assert.equal(binding?.revocationReason, "delivery_key_unavailable");
});
