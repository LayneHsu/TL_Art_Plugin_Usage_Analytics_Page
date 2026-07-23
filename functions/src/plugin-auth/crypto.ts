import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { PluginAuthError } from "./errors";
import type {
  PluginAuthConfiguration,
  PluginLeaseClaims,
  RandomSource,
} from "./types";

export class SystemRandomSource implements RandomSource {
  public bytes(length: number): Buffer {
    return randomBytes(length);
  }
}

export function randomToken(
  random: RandomSource,
  prefix: string,
  byteLength = 32,
): string {
  return `${prefix}${random.bytes(byteLength).toString("base64url")}`;
}

export function keyedDigest(
  pepper: string,
  domain: string,
  value: string,
): string {
  return createHmac("sha256", pepper)
    .update(`${domain}\u0000${value}`)
    .digest("hex");
}

export function deriveDeliveryCredential(
  deliveryKey: string,
  bindingId: string,
  deliveryNonce: string,
): string {
  const value = createHmac("sha256", deliveryKey)
    .update(`initial-device-credential-v1\u0000${bindingId}\u0000${deliveryNonce}`)
    .digest("base64url");
  return `pdc_${value}`;
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

interface LeasePayload {
  ver: 1;
  iss: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  binding_id: string;
  plugin_principal_id: string;
}

export function signLeaseToken(
  claims: PluginLeaseClaims,
  signingKey: string,
): string {
  const header = encodeJson({ alg: "HS256", typ: "JWT", kid: claims.keyId });
  const payload = encodeJson({
    ver: claims.version,
    iss: claims.issuer,
    aud: claims.audience,
    jti: claims.jti,
    iat: claims.issuedAtSeconds,
    exp: claims.expiresAtSeconds,
    binding_id: claims.bindingId,
    plugin_principal_id: claims.pluginPrincipalId,
  } satisfies LeasePayload);
  const signature = createHmac("sha256", signingKey)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyLeaseToken(
  token: string,
  configuration: PluginAuthConfiguration,
  now = new Date(),
): PluginLeaseClaims {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new PluginAuthError("LEASE_INVALID", "Plugin lease is invalid");
  }
  try {
    const header = decodeJson<{ alg: string; typ: string; kid: string }>(segments[0]);
    if (header.alg !== "HS256" || header.typ !== "JWT") {
      throw new Error("unsupported lease header");
    }
    const signingKey = configuration.leaseSigningKeys.verificationKeys[header.kid];
    if (!signingKey) {
      throw new Error("unknown signing key");
    }
    const expectedSignature = createHmac("sha256", signingKey)
      .update(`${segments[0]}.${segments[1]}`)
      .digest("base64url");
    if (!safeEqual(expectedSignature, segments[2])) {
      throw new Error("invalid signature");
    }
    const payload = decodeJson<LeasePayload>(segments[1]);
    const clockSkewSeconds = configuration.leaseClockSkewSeconds;
    if (
      !Number.isSafeInteger(clockSkewSeconds) ||
      clockSkewSeconds < 0 ||
      clockSkewSeconds > 600 ||
      payload.ver !== 1 ||
      payload.iss !== configuration.leaseIssuer ||
      payload.aud !== configuration.leaseAudience ||
      !payload.jti ||
      !payload.binding_id ||
      !payload.plugin_principal_id ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 3600 ||
      payload.iat >
        Math.floor(now.getTime() / 1000) + clockSkewSeconds
    ) {
      throw new Error("invalid claims");
    }
    return {
      version: 1,
      issuer: payload.iss,
      audience: payload.aud,
      keyId: header.kid,
      jti: payload.jti,
      issuedAtSeconds: payload.iat,
      expiresAtSeconds: payload.exp,
      bindingId: payload.binding_id,
      pluginPrincipalId: payload.plugin_principal_id,
    };
  } catch (error) {
    if (error instanceof PluginAuthError) {
      throw error;
    }
    throw new PluginAuthError("LEASE_INVALID", "Plugin lease is invalid");
  }
}
