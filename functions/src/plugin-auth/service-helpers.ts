import { createAuditRecord } from "./audit";
import { keyedDigest, safeEqual } from "./crypto";
import { PluginAuthError } from "./errors";
import type {
  Clock,
  PluginAuthConfiguration,
  PluginAuthTransaction,
  PluginDeviceBindingRecord,
  RandomSource,
} from "./types";

export function requireBoundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new PluginAuthError("INVALID_REQUEST", `Invalid ${label}`);
  }
  return value;
}

export function requireAllowedHttpsCallback(
  callbackUri: string,
  configuration: PluginAuthConfiguration,
): void {
  let parsed: URL;
  try {
    parsed = new URL(callbackUri);
  } catch {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid callback URI");
  }
  if (
    parsed.protocol !== "https:" ||
    !configuration.allowedCallbackUris.includes(callbackUri)
  ) {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid callback URI");
  }
}

export function credentialDigest(
  configuration: PluginAuthConfiguration,
  bindingId: string,
  credential: string,
): string {
  return keyedDigest(
    configuration.credentialPepper,
    `device-credential-v1:${bindingId}`,
    credential,
  );
}

export function credentialMatches(
  binding: PluginDeviceBindingRecord,
  credential: string,
  configuration: PluginAuthConfiguration,
): boolean {
  return safeEqual(
    binding.credentialDigest,
    credentialDigest(configuration, binding.bindingId, credential),
  );
}

export async function auditDenied(
  transaction: PluginAuthTransaction,
  dependencies: { clock: Clock; random: RandomSource },
  input: {
    bindingId?: string | null;
    pluginPrincipalId?: string | null;
    pairingId?: string | null;
    actorId?: string | null;
    reviewId?: string | null;
    reason: string;
  },
): Promise<void> {
  await transaction.putAudit(
    createAuditRecord({
      ...dependencies,
      action: "auth_denied",
      outcome: "denied",
      bindingId: input.bindingId,
      pluginPrincipalId: input.pluginPrincipalId,
      pairingId: input.pairingId,
      actorId: input.actorId,
      reviewId: input.reviewId,
      details: { reason: input.reason },
    }),
  );
}
