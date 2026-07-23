export interface Clock {
  now(): Date;
}

export interface RandomSource {
  bytes(length: number): Buffer;
}

export interface PluginAuthConfiguration {
  companyDomain: string;
  allowedIssuers: string[];
  oauthAudience: string;
  allowedCallbackUris: string[];
  pairingTtlSeconds: number;
  pairingPollIntervalSeconds: number;
  rotationTtlSeconds: number;
  credentialPepper: string;
  credentialDeliveryKeys: {
    currentKeyId: string;
    verificationKeys: Record<string, string>;
  };
  principalKeyPepper: string;
  principalKeyId: string;
  principalPepperMigrationMode: "disabled" | "explicit";
  leaseIssuer: string;
  leaseAudience: string;
  leaseTtlSeconds: number;
  leaseClockSkewSeconds: number;
  leaseSigningKeys: {
    currentKeyId: string;
    verificationKeys: Record<string, string>;
  };
}

export interface VerifiedPluginIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface OidcExchangeRequest {
  authorizationCode: string;
  pkceVerifier: string;
  callbackUri: string;
  expectedNonce: string;
  expectedAudience: string;
  allowedIssuers: string[];
  companyDomain: string;
}

export interface PluginOidcExchange {
  exchangeAndVerify(
    request: OidcExchangeRequest,
  ): Promise<VerifiedPluginIdentity>;
}

export type PairingStatus =
  | "pending"
  | "browser_claim_started"
  | "verifying"
  | "authorized"
  | "consumed"
  | "cancelled"
  | "failed"
  | "expired";

export interface PluginPairingRecord {
  pairingId: string;
  pairingSecretDigest: string;
  deviceIdDigest: string;
  deviceChallengeDigest: string;
  clientVersion: string;
  callbackUri: string;
  status: PairingStatus;
  createdAt: Date;
  expiresAt: Date;
  nextPollAt: Date;
  stateDigest: string | null;
  nonce: string | null;
  pkceChallenge: string | null;
  pluginPrincipalId: string | null;
  deliveryBindingId: string | null;
  deliveryKeyId: string | null;
  deliveryNonce: string | null;
  deliveryExpiresAt: Date | null;
  deliveryAcknowledgedAt: Date | null;
}

export interface PluginPrincipalRecord {
  principalId: string;
  issuer: string;
  subject: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  enabled: boolean;
  createdAt: Date;
  profileUpdatedAt: Date;
  disabledAt: Date | null;
  disabledReason: string | null;
}

export interface PluginPrincipalProfileSnapshot {
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  profile_updated_at: string | null;
}

export interface PendingCredentialRotation {
  rotationId: string;
  credentialDigest: string;
  preparedAt: Date;
  expiresAt: Date;
}

export interface LastConfirmedCredentialRotation {
  rotationId: string;
  credentialDigest: string;
  confirmedAt: Date;
  replayExpiresAt: Date;
}

export interface PluginDeviceBindingRecord {
  bindingId: string;
  pluginPrincipalId: string;
  deviceIdDigest: string;
  credentialDigest: string;
  credentialVersion: number;
  clientVersion: string;
  createdAt: Date;
  lastVerifiedAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
  pendingRotation: PendingCredentialRotation | null;
  lastConfirmedRotation: LastConfirmedCredentialRotation | null;
}

export interface VerifiedPluginOpsIdentity {
  actorId: string;
  issuer: string;
  subject: string;
  email: string;
}

export type PluginOpsAction =
  | "revoke_binding"
  | "disable_principal"
  | "record_signing_key_rotation";

export type PluginOpsReviewStatus =
  | "requested"
  | "approved"
  | "executed"
  | "expired";

export interface PluginOpsReviewRecord {
  reviewId: string;
  action: PluginOpsAction;
  targetId: string;
  parameters: Record<string, string>;
  requesterActorId: string;
  approverActorId: string | null;
  status: PluginOpsReviewStatus;
  requestedAt: Date;
  approvedAt: Date | null;
  executedAt: Date | null;
  expiresAt: Date;
}

export type PluginAuditAction =
  | "pairing_created"
  | "pairing_claim_started"
  | "pairing_claimed"
  | "pairing_cancelled"
  | "binding_created"
  | "lease_issued"
  | "credential_rotation_prepared"
  | "credential_rotation_confirmed"
  | "credential_rotation_cancelled"
  | "binding_unlinked"
  | "binding_revoked"
  | "principal_disabled"
  | "signing_key_rotated"
  | "ops_review_requested"
  | "ops_review_approved"
  | "ops_review_executed"
  | "auth_denied";

export interface PluginAuthAuditRecord {
  auditId: string;
  occurredAt: Date;
  action: PluginAuditAction;
  outcome: "allowed" | "denied";
  pluginPrincipalId: string | null;
  bindingId: string | null;
  pairingId: string | null;
  actorId: string | null;
  reviewId: string | null;
  targetId: string | null;
  details: Record<string, string | number | boolean | null>;
}

export interface PluginAuthTransaction {
  getPairing(pairingId: string): Promise<PluginPairingRecord | undefined>;
  putPairing(record: PluginPairingRecord): Promise<void>;
  getPrincipal(
    principalId: string,
  ): Promise<PluginPrincipalRecord | undefined>;
  putPrincipal(record: PluginPrincipalRecord): Promise<void>;
  getBinding(bindingId: string): Promise<PluginDeviceBindingRecord | undefined>;
  putBinding(record: PluginDeviceBindingRecord): Promise<void>;
  getOpsReview(reviewId: string): Promise<PluginOpsReviewRecord | undefined>;
  putOpsReview(record: PluginOpsReviewRecord): Promise<void>;
  putAudit(record: PluginAuthAuditRecord): Promise<void>;
}

export interface PluginAuthStore {
  runTransaction<T>(
    handler: (transaction: PluginAuthTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface PluginLeaseClaims {
  version: 1;
  issuer: string;
  audience: string;
  keyId: string;
  jti: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
  bindingId: string;
  pluginPrincipalId: string;
}
