import assert from "node:assert/strict";
import test from "node:test";

import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { CredentialService } from "../src/plugin-auth/credential-service";
import { PluginAuthDecisionService } from "../src/plugin-auth/auth-decision";
import { PluginAuthError } from "../src/plugin-auth/errors";
import { FirestorePluginAuthStore } from "../src/plugin-auth/firestore-store";
import { LeaseService } from "../src/plugin-auth/lease-service";
import { PluginOpsApprovalService } from "../src/plugin-auth/ops-approval-service";
import { PairingService } from "../src/plugin-auth/pairing-service";
import type { VerifiedPluginOpsIdentity } from "../src/plugin-auth/types";
import {
  configuration,
  FakeOidcExchange,
  ManualClock,
  pkceChallengeFor,
  SequenceRandom,
} from "../test/helpers";

const projectId = "demo-tl-art-tool-usage-analytics";
const pluginCollections = [
  "pluginPrincipals",
  "pluginDeviceBindings",
  "pluginDevicePairings",
  "pluginAuthAudit",
  "pluginOpsReviews",
];

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

test("Firestore plugin auth transactions", async (suite) => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST must be provided by firebase emulators:exec",
  );
  const app = initializeApp({ projectId }, `plugin-auth-emulator-${Date.now()}`);
  const firestore = getFirestore(app);
  suite.after(async () => {
    await clearPluginCollections();
    await deleteApp(app);
  });

  async function clearPluginCollections(): Promise<void> {
    await Promise.all(
      pluginCollections.map((name) =>
        firestore.recursiveDelete(firestore.collection(name)),
      ),
    );
  }

  function createServices() {
    const store = new FirestorePluginAuthStore(firestore);
    const clock = new ManualClock();
    const random = new SequenceRandom();
    const serviceConfiguration = {
      ...configuration,
      credentialDeliveryKeys: {
        ...configuration.credentialDeliveryKeys,
        verificationKeys: {
          ...configuration.credentialDeliveryKeys.verificationKeys,
        },
      },
      leaseSigningKeys: {
        ...configuration.leaseSigningKeys,
        verificationKeys: { ...configuration.leaseSigningKeys.verificationKeys },
      },
    };
    const pairing = new PairingService({
      store,
      clock,
      random,
      oidc: new FakeOidcExchange(),
      configuration: serviceConfiguration,
    });
    return {
      store,
      clock,
      random,
      configuration: serviceConfiguration,
      pairing,
      credentials: new CredentialService({
        store,
        clock,
        random,
        configuration: serviceConfiguration,
      }),
      lease: new LeaseService({
        store,
        clock,
        random,
        configuration: serviceConfiguration,
      }),
      ops: new PluginOpsApprovalService({
        store,
        clock,
        random,
        reviewTtlSeconds: 600,
        leaseSigningKeyMetadata: {
          currentKeyId: serviceConfiguration.leaseSigningKeys.currentKeyId,
          verificationKeyIds: Object.keys(
            serviceConfiguration.leaseSigningKeys.verificationKeys,
          ),
        },
      }),
    };
  }

  async function pair(services: ReturnType<typeof createServices>) {
    const created = await services.pairing.create({
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
      clientVersion: "8.0.0",
      callbackUri: "https://analytics.example/plugin/pair/callback",
    });
    await services.pairing.beginBrowserClaim({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      state: "browser-state-emulator",
      nonce: "browser-nonce-emulator",
      pkceChallenge: pkceChallengeFor("pkce-verifier-emulator"),
      callbackUri: "https://analytics.example/plugin/pair/callback",
    });
    await services.pairing.completeBrowserClaim({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      state: "browser-state-emulator",
      callbackUri: "https://analytics.example/plugin/pair/callback",
      authorizationCode: "google-authorization-code",
      pkceVerifier: "pkce-verifier-emulator",
    });
    const issued = await services.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
    });
    assert.equal(issued.status, "completed");
    return { created, issued };
  }

  await suite.test("consume replay and acknowledgement are atomic", async () => {
    await clearPluginCollections();
    const services = createServices();
    const { created, issued } = await pair(services);
    const replay = await services.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
    });
    assert.equal(replay.status, "completed");
    assert.equal(replay.bindingId, issued.bindingId);
    assert.equal(replay.deviceCredential, issued.deviceCredential);
    assert.equal(issued.email, "artist.b@xd.com");
    assert.equal(issued.display_name, "Artist B");
    assert.equal(issued.avatar_url, "https://images.example/avatar-b.png");
    assert.equal(issued.profile_updated_at, "2026-07-22T02:00:00.000Z");
    assert.deepEqual(
      {
        email: replay.email,
        display_name: replay.display_name,
        avatar_url: replay.avatar_url,
        profile_updated_at: replay.profile_updated_at,
      },
      {
        email: "artist.b@xd.com",
        display_name: "Artist B",
        avatar_url: "https://images.example/avatar-b.png",
        profile_updated_at: "2026-07-22T02:00:00.000Z",
      },
    );
    await services.pairing.acknowledgeDelivery({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    });
    await services.pairing.acknowledgeDelivery({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    });
    await assert.rejects(
      services.pairing.poll({
        pairingId: created.pairingId,
        pairingSecret: created.pairingSecret,
        deviceId: "device-emulator",
        deviceChallenge: "device-emulator-secret-challenge",
      }),
      PluginAuthError,
    );
    const bindingDocuments = await firestore
      .collection("pluginDeviceBindings")
      .get();
    assert.equal(bindingDocuments.size, 1);
    assert.doesNotMatch(
      JSON.stringify(bindingDocuments.docs[0].data()),
      new RegExp(issued.deviceCredential),
    );
  });

  await suite.test("expired delivery replay is rejected", async () => {
    await clearPluginCollections();
    const services = createServices();
    const { created } = await pair(services);
    services.clock.advance(121_000);
    await assert.rejects(
      services.pairing.poll({
        pairingId: created.pairingId,
        pairingSecret: created.pairingSecret,
        deviceId: "device-emulator",
        deviceChallenge: "device-emulator-secret-challenge",
      }),
      PluginAuthError,
    );
  });

  await suite.test("near-TTL delivery expiry revokes the binding and blocks lease use", async () => {
    await clearPluginCollections();
    const services = createServices();
    const created = await services.pairing.create({
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
      clientVersion: "8.0.0",
      callbackUri: "https://analytics.example/plugin/pair/callback",
    });
    await services.pairing.beginBrowserClaim({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      state: "browser-state-near-ttl",
      nonce: "browser-nonce-near-ttl",
      pkceChallenge: pkceChallengeFor("pkce-verifier-near-ttl"),
      callbackUri: "https://analytics.example/plugin/pair/callback",
    });
    services.clock.advance(
      services.configuration.pairingTtlSeconds * 1000 - 1_000,
    );
    await services.pairing.completeBrowserClaim({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      state: "browser-state-near-ttl",
      callbackUri: "https://analytics.example/plugin/pair/callback",
      authorizationCode: "google-authorization-code-near-ttl",
      pkceVerifier: "pkce-verifier-near-ttl",
    });
    const issued = await services.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
    });
    assert.equal(issued.status, "completed");
    const lease = await services.lease.renew({
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    });
    assert.equal(lease.email, "artist.b@xd.com");
    assert.equal(lease.display_name, "Artist B");
    assert.equal(lease.avatar_url, "https://images.example/avatar-b.png");
    assert.equal(lease.profile_updated_at, issued.profile_updated_at);
    services.clock.advance(1_001);
    const replay = await services.pairing.poll({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
    });
    assert.equal(replay.status, "completed");
    services.clock.advance(119_000);
    await assert.rejects(
      services.pairing.poll({
        pairingId: created.pairingId,
        pairingSecret: created.pairingSecret,
        deviceId: "device-emulator",
        deviceChallenge: "device-emulator-secret-challenge",
      }),
      PluginAuthError,
    );
    const binding = await firestore
      .collection("pluginDeviceBindings")
      .doc(issued.bindingId)
      .get();
    const pairing = await firestore
      .collection("pluginDevicePairings")
      .doc(created.pairingId)
      .get();
    assert.ok(binding.data()?.revokedAt);
    assert.equal(binding.data()?.revocationReason, "initial_delivery_expired");
    assert.equal(pairing.data()?.status, "expired");
    await assert.rejects(
      services.lease.renew({
        bindingId: issued.bindingId,
        deviceCredential: issued.deviceCredential,
      }),
      PluginAuthError,
    );
    const decisions = new PluginAuthDecisionService({
      store: services.store,
      configuration: services.configuration,
      clock: services.clock,
      random: services.random,
    });
    await assert.rejects(
      decisions.authorizeEvent({
        leaseToken: lease.token,
        queueBindingId: issued.bindingId,
      }),
      PluginAuthError,
    );
  });

  await suite.test("expired acknowledgement revokes the delivery binding", async () => {
    await clearPluginCollections();
    const services = createServices();
    const { created, issued } = await pair(services);
    services.clock.advance(120_001);
    await assert.rejects(
      services.pairing.acknowledgeDelivery({
        pairingId: created.pairingId,
        pairingSecret: created.pairingSecret,
        deviceId: "device-emulator",
        deviceChallenge: "device-emulator-secret-challenge",
        bindingId: issued.bindingId,
        deviceCredential: issued.deviceCredential,
      }),
      PluginAuthError,
    );
    const binding = await firestore
      .collection("pluginDeviceBindings")
      .doc(issued.bindingId)
      .get();
    const pairing = await firestore
      .collection("pluginDevicePairings")
      .doc(created.pairingId)
      .get();
    assert.ok(binding.data()?.revokedAt);
    assert.equal(binding.data()?.revocationReason, "initial_delivery_expired");
    assert.equal(pairing.data()?.status, "expired");
  });

  await suite.test("same-ID delivery key replacement revokes before acknowledgement", async () => {
    await clearPluginCollections();
    const services = createServices();
    const { created, issued } = await pair(services);
    services.configuration.credentialDeliveryKeys.verificationKeys[
      "delivery-key-1"
    ] = "test-only-replaced-secret-under-the-same-key-id";
    await assert.rejects(
      services.pairing.acknowledgeDelivery({
        pairingId: created.pairingId,
        pairingSecret: created.pairingSecret,
        deviceId: "device-emulator",
        deviceChallenge: "device-emulator-secret-challenge",
        bindingId: issued.bindingId,
        deviceCredential: issued.deviceCredential,
      }),
      PluginAuthError,
    );
    const binding = await firestore
      .collection("pluginDeviceBindings")
      .doc(issued.bindingId)
      .get();
    const pairing = await firestore
      .collection("pluginDevicePairings")
      .doc(created.pairingId)
      .get();
    assert.ok(binding.data()?.revokedAt);
    assert.equal(binding.data()?.revocationReason, "delivery_key_mismatch");
    assert.equal(pairing.data()?.status, "expired");
    assert.equal(pairing.data()?.deliveryAcknowledgedAt, null);
  });

  await suite.test("acknowledged delivery retry survives old key removal", async () => {
    await clearPluginCollections();
    const services = createServices();
    const { created, issued } = await pair(services);
    await services.pairing.acknowledgeDelivery({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    });
    delete services.configuration.credentialDeliveryKeys.verificationKeys[
      "delivery-key-1"
    ];
    await services.pairing.acknowledgeDelivery({
      pairingId: created.pairingId,
      pairingSecret: created.pairingSecret,
      deviceId: "device-emulator",
      deviceChallenge: "device-emulator-secret-challenge",
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    });
    await assert.rejects(
      services.pairing.acknowledgeDelivery({
        pairingId: created.pairingId,
        pairingSecret: created.pairingSecret,
        deviceId: "device-emulator",
        deviceChallenge: "device-emulator-secret-challenge",
        bindingId: issued.bindingId,
        deviceCredential: `${issued.deviceCredential}-wrong`,
      }),
      PluginAuthError,
    );
    const binding = await firestore
      .collection("pluginDeviceBindings")
      .doc(issued.bindingId)
      .get();
    assert.equal(binding.data()?.revokedAt, null);
    assert.equal(binding.data()?.revocationReason, null);
  });

  await suite.test("rotation confirmation retry is idempotent", async () => {
    await clearPluginCollections();
    const services = createServices();
    const { issued } = await pair(services);
    const prepared = await services.credentials.prepareRotation({
      bindingId: issued.bindingId,
      currentCredential: issued.deviceCredential,
    });
    const confirmation = {
      bindingId: issued.bindingId,
      rotationId: prepared.rotationId,
      newDeviceCredential: prepared.newDeviceCredential,
    };
    await services.credentials.confirmRotation(confirmation);
    await services.credentials.confirmRotation(confirmation);
    await assert.rejects(
      services.credentials.confirmRotation({
        ...confirmation,
        newDeviceCredential: `${prepared.newDeviceCredential}tampered`,
      }),
      PluginAuthError,
    );
  });

  await suite.test("ops approval executes once with a separate approver", async () => {
    await clearPluginCollections();
    const services = createServices();
    const { issued } = await pair(services);
    const requested = await services.ops.request({
      identity: requester,
      action: "revoke_binding",
      targetId: issued.bindingId,
      parameters: { reason: "lost_device" },
    });
    await assert.rejects(
      services.ops.approve({ identity: requester, reviewId: requested.reviewId }),
      PluginAuthError,
    );
    await services.ops.approve({
      identity: approver,
      reviewId: requested.reviewId,
    });
    await services.ops.execute({
      identity: requester,
      reviewId: requested.reviewId,
    });
    await assert.rejects(
      services.ops.execute({
        identity: requester,
        reviewId: requested.reviewId,
      }),
      PluginAuthError,
    );
    const review = await firestore
      .collection("pluginOpsReviews")
      .doc(requested.reviewId)
      .get();
    assert.equal(review.data()?.status, "executed");
    const binding = await firestore
      .collection("pluginDeviceBindings")
      .doc(issued.bindingId)
      .get();
    assert.equal(binding.data()?.revocationReason, "lost_device");
  });
});
