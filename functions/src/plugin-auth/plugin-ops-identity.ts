import { OAuth2Client } from "google-auth-library";

import { PluginAuthError } from "./errors";
import type { VerifiedPluginOpsIdentity } from "./types";

interface PluginOpsClaimPolicy {
  audience: string;
  allowedIssuers: string[];
  allowedServiceAccounts: string[];
}

interface GoogleIdTokenVerifier {
  verifyIdToken(input: {
    idToken: string;
    audience: string;
  }): Promise<{ getPayload(): object | undefined }>;
}

function rejectIdentity(): never {
  throw new PluginAuthError(
    "OPS_IDENTITY_REQUIRED",
    "Plugin operations identity is required",
  );
}

function boundedClaim(
  claims: Record<string, unknown>,
  name: string,
  maximum: number,
): string {
  const value = claims[name];
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    return rejectIdentity();
  }
  return value;
}

export function verifyPluginOpsClaims(
  claims: Record<string, unknown>,
  policy: PluginOpsClaimPolicy,
): VerifiedPluginOpsIdentity {
  const issuer = boundedClaim(claims, "iss", 256);
  const subject = boundedClaim(claims, "sub", 256);
  const email = boundedClaim(claims, "email", 320).toLowerCase();
  const audience = claims.aud;
  const audienceMatches =
    audience === policy.audience ||
    (Array.isArray(audience) &&
      audience.length === 1 &&
      audience[0] === policy.audience);
  const allowedAccounts = new Set(
    policy.allowedServiceAccounts.map((value) => value.toLowerCase()),
  );
  if (
    !policy.allowedIssuers.includes(issuer) ||
    !audienceMatches ||
    claims.email_verified !== true ||
    !email.endsWith(".gserviceaccount.com") ||
    !allowedAccounts.has(email)
  ) {
    return rejectIdentity();
  }
  return {
    actorId: `serviceAccount:${email}`,
    issuer,
    subject,
    email,
  };
}

export class GooglePluginOpsTokenVerifier {
  private readonly tokenVerifier: GoogleIdTokenVerifier;

  public constructor(
    private readonly dependencies: PluginOpsClaimPolicy & {
      tokenVerifier?: GoogleIdTokenVerifier;
    },
  ) {
    this.tokenVerifier = dependencies.tokenVerifier ?? new OAuth2Client();
  }

  public async verify(bearerToken: string): Promise<VerifiedPluginOpsIdentity> {
    if (
      typeof bearerToken !== "string" ||
      bearerToken.length < 8 ||
      bearerToken.length > 8192
    ) {
      return rejectIdentity();
    }
    try {
      const ticket = await this.tokenVerifier.verifyIdToken({
        idToken: bearerToken,
        audience: this.dependencies.audience,
      });
      const payload = ticket.getPayload();
      if (!payload) {
        return rejectIdentity();
      }
      return verifyPluginOpsClaims(
        payload as Record<string, unknown>,
        this.dependencies,
      );
    } catch (error) {
      if (error instanceof PluginAuthError) {
        throw error;
      }
      return rejectIdentity();
    }
  }
}
