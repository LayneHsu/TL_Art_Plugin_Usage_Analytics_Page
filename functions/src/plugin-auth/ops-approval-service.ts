import { createAuditRecord } from "./audit";
import { randomToken } from "./crypto";
import { PluginAuthError } from "./errors";
import { auditDenied, requireBoundedString } from "./service-helpers";
import type {
  Clock,
  PluginAuthStore,
  PluginAuthTransaction,
  PluginOpsAction,
  PluginOpsReviewRecord,
  RandomSource,
  VerifiedPluginOpsIdentity,
} from "./types";

interface OpsApprovalDependencies {
  store: PluginAuthStore;
  clock: Clock;
  random: RandomSource;
  reviewTtlSeconds: number;
  leaseSigningKeyMetadata: {
    currentKeyId: string;
    verificationKeyIds: readonly string[];
  };
}

const allowedReasonCodes = new Set([
  "lost_device",
  "portal_role_changed",
  "employment_ended",
]);

const bindingIdPattern = /^bind_[A-Za-z0-9_-]{24}$/;
const principalIdPattern = /^pp_[a-f0-9]{64}$/;
const reviewIdPattern = /^opsrev_[A-Za-z0-9_-]{24}$/;
const signingKeyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function invalidRequest(message: string): never {
  throw new PluginAuthError("INVALID_REQUEST", message);
}

function requireReviewId(value: string): string {
  if (typeof value !== "string" || !reviewIdPattern.test(value)) {
    invalidRequest("Invalid operation review ID");
  }
  return value;
}

function immutableTarget(action: PluginOpsAction, value: string): string {
  if (typeof value !== "string") {
    invalidRequest("Invalid operation target");
  }
  if (action === "revoke_binding" && bindingIdPattern.test(value)) {
    return value;
  }
  if (action === "disable_principal" && principalIdPattern.test(value)) {
    return value;
  }
  if (action === "record_signing_key_rotation" && value === "lease-signing-keys") {
    return value;
  }
  invalidRequest("Invalid operation target");
}

function requireIdentity(identity: VerifiedPluginOpsIdentity): void {
  const expectedActor = `serviceAccount:${identity?.email?.toLowerCase()}`;
  if (
    !identity ||
    !identity.issuer ||
    !identity.subject ||
    !identity.email?.endsWith(".gserviceaccount.com") ||
    identity.actorId !== expectedActor
  ) {
    throw new PluginAuthError(
      "OPS_IDENTITY_REQUIRED",
      "Plugin operations identity is required",
    );
  }
}

function immutableParameters(
  action: PluginOpsAction,
  input: Record<string, string>,
  leaseSigningKeyMetadata: OpsApprovalDependencies["leaseSigningKeyMetadata"],
): Record<string, string> {
  if (
    action !== "revoke_binding" &&
    action !== "disable_principal" &&
    action !== "record_signing_key_rotation"
  ) {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid plugin operation");
  }
  const keys = Object.keys(input).sort();
  if (action === "revoke_binding" || action === "disable_principal") {
    if (keys.length !== 1 || keys[0] !== "reason") {
      throw new PluginAuthError("INVALID_REQUEST", "Invalid operation parameters");
    }
    const reason = requireBoundedString(input.reason, "reason", 1, 64);
    if (!allowedReasonCodes.has(reason)) {
      throw new PluginAuthError("INVALID_REQUEST", "Invalid operation reason");
    }
    return { reason };
  }
  if (
    keys.length !== 2 ||
    keys[0] !== "current_key_id" ||
    keys[1] !== "previous_key_id"
  ) {
    throw new PluginAuthError("INVALID_REQUEST", "Invalid operation parameters");
  }
  const previousKeyId = input.previous_key_id;
  const currentKeyId = input.current_key_id;
  const knownKeyIds = new Set(leaseSigningKeyMetadata.verificationKeyIds);
  if (
    typeof previousKeyId !== "string" ||
    typeof currentKeyId !== "string" ||
    !signingKeyIdPattern.test(previousKeyId) ||
    !signingKeyIdPattern.test(currentKeyId) ||
    previousKeyId === currentKeyId ||
    !knownKeyIds.has(previousKeyId) ||
    !knownKeyIds.has(currentKeyId) ||
    currentKeyId !== leaseSigningKeyMetadata.currentKeyId
  ) {
    invalidRequest("Invalid signing key transition");
  }
  return {
    previous_key_id: previousKeyId,
    current_key_id: currentKeyId,
  };
}

export class PluginOpsApprovalService {
  public constructor(private readonly dependencies: OpsApprovalDependencies) {
    if (
      !Number.isSafeInteger(dependencies.reviewTtlSeconds) ||
      dependencies.reviewTtlSeconds < 30 ||
      dependencies.reviewTtlSeconds > 3600
    ) {
      throw new Error("Invalid plugin ops review TTL");
    }
    const knownKeyIds = dependencies.leaseSigningKeyMetadata.verificationKeyIds;
    if (
      !signingKeyIdPattern.test(
        dependencies.leaseSigningKeyMetadata.currentKeyId,
      ) ||
      !knownKeyIds.includes(
        dependencies.leaseSigningKeyMetadata.currentKeyId,
      ) ||
      knownKeyIds.some((keyId) => !signingKeyIdPattern.test(keyId))
    ) {
      throw new Error("Invalid plugin ops lease signing key metadata");
    }
  }

  public async request(input: {
    identity: VerifiedPluginOpsIdentity;
    action: PluginOpsAction;
    targetId: string;
    parameters: Record<string, string>;
  }): Promise<{ reviewId: string; expiresAt: Date }> {
    requireIdentity(input.identity);
    const targetId = immutableTarget(input.action, input.targetId);
    const parameters = immutableParameters(
      input.action,
      input.parameters,
      this.dependencies.leaseSigningKeyMetadata,
    );
    const now = this.dependencies.clock.now();
    const review: PluginOpsReviewRecord = {
      reviewId: randomToken(this.dependencies.random, "opsrev_", 18),
      action: input.action,
      targetId,
      parameters,
      requesterActorId: input.identity.actorId,
      approverActorId: null,
      status: "requested",
      requestedAt: now,
      approvedAt: null,
      executedAt: null,
      expiresAt: new Date(
        now.getTime() + this.dependencies.reviewTtlSeconds * 1000,
      ),
    };
    await this.dependencies.store.runTransaction(async (transaction) => {
      await transaction.putOpsReview(review);
      await transaction.putAudit(
        createAuditRecord({
          ...this.auditDependencies(),
          action: "ops_review_requested",
          actorId: input.identity.actorId,
          reviewId: review.reviewId,
          targetId: review.targetId,
          details: { operation: review.action },
        }),
      );
    });
    return { reviewId: review.reviewId, expiresAt: review.expiresAt };
  }

  public async approve(input: {
    identity: VerifiedPluginOpsIdentity;
    reviewId: string;
  }): Promise<void> {
    requireIdentity(input.identity);
    const reviewId = requireReviewId(input.reviewId);
    const accepted = await this.dependencies.store.runTransaction(
      async (transaction) => {
        const review = await transaction.getOpsReview(reviewId);
        const now = this.dependencies.clock.now();
        if (
          !review ||
          review.status !== "requested" ||
          review.expiresAt.getTime() <= now.getTime() ||
          review.requesterActorId === input.identity.actorId
        ) {
          if (review && review.expiresAt.getTime() <= now.getTime()) {
            review.status = "expired";
            await transaction.putOpsReview(review);
          }
          await this.auditReviewDenied(
            transaction,
            input.identity.actorId,
            reviewId,
            "ops_review_approval_denied",
          );
          return false;
        }
        review.status = "approved";
        review.approverActorId = input.identity.actorId;
        review.approvedAt = now;
        await transaction.putOpsReview(review);
        await transaction.putAudit(
          createAuditRecord({
            ...this.auditDependencies(),
            action: "ops_review_approved",
            actorId: input.identity.actorId,
            reviewId: review.reviewId,
            targetId: review.targetId,
            details: { operation: review.action },
          }),
        );
        return true;
      },
    );
    if (!accepted) {
      throw new PluginAuthError(
        "OPS_APPROVAL_REQUIRED",
        "A separate plugin operations approval is required",
      );
    }
  }

  public async execute(input: {
    identity: VerifiedPluginOpsIdentity;
    reviewId: string;
  }): Promise<void> {
    requireIdentity(input.identity);
    const reviewId = requireReviewId(input.reviewId);
    const executed = await this.dependencies.store.runTransaction(
      async (transaction) => {
        const review = await transaction.getOpsReview(reviewId);
        const now = this.dependencies.clock.now();
        if (
          !review ||
          review.status !== "approved" ||
          !review.approverActorId ||
          review.expiresAt.getTime() <= now.getTime()
        ) {
          if (review && review.expiresAt.getTime() <= now.getTime()) {
            review.status = "expired";
            await transaction.putOpsReview(review);
          }
          await this.auditReviewDenied(
            transaction,
            input.identity.actorId,
            reviewId,
            "ops_review_execute_denied",
          );
          return false;
        }
        const applied = await this.applyStoredOperation(transaction, review, now);
        if (!applied) {
          await this.auditReviewDenied(
            transaction,
            input.identity.actorId,
            input.reviewId,
            "ops_review_target_unavailable",
          );
          return false;
        }
        review.status = "executed";
        review.executedAt = now;
        await transaction.putOpsReview(review);
        await transaction.putAudit(
          createAuditRecord({
            ...this.auditDependencies(),
            action: "ops_review_executed",
            actorId: input.identity.actorId,
            reviewId: review.reviewId,
            targetId: review.targetId,
            details: { operation: review.action },
          }),
        );
        return true;
      },
    );
    if (!executed) {
      throw new PluginAuthError(
        "OPS_REVIEW_UNAVAILABLE",
        "Plugin operation review is unavailable",
      );
    }
  }

  private async applyStoredOperation(
    transaction: PluginAuthTransaction,
    review: PluginOpsReviewRecord,
    now: Date,
  ): Promise<boolean> {
    if (review.action === "revoke_binding") {
      const binding = await transaction.getBinding(review.targetId);
      if (!binding || binding.revokedAt) {
        return false;
      }
      binding.revokedAt = now;
      binding.revocationReason = review.parameters.reason;
      binding.pendingRotation = null;
      await transaction.putBinding(binding);
      await transaction.putAudit(
        createAuditRecord({
          ...this.auditDependencies(),
          action: "binding_revoked",
          bindingId: binding.bindingId,
          pluginPrincipalId: binding.pluginPrincipalId,
          actorId: review.requesterActorId,
          reviewId: review.reviewId,
          targetId: binding.bindingId,
          details: { reason: review.parameters.reason },
        }),
      );
      return true;
    }
    if (review.action === "disable_principal") {
      const principal = await transaction.getPrincipal(review.targetId);
      if (!principal || !principal.enabled) {
        return false;
      }
      principal.enabled = false;
      principal.disabledAt = now;
      principal.disabledReason = review.parameters.reason;
      await transaction.putPrincipal(principal);
      await transaction.putAudit(
        createAuditRecord({
          ...this.auditDependencies(),
          action: "principal_disabled",
          pluginPrincipalId: principal.principalId,
          actorId: review.requesterActorId,
          reviewId: review.reviewId,
          targetId: principal.principalId,
          details: { reason: review.parameters.reason },
        }),
      );
      return true;
    }
    await transaction.putAudit(
      createAuditRecord({
        ...this.auditDependencies(),
        action: "signing_key_rotated",
        actorId: review.requesterActorId,
        reviewId: review.reviewId,
        targetId: review.targetId,
        details: {
          previous_key_id: review.parameters.previous_key_id,
          current_key_id: review.parameters.current_key_id,
        },
      }),
    );
    return true;
  }

  private async auditReviewDenied(
    transaction: PluginAuthTransaction,
    actorId: string,
    reviewId: string,
    reason: string,
  ): Promise<void> {
    await auditDenied(transaction, this.auditDependencies(), {
      actorId,
      reviewId,
      reason,
    });
  }

  private auditDependencies() {
    return {
      clock: this.dependencies.clock,
      random: this.dependencies.random,
    };
  }
}
