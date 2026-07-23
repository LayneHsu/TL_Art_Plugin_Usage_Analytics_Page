import { PluginAuthError } from "./errors";
import type { VerifiedPluginOpsIdentity } from "./types";

type HeaderValue = string | string[] | undefined;

interface PluginOpsIdentityVerifier {
  verify(token: string): Promise<VerifiedPluginOpsIdentity>;
}

function identityRequired(): PluginAuthError {
  return new PluginAuthError(
    "OPS_IDENTITY_REQUIRED",
    "Plugin operations identity is required",
  );
}

export function readPluginOpsBearerToken(headers: {
  authorization?: HeaderValue;
}): string {
  const authorization = headers.authorization;
  if (typeof authorization !== "string") {
    throw identityRequired();
  }
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  if (!match || match[1].length < 8 || match[1].length > 8192) {
    throw identityRequired();
  }
  return match[1];
}

export async function authenticatePluginOpsRequest(
  headers: Record<string, HeaderValue>,
  verifier: PluginOpsIdentityVerifier,
): Promise<VerifiedPluginOpsIdentity> {
  return verifier.verify(readPluginOpsBearerToken(headers));
}
