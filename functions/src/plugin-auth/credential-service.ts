import { createAuditRecord } from "./audit";
import { randomToken, safeEqual } from "./crypto";
import { PluginAuthError, authDenied } from "./errors";
import {
  auditDenied,
  credentialDigest,
  credentialMatches,
} from "./service-helpers";
import type {
  Clock,
  PluginAuthConfiguration,
  PluginAuthStore,
  RandomSource,
} from "./types";

interface CredentialDependencies {
  store: PluginAuthStore;
  clock: Clock;
  random: RandomSource;
  configuration: PluginAuthConfiguration;
}

export class CredentialService {
  public constructor(private readonly dependencies: CredentialDependencies) {}

  public async prepareRotation(input: {
    bindingId: string;
    currentCredential: string;
  }) {
    const { store, clock, random, configuration } = this.dependencies;
    const now = clock.now();
    const newDeviceCredential = randomToken(random, "pdc_", 32);
    const rotationId = randomToken(random, "rot_", 18);
    const outcome = await store.runTransaction(async (transaction) => {
      const binding = await transaction.getBinding(input.bindingId);
      const principal = binding
        ? await transaction.getPrincipal(binding.pluginPrincipalId)
        : undefined;
      if (
        !binding ||
        binding.revokedAt ||
        !principal?.enabled ||
        !credentialMatches(binding, input.currentCredential, configuration)
      ) {
        await auditDenied(transaction, { clock, random }, {
          bindingId: input.bindingId,
          pluginPrincipalId: binding?.pluginPrincipalId,
          reason: "credential_rotation_prepare_denied",
        });
        return false;
      }
      if (
        binding.pendingRotation &&
        binding.pendingRotation.expiresAt.getTime() > now.getTime()
      ) {
        await auditDenied(transaction, { clock, random }, {
          bindingId: binding.bindingId,
          pluginPrincipalId: binding.pluginPrincipalId,
          reason: "credential_rotation_already_pending",
        });
        return false;
      }
      if (
        binding.lastConfirmedRotation &&
        binding.lastConfirmedRotation.replayExpiresAt.getTime() <= now.getTime()
      ) {
        binding.lastConfirmedRotation = null;
      }
      binding.pendingRotation = {
        rotationId,
        credentialDigest: credentialDigest(
          configuration,
          binding.bindingId,
          newDeviceCredential,
        ),
        preparedAt: now,
        expiresAt: new Date(
          now.getTime() + configuration.rotationTtlSeconds * 1000,
        ),
      };
      await transaction.putBinding(binding);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "credential_rotation_prepared",
          bindingId: binding.bindingId,
          pluginPrincipalId: binding.pluginPrincipalId,
          details: { credential_version: binding.credentialVersion + 1 },
        }),
      );
      return true;
    });
    if (!outcome) {
      throw authDenied("ROTATION_UNAVAILABLE");
    }
    return {
      rotationId,
      newDeviceCredential,
      expiresAt: new Date(now.getTime() + configuration.rotationTtlSeconds * 1000),
    };
  }

  public async confirmRotation(input: {
    bindingId: string;
    rotationId: string;
    newDeviceCredential: string;
  }): Promise<void> {
    const { store, clock, random, configuration } = this.dependencies;
    const outcome = await store.runTransaction(async (transaction) => {
      const binding = await transaction.getBinding(input.bindingId);
      const rotation = binding?.pendingRotation;
      const now = clock.now();
      const suppliedDigest = credentialDigest(
        configuration,
        input.bindingId,
        input.newDeviceCredential,
      );
      const confirmedReplay = Boolean(
        binding &&
          !binding.revokedAt &&
          !rotation &&
          binding.lastConfirmedRotation &&
          binding.lastConfirmedRotation.rotationId === input.rotationId &&
          binding.lastConfirmedRotation.replayExpiresAt.getTime() > now.getTime() &&
          safeEqual(
            binding.lastConfirmedRotation.credentialDigest,
            suppliedDigest,
          ) &&
          safeEqual(binding.credentialDigest, suppliedDigest),
      );
      if (confirmedReplay) {
        return true;
      }
      const accepted = Boolean(
        binding &&
          !binding.revokedAt &&
          rotation &&
          rotation.rotationId === input.rotationId &&
          rotation.expiresAt.getTime() > now.getTime() &&
          safeEqual(
            rotation.credentialDigest,
            suppliedDigest,
          ),
      );
      if (!accepted || !binding || !rotation) {
        if (
          binding &&
          binding.pendingRotation &&
          binding.pendingRotation.expiresAt.getTime() <= now.getTime()
        ) {
          binding.pendingRotation = null;
          await transaction.putBinding(binding);
        }
        await auditDenied(transaction, { clock, random }, {
          bindingId: input.bindingId,
          pluginPrincipalId: binding?.pluginPrincipalId,
          reason: "credential_rotation_confirm_denied",
        });
        return false;
      }
      binding.credentialDigest = rotation.credentialDigest;
      binding.credentialVersion += 1;
      binding.lastVerifiedAt = now;
      binding.pendingRotation = null;
      binding.lastConfirmedRotation = {
        rotationId: rotation.rotationId,
        credentialDigest: rotation.credentialDigest,
        confirmedAt: now,
        replayExpiresAt: new Date(
          now.getTime() + configuration.rotationTtlSeconds * 1000,
        ),
      };
      await transaction.putBinding(binding);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "credential_rotation_confirmed",
          bindingId: binding.bindingId,
          pluginPrincipalId: binding.pluginPrincipalId,
          details: { credential_version: binding.credentialVersion },
        }),
      );
      return true;
    });
    if (!outcome) {
      throw authDenied("ROTATION_UNAVAILABLE");
    }
  }

  public async cancelRotation(input: {
    bindingId: string;
    rotationId: string;
    currentCredential: string;
  }): Promise<void> {
    const { store, clock, random, configuration } = this.dependencies;
    const outcome = await store.runTransaction(async (transaction) => {
      const binding = await transaction.getBinding(input.bindingId);
      if (
        !binding ||
        binding.revokedAt ||
        !credentialMatches(binding, input.currentCredential, configuration) ||
        binding.pendingRotation?.rotationId !== input.rotationId
      ) {
        await auditDenied(transaction, { clock, random }, {
          bindingId: input.bindingId,
          pluginPrincipalId: binding?.pluginPrincipalId,
          reason: "credential_rotation_cancel_denied",
        });
        return false;
      }
      binding.pendingRotation = null;
      await transaction.putBinding(binding);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "credential_rotation_cancelled",
          bindingId: binding.bindingId,
          pluginPrincipalId: binding.pluginPrincipalId,
        }),
      );
      return true;
    });
    if (!outcome) {
      throw authDenied("ROTATION_UNAVAILABLE");
    }
  }

  public async unlink(input: {
    bindingId: string;
    currentCredential: string;
  }): Promise<void> {
    const { store, clock, random, configuration } = this.dependencies;
    const outcome = await store.runTransaction(async (transaction) => {
      const binding = await transaction.getBinding(input.bindingId);
      if (
        !binding ||
        binding.revokedAt ||
        !credentialMatches(binding, input.currentCredential, configuration)
      ) {
        await auditDenied(transaction, { clock, random }, {
          bindingId: input.bindingId,
          pluginPrincipalId: binding?.pluginPrincipalId,
          reason: "binding_unlink_denied",
        });
        return false;
      }
      binding.revokedAt = clock.now();
      binding.revocationReason = "client_unlinked";
      binding.pendingRotation = null;
      await transaction.putBinding(binding);
      await transaction.putAudit(
        createAuditRecord({
          clock,
          random,
          action: "binding_unlinked",
          bindingId: binding.bindingId,
          pluginPrincipalId: binding.pluginPrincipalId,
        }),
      );
      return true;
    });
    if (!outcome) {
      throw new PluginAuthError(
        "INVALID_DEVICE_CREDENTIAL",
        "Plugin authorization failed",
      );
    }
  }
}
