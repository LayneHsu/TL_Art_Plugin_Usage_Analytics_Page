import { randomToken } from "./crypto";
import type {
  Clock,
  PluginAuditAction,
  PluginAuthAuditRecord,
  RandomSource,
} from "./types";

const forbiddenDetailKey = /credential|token|authorization|secret|code|verifier/i;
const credentialLikeValue =
  /(?:pdc_|pps_)[A-Za-z0-9_-]{20,}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i;
const sensitiveIdentifier = /(?:pdc_|pps_|pdn_|Bearer\s+|eyJ)/i;
const safeIdentifier = /^[A-Za-z0-9@._:-]{1,192}$/;
const safeDetailKey = /^[a-z][a-z0-9_]{0,63}$/;
const allowedActions = new Set<PluginAuditAction>([
  "pairing_created",
  "pairing_claim_started",
  "pairing_claimed",
  "pairing_cancelled",
  "binding_created",
  "lease_issued",
  "credential_rotation_prepared",
  "credential_rotation_confirmed",
  "credential_rotation_cancelled",
  "binding_unlinked",
  "binding_revoked",
  "principal_disabled",
  "signing_key_rotated",
  "ops_review_requested",
  "ops_review_approved",
  "ops_review_executed",
  "auth_denied",
]);

function sanitizeDetailValue(value: string): string {
  if (credentialLikeValue.test(value) || sensitiveIdentifier.test(value)) {
    return "[REDACTED]";
  }
  return value.slice(0, 256);
}

function sanitizeIdentifier(value: string | null | undefined): string | null {
  if (
    !value ||
    !safeIdentifier.test(value) ||
    credentialLikeValue.test(value) ||
    sensitiveIdentifier.test(value)
  ) {
    return null;
  }
  return value;
}

export function createAuditRecord(input: {
  clock: Clock;
  random: RandomSource;
  action: PluginAuditAction;
  outcome?: "allowed" | "denied";
  pluginPrincipalId?: string | null;
  bindingId?: string | null;
  pairingId?: string | null;
  actorId?: string | null;
  reviewId?: string | null;
  targetId?: string | null;
  details?: Record<string, string | number | boolean | null>;
}): PluginAuthAuditRecord {
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input.details ?? {})) {
    if (!safeDetailKey.test(key) || forbiddenDetailKey.test(key)) {
      continue;
    }
    details[key] = typeof value === "string" ? sanitizeDetailValue(value) : value;
  }
  const action = allowedActions.has(input.action) ? input.action : "auth_denied";
  const outcome =
    action === "auth_denied" && !allowedActions.has(input.action)
      ? "denied"
      : input.outcome === "allowed" || input.outcome === "denied"
        ? input.outcome
        : "denied";
  return {
    auditId: randomToken(input.random, "paa_", 18),
    occurredAt: input.clock.now(),
    action,
    outcome: input.outcome === undefined && action !== "auth_denied" ? "allowed" : outcome,
    pluginPrincipalId: sanitizeIdentifier(input.pluginPrincipalId),
    bindingId: sanitizeIdentifier(input.bindingId),
    pairingId: sanitizeIdentifier(input.pairingId),
    actorId: sanitizeIdentifier(input.actorId),
    reviewId: sanitizeIdentifier(input.reviewId),
    targetId: sanitizeIdentifier(input.targetId),
    details,
  };
}
