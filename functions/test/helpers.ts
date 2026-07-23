import { createHash } from "node:crypto";

import { CredentialService } from "../src/plugin-auth/credential-service";
import { InMemoryPluginAuthStore } from "../src/plugin-auth/in-memory-store";
import { LeaseService } from "../src/plugin-auth/lease-service";
import { PairingService } from "../src/plugin-auth/pairing-service";
import type {
  Clock,
  OidcExchangeRequest,
  PluginAuthConfiguration,
  VerifiedPluginIdentity,
} from "../src/plugin-auth/types";

export class ManualClock implements Clock {
  private current: Date;

  public constructor(iso = "2026-07-22T02:00:00.000Z") {
    this.current = new Date(iso);
  }

  public now(): Date {
    return new Date(this.current);
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class SequenceRandom {
  private nextValue = 0;

  public bytes(length: number): Buffer {
    this.nextValue += 1;
    const digest = createHash("sha512")
      .update(`test-random-${this.nextValue}`)
      .digest();
    return Buffer.from(digest.subarray(0, length));
  }
}

export class FakeOidcExchange {
  public readonly requests: OidcExchangeRequest[] = [];
  public identity: VerifiedPluginIdentity = {
    issuer: "https://accounts.google.com",
    subject: "google-subject-b",
    email: "artist.b@xd.com",
    emailVerified: true,
    displayName: "Artist B",
    avatarUrl: "https://images.example/avatar-b.png",
  };

  public async exchangeAndVerify(
    request: OidcExchangeRequest,
  ): Promise<VerifiedPluginIdentity> {
    this.requests.push(request);
    return this.identity;
  }
}

export const configuration: PluginAuthConfiguration = {
  companyDomain: "xd.com",
  allowedIssuers: ["https://accounts.google.com", "accounts.google.com"],
  oauthAudience: "plugin-oauth-client-id",
  allowedCallbackUris: ["https://analytics.example/plugin/pair/callback"],
  pairingTtlSeconds: 300,
  pairingPollIntervalSeconds: 2,
  rotationTtlSeconds: 300,
  credentialPepper: "test-only-pepper-not-a-real-secret",
  credentialDeliveryKeys: {
    currentKeyId: "delivery-key-1",
    verificationKeys: {
      "delivery-key-1": "test-only-delivery-key-not-a-real-secret",
    },
  },
  principalKeyPepper: "test-only-principal-pepper",
  principalKeyId: "v1",
  principalPepperMigrationMode: "disabled",
  leaseIssuer: "tl-art-tool-usage-analytics/plugin-auth",
  leaseAudience: "tl-art-tool-usage-ingestion",
  leaseTtlSeconds: 3600,
  leaseClockSkewSeconds: 300,
  leaseSigningKeys: {
    currentKeyId: "lease-key-2",
    verificationKeys: {
      "lease-key-1": "test-only-old-signing-key-with-overlap",
      "lease-key-2": "test-only-current-signing-key",
    },
  },
};

export function leaseSigningKeyMetadata(
  input: PluginAuthConfiguration = configuration,
) {
  return {
    currentKeyId: input.leaseSigningKeys.currentKeyId,
    verificationKeyIds: Object.keys(input.leaseSigningKeys.verificationKeys),
  };
}

export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createHarness() {
  const clock = new ManualClock();
  const random = new SequenceRandom();
  const store = new InMemoryPluginAuthStore();
  const oidc = new FakeOidcExchange();
  const harnessConfiguration: PluginAuthConfiguration = {
    ...configuration,
    allowedIssuers: [...configuration.allowedIssuers],
    allowedCallbackUris: [...configuration.allowedCallbackUris],
    credentialDeliveryKeys: {
      ...configuration.credentialDeliveryKeys,
      verificationKeys: { ...configuration.credentialDeliveryKeys.verificationKeys },
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
    oidc,
    configuration: harnessConfiguration,
  });
  const lease = new LeaseService({
    store,
    clock,
    random,
    configuration: harnessConfiguration,
  });
  const credentials = new CredentialService({
    store,
    clock,
    random,
    configuration: harnessConfiguration,
  });

  return { clock, random, store, oidc, pairing, lease, credentials };
}

export async function pairAndIssueDeviceCredential(
  harness = createHarness(),
) {
  const created = await harness.pairing.create({
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
    clientVersion: "8.0.0",
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await harness.pairing.beginBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-a",
    nonce: "browser-nonce-a",
    pkceChallenge: pkceChallengeFor("pkce-verifier-a"),
    callbackUri: "https://analytics.example/plugin/pair/callback",
  });
  await harness.pairing.completeBrowserClaim({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    state: "browser-state-a",
    callbackUri: "https://analytics.example/plugin/pair/callback",
    authorizationCode: "google-authorization-code",
    pkceVerifier: "pkce-verifier-a",
  });
  const issued = await harness.pairing.poll({
    pairingId: created.pairingId,
    pairingSecret: created.pairingSecret,
    deviceId: "device-a",
    deviceChallenge: "device-a-secret-challenge",
  });
  if (issued.status !== "completed") {
    throw new Error(`Expected completed pairing, got ${issued.status}`);
  }
  return { harness, created, issued };
}
