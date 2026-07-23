import { createAuditRecord } from "./audit";
import {
  deriveDeliveryCredential,
  keyedDigest,
  pkceChallengeFor,
  randomToken,
  safeEqual,
} from "./crypto";
import { PluginAuthError, pairingUnavailable } from "./errors";
import {
  createOrRefreshPrincipal,
  derivePluginPrincipalId,
  pluginPrincipalProfile,
  validateVerifiedIdentity,
} from "./principal-service";
import {
  auditDenied,
  credentialDigest,
  requireAllowedHttpsCallback,
  requireBoundedString,
} from "./service-helpers";
import type {
  Clock,
  PluginAuthConfiguration,
  PluginAuthStore,
  PluginAuthTransaction,
  PluginOidcExchange,
  PluginPairingRecord,
  PluginPrincipalProfileSnapshot,
  RandomSource,
  VerifiedPluginIdentity,
} from "./types";

interface PairingDependencies {
  store: PluginAuthStore;
  clock: Clock;
  random: RandomSource;
  oidc: PluginOidcExchange;
  configuration: PluginAuthConfiguration;
}

export class PairingService {
  public constructor(private readonly dependencies: PairingDependencies) {}

  public async create(input: {
    deviceId: string;
    deviceChallenge: string;
    clientVersion: string;
    callbackUri: string;
  }) {
    const { configuration, clock, random, store } = this.dependencies;
    const deviceId = requireBoundedString(input.deviceId, "device ID", 8, 128);
    const deviceChallenge = requireBoundedString(
      input.deviceChallenge,
      "device challenge",
      8,
      256,
    );
    const clientVersion = requireBoundedString(
      input.clientVersion,
      "client version",
      1,
      64,
    );
    requireAllowedHttpsCallback(input.callbackUri, configuration);

    const pairingId = randomToken(random, "pair_", 18);
    const pairingSecret = randomToken(random, "pps_", 32);
    const now = clock.now();
    const expiresAt = new Date(
      now.getTime() + configuration.pairingTtlSeconds * 1000,
    );
    await store.runTransaction(async (transaction) => {
      await transaction.putPairing({
        pairingId,
        pairingSecretDigest: keyedDigest(
          configuration.credentialPepper,
          "pairing-secret-v1",
          pairingSecret,
        ),
        deviceIdDigest: keyedDigest(
          configuration.credentialPepper,
          "pairing-device-id-v1",
          deviceId,
        ),
        deviceChallengeDigest: keyedDigest(
          configuration.credentialPepper,
          "pairing-device-challenge-v1",
          deviceChallenge,
        ),
        clientVersion,
        callbackUri: input.callbackUri,
        status: "pending",
        createdAt: now,
        expiresAt,
        nextPollAt: now,
        stateDigest: null,
        nonce: null,
        pkceChallenge: null,
        pluginPrincipalId: null,
        deliveryBindingId: null,
        deliveryKeyId: null,
        deliveryNonce: null,
        deliveryExpiresAt: null,
        deliveryAcknowledgedAt: null,
      });
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "pairing_created",
          pairingId,
          details: { client_version: clientVersion },
        }),
      );
    });
    return { pairingId, pairingSecret, expiresAt };
  }

  public async beginBrowserClaim(input: {
    pairingId: string;
    pairingSecret: string;
    state: string;
    nonce: string;
    pkceChallenge: string;
    callbackUri: string;
  }): Promise<void> {
    const { configuration, clock, random, store } = this.dependencies;
    requireBoundedString(input.state, "OAuth state", 8, 256);
    requireBoundedString(input.nonce, "OIDC nonce", 8, 256);
    requireBoundedString(input.pkceChallenge, "PKCE challenge", 16, 128);
    requireAllowedHttpsCallback(input.callbackUri, configuration);
    const accepted = await store.runTransaction(async (transaction) => {
      const pairing = await transaction.getPairing(input.pairingId);
      if (
        !this.isPairingSecretValid(pairing, input.pairingSecret) ||
        pairing?.status !== "pending" ||
        pairing.callbackUri !== input.callbackUri ||
        pairing.expiresAt.getTime() <= clock.now().getTime()
      ) {
        if (pairing) {
          if (pairing.expiresAt.getTime() <= clock.now().getTime()) {
            pairing.status = "expired";
            await transaction.putPairing(pairing);
          }
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            reason: "pairing_claim_unavailable",
          });
        }
        return false;
      }
      pairing.status = "browser_claim_started";
      pairing.stateDigest = keyedDigest(
        configuration.credentialPepper,
        `pairing-state-v1:${pairing.pairingId}`,
        input.state,
      );
      pairing.nonce = input.nonce;
      pairing.pkceChallenge = input.pkceChallenge;
      await transaction.putPairing(pairing);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "pairing_claim_started",
          pairingId: pairing.pairingId,
        }),
      );
      return true;
    });
    if (!accepted) {
      throw pairingUnavailable();
    }
  }

  public async completeBrowserClaim(input: {
    pairingId: string;
    pairingSecret: string;
    state: string;
    callbackUri: string;
    authorizationCode: string;
    pkceVerifier: string;
  }): Promise<void> {
    const { configuration, clock, random, store, oidc } = this.dependencies;
    requireBoundedString(input.authorizationCode, "authorization code", 8, 4096);
    requireBoundedString(input.pkceVerifier, "PKCE verifier", 8, 256);
    requireBoundedString(input.callbackUri, "callback URI", 8, 2048);

    const reserved = await store.runTransaction(async (transaction) => {
      const pairing = await transaction.getPairing(input.pairingId);
      const stateDigest = pairing
        ? keyedDigest(
            configuration.credentialPepper,
            `pairing-state-v1:${pairing.pairingId}`,
            input.state,
          )
        : "";
      const accepted =
        this.isPairingSecretValid(pairing, input.pairingSecret) &&
        pairing?.status === "browser_claim_started" &&
        pairing.callbackUri === input.callbackUri &&
        pairing.expiresAt.getTime() > clock.now().getTime() &&
        pairing.stateDigest !== null &&
        safeEqual(pairing.stateDigest, stateDigest) &&
        pairing.pkceChallenge !== null &&
        safeEqual(pairing.pkceChallenge, pkceChallengeFor(input.pkceVerifier));
      if (!accepted || !pairing) {
        if (pairing && pairing.status === "browser_claim_started") {
          pairing.status =
            pairing.expiresAt.getTime() <= clock.now().getTime()
              ? "expired"
              : "failed";
          await transaction.putPairing(pairing);
        }
        if (pairing) {
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            reason: "pairing_callback_rejected",
          });
        }
        return null;
      }
      pairing.status = "verifying";
      await transaction.putPairing(pairing);
      return { expectedNonce: pairing.nonce as string };
    });
    if (!reserved) {
      throw pairingUnavailable();
    }

    let identity: VerifiedPluginIdentity;
    try {
      identity = await oidc.exchangeAndVerify({
        authorizationCode: input.authorizationCode,
        pkceVerifier: input.pkceVerifier,
        callbackUri: input.callbackUri,
        expectedNonce: reserved.expectedNonce,
        expectedAudience: configuration.oauthAudience,
        allowedIssuers: configuration.allowedIssuers,
        companyDomain: configuration.companyDomain,
      });
      validateVerifiedIdentity(identity, configuration);
    } catch {
      await this.failVerifyingPairing(input.pairingId, "company_identity_rejected");
      throw new PluginAuthError(
        "COMPANY_IDENTITY_REJECTED",
        "Company account verification failed",
      );
    }

    const principalId = derivePluginPrincipalId(
      configuration,
      identity.issuer,
      identity.subject,
    );
    const completed = await store.runTransaction(async (transaction) => {
      const pairing = await transaction.getPairing(input.pairingId);
      if (
        !pairing ||
        pairing.status !== "verifying" ||
        pairing.expiresAt.getTime() <= clock.now().getTime()
      ) {
        if (pairing) {
          pairing.status = "expired";
          await transaction.putPairing(pairing);
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            reason: "pairing_verification_expired",
          });
        }
        return false;
      }
      const existing = await transaction.getPrincipal(principalId);
      const principal = createOrRefreshPrincipal({
        existing,
        identity,
        configuration,
        now: clock.now(),
      });
      await transaction.putPrincipal(principal);
      pairing.status = "authorized";
      pairing.pluginPrincipalId = principal.principalId;
      await transaction.putPairing(pairing);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "pairing_claimed",
          pairingId: pairing.pairingId,
          pluginPrincipalId: principal.principalId,
        }),
      );
      return true;
    });
    if (!completed) {
      throw pairingUnavailable();
    }
  }

  public async poll(input: {
    pairingId: string;
    pairingSecret: string;
    deviceId: string;
    deviceChallenge: string;
  }): Promise<
    | { status: "pending" }
    | {
        status: "completed";
        bindingId: string;
        pluginPrincipalId: string;
        deviceCredential: string;
      } & PluginPrincipalProfileSnapshot
  > {
    const { configuration, clock, random, store } = this.dependencies;
    const now = clock.now();
    const outcome = await store.runTransaction(async (transaction) => {
      const pairing = await transaction.getPairing(input.pairingId);
      const deviceMatches = pairing
        ? safeEqual(
            pairing.deviceIdDigest,
            keyedDigest(
              configuration.credentialPepper,
              "pairing-device-id-v1",
              input.deviceId,
            ),
          ) &&
          safeEqual(
            pairing.deviceChallengeDigest,
            keyedDigest(
              configuration.credentialPepper,
              "pairing-device-challenge-v1",
              input.deviceChallenge,
            ),
          )
        : false;
      if (
        !this.isPairingSecretValid(pairing, input.pairingSecret) ||
        !deviceMatches ||
        !pairing ||
        ["cancelled", "failed", "expired"].includes(pairing.status)
      ) {
        if (pairing) {
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            reason: "pairing_poll_rejected",
          });
        }
        return { kind: "unavailable" } as const;
      }
      if (pairing.status === "consumed") {
        const deliveryExpired = Boolean(
          !pairing.deliveryAcknowledgedAt &&
            pairing.deliveryExpiresAt &&
            pairing.deliveryExpiresAt.getTime() <= now.getTime(),
        );
        if (deliveryExpired) {
          await this.revokeDeliveryBinding(
            transaction,
            pairing,
            "initial_delivery_expired",
          );
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            pluginPrincipalId: pairing.pluginPrincipalId,
            bindingId: pairing.deliveryBindingId,
            reason: "pairing_delivery_expired_binding_revoked",
          });
          return { kind: "unavailable" } as const;
        }
        if (
          !pairing.deliveryBindingId ||
          !pairing.deliveryNonce ||
          !pairing.deliveryExpiresAt ||
          pairing.deliveryAcknowledgedAt ||
          pairing.deliveryExpiresAt.getTime() <= now.getTime()
        ) {
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            pluginPrincipalId: pairing.pluginPrincipalId,
            reason: "pairing_delivery_replay_denied",
          });
          return { kind: "unavailable" } as const;
        }
        const deliveryKey = this.deliveryKeyFor(pairing);
        const binding = await transaction.getBinding(pairing.deliveryBindingId);
        const principal = pairing.pluginPrincipalId
          ? await transaction.getPrincipal(pairing.pluginPrincipalId)
          : undefined;
        if (
          !binding ||
          !principal?.enabled ||
          binding.pluginPrincipalId !== pairing.pluginPrincipalId
        ) {
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            pluginPrincipalId: pairing.pluginPrincipalId,
            bindingId: pairing.deliveryBindingId,
            reason: !principal?.enabled
              ? "principal_disabled_before_binding"
              : "pairing_delivery_replay_denied",
          });
          return { kind: "unavailable" } as const;
        }
        const replayCredential = deliveryKey
          ? deriveDeliveryCredential(
              deliveryKey,
              pairing.deliveryBindingId,
              pairing.deliveryNonce,
            )
          : null;
        if (
          !deliveryKey ||
          binding.revokedAt ||
          !replayCredential ||
          !safeEqual(
            binding.credentialDigest,
            credentialDigest(configuration, binding.bindingId, replayCredential),
          )
        ) {
          await this.revokeDeliveryBinding(
            transaction,
            pairing,
            deliveryKey ? "delivery_key_mismatch" : "delivery_key_unavailable",
          );
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            pluginPrincipalId: pairing.pluginPrincipalId,
            bindingId: pairing.deliveryBindingId,
            reason: deliveryKey
              ? "pairing_delivery_key_mismatch_binding_revoked"
              : "pairing_delivery_key_unavailable_binding_revoked",
          });
          return { kind: "unavailable" } as const;
        }
        return {
          kind: "completed",
          bindingId: pairing.deliveryBindingId,
          pluginPrincipalId: pairing.pluginPrincipalId as string,
          deviceCredential: replayCredential,
          profile: principal,
        } as const;
      }
      if (pairing.expiresAt.getTime() <= now.getTime()) {
        pairing.status = "expired";
        await transaction.putPairing(pairing);
        await auditDenied(transaction, { clock, random }, {
          pairingId: pairing.pairingId,
          reason: "pairing_poll_rejected",
        });
        return { kind: "unavailable" } as const;
      }
      if (pairing.nextPollAt.getTime() > now.getTime()) {
        await auditDenied(transaction, { clock, random }, {
          pairingId: pairing.pairingId,
          reason: "pairing_poll_rate_limited",
        });
        return { kind: "rate_limited" } as const;
      }
      pairing.nextPollAt = new Date(
        now.getTime() + configuration.pairingPollIntervalSeconds * 1000,
      );
      if (pairing.status !== "authorized" || !pairing.pluginPrincipalId) {
        await transaction.putPairing(pairing);
        return { kind: "pending" } as const;
      }
      const principal = await transaction.getPrincipal(pairing.pluginPrincipalId);
      if (!principal?.enabled) {
        pairing.status = "failed";
        await transaction.putPairing(pairing);
        await auditDenied(transaction, { clock, random }, {
          pairingId: pairing.pairingId,
          pluginPrincipalId: pairing.pluginPrincipalId,
          reason: "principal_disabled_before_binding",
        });
        return { kind: "unavailable" } as const;
      }
      const bindingId = randomToken(random, "bind_", 18);
      const deliveryNonce = randomToken(random, "pdn_", 24);
      const deliveryKeyId = configuration.credentialDeliveryKeys.currentKeyId;
      const deliveryKey =
        configuration.credentialDeliveryKeys.verificationKeys[deliveryKeyId];
      if (!deliveryKey) {
        throw new Error("Current plugin delivery key is unavailable");
      }
      const deviceCredential = deriveDeliveryCredential(
        deliveryKey,
        bindingId,
        deliveryNonce,
      );
      await transaction.putBinding({
        bindingId,
        pluginPrincipalId: principal.principalId,
        deviceIdDigest: pairing.deviceIdDigest,
        credentialDigest: credentialDigest(
          configuration,
          bindingId,
          deviceCredential,
        ),
        credentialVersion: 1,
        clientVersion: pairing.clientVersion,
        createdAt: now,
        lastVerifiedAt: now,
        revokedAt: null,
        revocationReason: null,
        pendingRotation: null,
        lastConfirmedRotation: null,
      });
      pairing.status = "consumed";
      pairing.deliveryBindingId = bindingId;
      pairing.deliveryKeyId = deliveryKeyId;
      pairing.deliveryNonce = deliveryNonce;
      pairing.deliveryExpiresAt = new Date(now.getTime() + 120_000);
      pairing.deliveryAcknowledgedAt = null;
      await transaction.putPairing(pairing);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "binding_created",
          pairingId: pairing.pairingId,
          pluginPrincipalId: principal.principalId,
          bindingId,
          details: { client_version: pairing.clientVersion },
        }),
      );
      return {
        kind: "completed",
        bindingId,
        pluginPrincipalId: principal.principalId,
        deviceCredential,
        profile: principal,
      } as const;
    });

    if (outcome.kind === "unavailable") {
      throw pairingUnavailable();
    }
    if (outcome.kind === "rate_limited") {
      throw new PluginAuthError(
        "POLL_RATE_LIMITED",
        "Pairing status is not ready",
      );
    }
    if (outcome.kind === "pending") {
      return { status: "pending" };
    }
    return {
      status: "completed",
      bindingId: outcome.bindingId,
      pluginPrincipalId: outcome.pluginPrincipalId,
      deviceCredential: outcome.deviceCredential,
      ...pluginPrincipalProfile(outcome.profile),
    };
  }

  public async acknowledgeDelivery(input: {
    pairingId: string;
    pairingSecret: string;
    deviceId: string;
    deviceChallenge: string;
    bindingId: string;
    deviceCredential: string;
  }): Promise<void> {
    const { configuration, clock, random, store } = this.dependencies;
    const acknowledged = await store.runTransaction(async (transaction) => {
      const pairing = await transaction.getPairing(input.pairingId);
      const binding = await transaction.getBinding(input.bindingId);
      const deviceMatches = pairing
        ? safeEqual(
            pairing.deviceIdDigest,
            keyedDigest(
              configuration.credentialPepper,
              "pairing-device-id-v1",
              input.deviceId,
            ),
          ) &&
          safeEqual(
            pairing.deviceChallengeDigest,
            keyedDigest(
              configuration.credentialPepper,
              "pairing-device-challenge-v1",
              input.deviceChallenge,
            ),
          )
        : false;
      if (
        !pairing ||
        pairing.status !== "consumed" ||
        !this.isPairingSecretValid(pairing, input.pairingSecret) ||
        !deviceMatches ||
        pairing.deliveryBindingId !== input.bindingId ||
        !binding
      ) {
        if (pairing) {
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            pluginPrincipalId: pairing.pluginPrincipalId,
            reason: "pairing_delivery_ack_denied",
          });
        }
        return false;
      }
      const submittedMatchesBinding = safeEqual(
        binding.credentialDigest,
        credentialDigest(
          configuration,
          binding.bindingId,
          input.deviceCredential,
        ),
      );
      if (pairing.deliveryAcknowledgedAt) {
        if (!binding.revokedAt && submittedMatchesBinding) {
          return true;
        }
        await auditDenied(transaction, { clock, random }, {
          pairingId: pairing.pairingId,
          pluginPrincipalId: pairing.pluginPrincipalId,
          bindingId: binding.bindingId,
          reason: "pairing_delivery_ack_denied",
        });
        return false;
      }
      const deliveryKey = this.deliveryKeyFor(pairing);
      const expectedCredential =
        deliveryKey && pairing.deliveryNonce
          ? deriveDeliveryCredential(
              deliveryKey,
              pairing.deliveryBindingId,
              pairing.deliveryNonce,
            )
          : null;
      const submittedMatchesExpected = Boolean(
        expectedCredential && safeEqual(input.deviceCredential, expectedCredential),
      );
      const expectedMatchesBinding = Boolean(
        expectedCredential &&
          safeEqual(
            binding.credentialDigest,
            credentialDigest(
              configuration,
              binding.bindingId,
              expectedCredential,
            ),
          ),
      );
      if (
        !deliveryKey ||
        !submittedMatchesExpected ||
        !submittedMatchesBinding ||
        !expectedMatchesBinding
      ) {
        await this.revokeDeliveryBinding(
          transaction,
          pairing,
          deliveryKey ? "delivery_key_mismatch" : "delivery_key_unavailable",
        );
        await auditDenied(transaction, { clock, random }, {
          pairingId: pairing.pairingId,
          pluginPrincipalId: pairing.pluginPrincipalId,
          bindingId: binding.bindingId,
          reason: deliveryKey
            ? "pairing_delivery_key_mismatch_binding_revoked"
            : "pairing_delivery_key_unavailable_binding_revoked",
        });
        return false;
      }
      if (
        !pairing.deliveryNonce ||
        !pairing.deliveryExpiresAt ||
        pairing.deliveryExpiresAt.getTime() <= clock.now().getTime()
      ) {
        await this.revokeDeliveryBinding(
          transaction,
          pairing,
          "initial_delivery_expired",
        );
        await auditDenied(transaction, { clock, random }, {
          pairingId: pairing.pairingId,
          pluginPrincipalId: pairing.pluginPrincipalId,
          bindingId: binding.bindingId,
          reason: "pairing_delivery_ack_expired_binding_revoked",
        });
        return false;
      }
      pairing.deliveryAcknowledgedAt = clock.now();
      await transaction.putPairing(pairing);
      return true;
    });
    if (!acknowledged) {
      throw pairingUnavailable();
    }
  }

  public async cancel(input: {
    pairingId: string;
    pairingSecret: string;
    deviceId: string;
    deviceChallenge: string;
  }): Promise<void> {
    const { configuration, clock, random, store } = this.dependencies;
    const cancelled = await store.runTransaction(async (transaction) => {
      const pairing = await transaction.getPairing(input.pairingId);
      const deviceMatches = pairing
        ? safeEqual(
            pairing.deviceIdDigest,
            keyedDigest(
              configuration.credentialPepper,
              "pairing-device-id-v1",
              input.deviceId,
            ),
          ) &&
          safeEqual(
            pairing.deviceChallengeDigest,
            keyedDigest(
              configuration.credentialPepper,
              "pairing-device-challenge-v1",
              input.deviceChallenge,
            ),
          )
        : false;
      if (
        !this.isPairingSecretValid(pairing, input.pairingSecret) ||
        !deviceMatches ||
        !pairing ||
        !["pending", "browser_claim_started", "verifying"].includes(pairing.status)
      ) {
        return false;
      }
      pairing.status = "cancelled";
      await transaction.putPairing(pairing);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "pairing_cancelled",
          pairingId: pairing.pairingId,
        }),
      );
      return true;
    });
    if (!cancelled) {
      throw pairingUnavailable();
    }
  }

  public async cancelBrowserClaim(input: {
    pairingId: string;
    pairingSecret: string;
  }): Promise<void> {
    const { store, clock, random } = this.dependencies;
    const cancelled = await store.runTransaction(async (transaction) => {
      const pairing = await transaction.getPairing(input.pairingId);
      if (
        this.isPairingSecretValid(pairing, input.pairingSecret) &&
        pairing?.status === "cancelled"
      ) {
        return true;
      }
      if (
        !this.isPairingSecretValid(pairing, input.pairingSecret) ||
        !pairing ||
        !["pending", "browser_claim_started", "verifying"].includes(pairing.status)
      ) {
        if (pairing) {
          await auditDenied(transaction, { clock, random }, {
            pairingId: pairing.pairingId,
            reason: "browser_pairing_cancel_rejected",
          });
        }
        return false;
      }
      pairing.status = "cancelled";
      await transaction.putPairing(pairing);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "pairing_cancelled",
          pairingId: pairing.pairingId,
          details: { source: "browser" },
        }),
      );
      return true;
    });
    if (!cancelled) {
      throw pairingUnavailable();
    }
  }

  private isPairingSecretValid(
    pairing: { pairingSecretDigest: string } | undefined,
    pairingSecret: string,
  ): boolean {
    return Boolean(
      pairing &&
        safeEqual(
          pairing.pairingSecretDigest,
          keyedDigest(
            this.dependencies.configuration.credentialPepper,
            "pairing-secret-v1",
            pairingSecret,
          ),
        ),
    );
  }

  private deliveryKeyFor(pairing: PluginPairingRecord): string | undefined {
    const keyId = pairing.deliveryKeyId;
    return keyId
      ? this.dependencies.configuration.credentialDeliveryKeys.verificationKeys[
          keyId
        ]
      : undefined;
  }

  private async revokeDeliveryBinding(
    transaction: PluginAuthTransaction,
    pairing: PluginPairingRecord,
    reason: "initial_delivery_expired" | "delivery_key_unavailable" | "delivery_key_mismatch",
  ): Promise<void> {
    const { clock, random } = this.dependencies;
    const binding = pairing.deliveryBindingId
      ? await transaction.getBinding(pairing.deliveryBindingId)
      : undefined;
    if (binding && !binding.revokedAt) {
      binding.revokedAt = clock.now();
      binding.revocationReason = reason;
      binding.pendingRotation = null;
      await transaction.putBinding(binding);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "binding_revoked",
          bindingId: binding.bindingId,
          pluginPrincipalId: binding.pluginPrincipalId,
          pairingId: pairing.pairingId,
          details: { reason },
        }),
      );
    }
    pairing.status = "expired";
    await transaction.putPairing(pairing);
  }

  private async failVerifyingPairing(
    pairingId: string,
    reason: string,
  ): Promise<void> {
    const { store, clock, random } = this.dependencies;
    await store.runTransaction(async (transaction: PluginAuthTransaction) => {
      const pairing = await transaction.getPairing(pairingId);
      if (pairing?.status === "verifying") {
        pairing.status = "failed";
        await transaction.putPairing(pairing);
        await auditDenied(transaction, { clock, random }, {
          pairingId,
          reason,
        });
      }
    });
  }
}
