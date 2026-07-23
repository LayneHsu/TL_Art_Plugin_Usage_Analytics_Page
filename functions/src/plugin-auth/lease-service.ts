import { createAuditRecord } from "./audit";
import { randomToken, signLeaseToken } from "./crypto";
import { authDenied } from "./errors";
import { pluginPrincipalProfile } from "./principal-service";
import { auditDenied, credentialMatches } from "./service-helpers";
import type {
  Clock,
  PluginAuthConfiguration,
  PluginAuthStore,
  PluginLeaseClaims,
  RandomSource,
} from "./types";

interface LeaseDependencies {
  store: PluginAuthStore;
  clock: Clock;
  random: RandomSource;
  configuration: PluginAuthConfiguration;
}

export class LeaseService {
  public readonly configuration: PluginAuthConfiguration;

  public constructor(private readonly dependencies: LeaseDependencies) {
    this.configuration = dependencies.configuration;
  }

  public async renew(input: {
    bindingId: string;
    deviceCredential: string;
  }) {
    const { store, clock, random, configuration } = this.dependencies;
    const verified = await store.runTransaction(async (transaction) => {
      const binding = await transaction.getBinding(input.bindingId);
      const principal = binding
        ? await transaction.getPrincipal(binding.pluginPrincipalId)
        : undefined;
      if (
        !binding ||
        binding.revokedAt ||
        !principal?.enabled ||
        !credentialMatches(binding, input.deviceCredential, configuration)
      ) {
        await auditDenied(transaction, { clock, random }, {
          bindingId: input.bindingId,
          pluginPrincipalId: binding?.pluginPrincipalId,
          reason: binding?.revokedAt
            ? "binding_revoked"
            : principal && !principal.enabled
              ? "principal_disabled"
              : "device_credential_rejected",
        });
        return null;
      }
      binding.lastVerifiedAt = clock.now();
      if (
        binding.pendingRotation &&
        binding.pendingRotation.expiresAt.getTime() <= clock.now().getTime()
      ) {
        binding.pendingRotation = null;
      }
      await transaction.putBinding(binding);
      return {
        bindingId: binding.bindingId,
        pluginPrincipalId: binding.pluginPrincipalId,
        profile: principal,
      };
    });
    if (!verified) {
      throw authDenied();
    }

    const issuedAt = clock.now();
    const lifetimeSeconds = Math.min(
      3600,
      Math.max(1, configuration.leaseTtlSeconds),
    );
    const expiresAt = new Date(
      issuedAt.getTime() + lifetimeSeconds * 1000,
    );
    const keyId = configuration.leaseSigningKeys.currentKeyId;
    const signingKey = configuration.leaseSigningKeys.verificationKeys[keyId];
    if (!signingKey) {
      throw new Error("Current plugin lease signing key is unavailable");
    }
    const claims: PluginLeaseClaims = {
      version: 1,
      issuer: configuration.leaseIssuer,
      audience: configuration.leaseAudience,
      keyId,
      jti: randomToken(random, "lease_", 18),
      issuedAtSeconds: Math.floor(issuedAt.getTime() / 1000),
      expiresAtSeconds: Math.floor(expiresAt.getTime() / 1000),
      bindingId: verified.bindingId,
      pluginPrincipalId: verified.pluginPrincipalId,
    };
    const token = signLeaseToken(claims, signingKey);
    await store.runTransaction(async (transaction) => {
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "lease_issued",
          bindingId: claims.bindingId,
          pluginPrincipalId: claims.pluginPrincipalId,
          details: {
            lease_version: claims.version,
            signing_key_id: claims.keyId,
            lifetime_seconds: lifetimeSeconds,
          },
        }),
      );
    });
    return {
      token,
      issuedAt,
      expiresAt,
      bindingId: claims.bindingId,
      pluginPrincipalId: claims.pluginPrincipalId,
      keyId: claims.keyId,
      jti: claims.jti,
      version: claims.version,
      ...pluginPrincipalProfile(verified.profile),
    };
  }
}
