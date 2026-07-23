import { keyedDigest } from "./crypto";
import { PluginAuthError } from "./errors";
import { canonicalizeIssuer } from "./oidc-validation";
import type {
  PluginAuthConfiguration,
  PluginPrincipalProfileSnapshot,
  PluginPrincipalRecord,
  VerifiedPluginIdentity,
} from "./types";

const MAX_PROFILE_DISPLAY_NAME_LENGTH = 256;
const MAX_PROFILE_AVATAR_URL_LENGTH = 2048;

function normalizeDisplayName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_PROFILE_DISPLAY_NAME_LENGTH
    ? normalized
    : null;
}

export function trustedAvatarUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_PROFILE_AVATAR_URL_LENGTH) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "https:" ? normalized : null;
  } catch {
    return null;
  }
}

function serializeProfileUpdatedAt(value: unknown): string | null {
  if (!(value instanceof Date)) return null;
  try {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? value.toISOString() : null;
  } catch {
    return null;
  }
}

export function pluginPrincipalProfile(
  principal: PluginPrincipalRecord,
): PluginPrincipalProfileSnapshot {
  return {
    email:
      typeof principal.email === "string" && principal.email.trim().length > 0
        ? principal.email.trim().toLowerCase()
        : null,
    display_name: normalizeDisplayName(principal.displayName),
    avatar_url: trustedAvatarUrl(principal.avatarUrl),
    profile_updated_at: serializeProfileUpdatedAt(principal.profileUpdatedAt),
  };
}

export function derivePluginPrincipalId(
  configuration: PluginAuthConfiguration,
  issuer: string,
  subject: string,
): string {
  return `pp_${keyedDigest(
    configuration.principalKeyPepper,
    "plugin-principal-v1",
    `${canonicalizeIssuer(issuer)}\u0000${subject}`,
  )}`;
}

export function assertPrincipalPepperConfiguration(input: {
  keyId: unknown;
  migrationMode: unknown;
}): void {
  if (
    typeof input.keyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(input.keyId) ||
    (input.migrationMode !== "disabled" && input.migrationMode !== "explicit")
  ) {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid principal pepper configuration");
  }
  if (input.keyId !== "v1" && input.migrationMode !== "explicit") {
    throw new PluginAuthError(
      "INVALID_REQUEST",
      "Principal pepper rotation requires explicit migration mode",
    );
  }
}

export function validateVerifiedIdentity(
  identity: VerifiedPluginIdentity,
  configuration: PluginAuthConfiguration,
): void {
  const emailParts = identity.email.trim().toLowerCase().split("@");
  const issuer = canonicalizeIssuer(identity.issuer);
  const allowedIssuers = configuration.allowedIssuers.map(canonicalizeIssuer);
  if (
    !allowedIssuers.includes(issuer) ||
    !identity.subject ||
    !identity.emailVerified ||
    emailParts.length !== 2 ||
    emailParts[1] !== configuration.companyDomain.toLowerCase()
  ) {
    throw new PluginAuthError(
      "COMPANY_IDENTITY_REJECTED",
      "Company account verification failed",
    );
  }
}

export function createOrRefreshPrincipal(input: {
  existing: PluginPrincipalRecord | undefined;
  identity: VerifiedPluginIdentity;
  configuration: PluginAuthConfiguration;
  now: Date;
}): PluginPrincipalRecord {
  validateVerifiedIdentity(input.identity, input.configuration);
  const issuer = canonicalizeIssuer(input.identity.issuer);
  const principalId = derivePluginPrincipalId(
    input.configuration,
    issuer,
    input.identity.subject,
  );
  if (input.existing) {
    if (
      input.existing.principalId !== principalId ||
      canonicalizeIssuer(input.existing.issuer) !== issuer ||
      input.existing.subject !== input.identity.subject
    ) {
      throw new PluginAuthError(
        "COMPANY_IDENTITY_REJECTED",
        "Company account verification failed",
      );
    }
    return {
      ...input.existing,
      issuer,
      email: input.identity.email.trim().toLowerCase(),
      displayName: normalizeDisplayName(input.identity.displayName),
      avatarUrl: trustedAvatarUrl(input.identity.avatarUrl),
      profileUpdatedAt: input.now,
    };
  }
  return {
    principalId,
    issuer,
    subject: input.identity.subject,
    email: input.identity.email.trim().toLowerCase(),
    displayName: normalizeDisplayName(input.identity.displayName),
    avatarUrl: trustedAvatarUrl(input.identity.avatarUrl),
    enabled: true,
    createdAt: input.now,
    profileUpdatedAt: input.now,
    disabledAt: null,
    disabledReason: null,
  };
}
