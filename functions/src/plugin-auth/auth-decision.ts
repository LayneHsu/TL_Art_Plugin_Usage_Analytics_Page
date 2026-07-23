import { verifyLeaseToken } from "./crypto";
import { PluginAuthError, authDenied } from "./errors";
import { auditDenied } from "./service-helpers";
import type {
  Clock,
  PluginAuthConfiguration,
  PluginAuthStore,
  RandomSource,
} from "./types";

export function assertLeaseAuthorizesBinding(input: {
  token: string;
  expectedBindingId: string;
  now: Date;
  configuration: PluginAuthConfiguration;
}) {
  const claims = verifyLeaseToken(input.token, input.configuration, input.now);
  if (claims.bindingId !== input.expectedBindingId) {
    throw new PluginAuthError(
      "BINDING_MISMATCH",
      "Plugin lease does not authorize this queue binding",
    );
  }
  if (claims.expiresAtSeconds * 1000 <= input.now.getTime()) {
    throw new PluginAuthError("LEASE_EXPIRED", "Plugin lease has expired");
  }
  return claims;
}

export class PluginAuthDecisionService {
  public constructor(
    private readonly dependencies: {
      store: PluginAuthStore;
      configuration: PluginAuthConfiguration;
      clock: Clock;
      random: RandomSource;
      onAuditFailure?: (reason: string) => Promise<void> | void;
    },
  ) {}

  public async authorizeEvent(input: {
    leaseToken: string;
    queueBindingId: string;
  }) {
    const now = this.dependencies.clock.now();
    let claims;
    try {
      claims = verifyLeaseToken(
        input.leaseToken,
        this.dependencies.configuration,
        now,
      );
    } catch {
      await this.auditDeniedBestEffort({ reason: "event_lease_invalid" });
      throw new PluginAuthError("LEASE_INVALID", "Plugin lease is invalid");
    }
    if (claims.bindingId !== input.queueBindingId) {
      await this.auditDeniedBestEffort({
        bindingId: claims.bindingId,
        pluginPrincipalId: claims.pluginPrincipalId,
        reason: "event_binding_mismatch",
      });
      throw new PluginAuthError(
        "BINDING_MISMATCH",
        "Plugin lease does not authorize this queue binding",
      );
    }
    if (claims.expiresAtSeconds * 1000 <= now.getTime()) {
      await this.auditDeniedBestEffort({
        bindingId: claims.bindingId,
        pluginPrincipalId: claims.pluginPrincipalId,
        reason: "event_lease_expired",
      });
      throw new PluginAuthError("LEASE_EXPIRED", "Plugin lease has expired");
    }
    const decision = await this.dependencies.store.runTransaction(
      async (transaction) => {
        const binding = await transaction.getBinding(claims.bindingId);
        if (!binding) {
          return {
            active: false,
            code: "BINDING_REVOKED" as const,
            audit: { bindingId: claims.bindingId, pluginPrincipalId: claims.pluginPrincipalId, reason: "event_binding_missing" },
          };
        }
        if (binding.revokedAt) {
          return {
            active: false,
            code: "BINDING_REVOKED" as const,
            audit: { bindingId: binding.bindingId, pluginPrincipalId: binding.pluginPrincipalId, reason: "event_binding_revoked" },
          };
        }
        if (binding.pluginPrincipalId !== claims.pluginPrincipalId) {
          return {
            active: false,
            code: "BINDING_REVOKED" as const,
            audit: { bindingId: binding.bindingId, pluginPrincipalId: binding.pluginPrincipalId, reason: "event_principal_mismatch" },
          };
        }
        const principal = binding
          ? await transaction.getPrincipal(binding.pluginPrincipalId)
          : undefined;
        if (!principal) {
          return {
            active: false,
            code: "PRINCIPAL_DISABLED" as const,
            audit: { bindingId: binding.bindingId, pluginPrincipalId: binding.pluginPrincipalId, reason: "event_principal_missing" },
          };
        }
        if (!principal.enabled) {
          return {
            active: false,
            code: "PRINCIPAL_DISABLED" as const,
            audit: { bindingId: binding.bindingId, pluginPrincipalId: principal.principalId, reason: "event_principal_disabled" },
          };
        }
        return { active: true } as const;
      },
    );
    if (!decision.active) {
      await this.auditDeniedBestEffort(decision.audit);
      throw authDenied(decision.code);
    }
    return claims;
  }

  private async auditDeniedBestEffort(input: {
    bindingId?: string;
    pluginPrincipalId?: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.dependencies.store.runTransaction(async (transaction) => {
        await auditDenied(transaction, this.auditDependencies(), input);
      });
    } catch {
      try {
        await this.dependencies.onAuditFailure?.(input.reason.slice(0, 64));
      } catch {
        // Audit degradation must not alter the original fail-closed decision.
      }
    }
  }

  private auditDependencies() {
    return {
      clock: this.dependencies.clock,
      random: this.dependencies.random,
    };
  }
}
