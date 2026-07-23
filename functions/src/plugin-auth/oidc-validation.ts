import { PluginAuthError } from "./errors";
import type { VerifiedPluginIdentity } from "./types";

interface OidcValidationExpectation {
  allowedIssuers: string[];
  audience: string;
  nonce: string;
  companyDomain: string;
}

export function canonicalizeIssuer(issuer: string): string {
  const normalized = issuer.trim().toLowerCase().replace(/\/+$/, "");
  return normalized === "accounts.google.com"
    ? "https://accounts.google.com"
    : normalized;
}

function rejectIdentity(): never {
  throw new PluginAuthError(
    "COMPANY_IDENTITY_REJECTED",
    "Company account verification failed",
  );
}

export function validateOidcClaims(
  claims: Record<string, unknown>,
  expected: OidcValidationExpectation,
): VerifiedPluginIdentity {
  const audience = claims.aud;
  const audienceMatches = Array.isArray(audience)
    ? audience.includes(expected.audience)
    : audience === expected.audience;
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  const emailParts = email.toLowerCase().split("@");
  const issuer = typeof claims.iss === "string" ? canonicalizeIssuer(claims.iss) : "";
  const allowedIssuers = expected.allowedIssuers.map(canonicalizeIssuer);
  if (
    !issuer ||
    !allowedIssuers.includes(issuer) ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    !audienceMatches ||
    claims.nonce !== expected.nonce ||
    claims.email_verified !== true ||
    emailParts.length !== 2 ||
    emailParts[1] !== expected.companyDomain.toLowerCase()
  ) {
    return rejectIdentity();
  }
  return {
    issuer,
    subject: claims.sub,
    email: email.toLowerCase(),
    emailVerified: true,
    displayName: typeof claims.name === "string" ? claims.name : null,
    avatarUrl: typeof claims.picture === "string" ? claims.picture : null,
  };
}
