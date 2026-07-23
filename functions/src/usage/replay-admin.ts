import { createHash, randomBytes } from "node:crypto";

import { getApp, getApps, initializeApp } from "firebase-admin/app";
import type { DocumentData, Firestore } from "firebase-admin/firestore";
import { getFirestore } from "firebase-admin/firestore";
import type { Response } from "express";
import { onRequest, type Request } from "firebase-functions/v2/https";

import {
  createRuntimePluginOpsIdentityVerifier,
  requireHttps,
} from "../plugin-auth/endpoints";
import { PluginAuthError } from "../plugin-auth/errors";
import { authenticatePluginOpsRequest } from "../plugin-auth/plugin-ops-http";
import type { VerifiedPluginOpsIdentity } from "../plugin-auth/types";
import {
  FirestoreReplayService,
  ReplayOperationError,
  type FirestoreReplayRunResult,
} from "./firestore-replay";

const REVIEW_COLLECTION = "usageReplayApprovals";
const REVIEW_ID = /^replayrev_[A-Za-z0-9_-]{24}$/;
const REPLAY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GENERATION = /^[a-z][a-z0-9._-]{0,63}$/;
const REVIEW_TTL_MS = 10 * 60 * 1000;

type ReplayAdminAction = "run" | "rollback" | "finalize";
type ReplayReviewStatus = "requested" | "approved" | "executing" | "executed" | "failed";

interface ReplayRunPayload {
  replay_id: string;
  generation: string;
  from: string;
  to: string;
  cutover_scope: "global" | "partition";
  page_size: number;
  max_pages: number;
}

interface ReplayRollbackPayload {
  replay_id: string;
}

type ReplayAdminPayload = ReplayRunPayload | ReplayRollbackPayload;

interface ReplayApprovalDocument {
  review_id: string;
  action: ReplayAdminAction;
  payload: ReplayAdminPayload;
  payload_digest: string;
  requester_actor_id: string;
  approver_actor_id: string | null;
  executor_actor_id: string | null;
  status: ReplayReviewStatus;
  requested_at: Date;
  approved_at: Date | null;
  execution_started_at: Date | null;
  executed_at: Date | null;
  expires_at: Date;
  result_status: string | null;
}

interface ReplayRunner {
  run(input: {
    replayId: string;
    generation: string;
    from: Date;
    to: Date;
    ownerId: string;
    pageSize: number;
    maxPages: number;
    cutoverScope: "global" | "partition";
  }): Promise<FirestoreReplayRunResult | { status: string }>;
  rollback(input: {
    replayId: string;
    ownerId: string;
  }): Promise<FirestoreReplayRunResult | { status: string }>;
  finalize(input: {
    replayId: string;
    ownerId: string;
  }): Promise<FirestoreReplayRunResult | { status: string }>;
}

interface ReplayIdentityVerifier {
  verify(token: string): Promise<VerifiedPluginOpsIdentity>;
}

export class ReplayAdminError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReplayAdminError";
  }
}

function invalidRequest(): never {
  throw new ReplayAdminError("INVALID_REQUEST", 400, "Invalid replay request");
}

function assertServiceAccount(identity: VerifiedPluginOpsIdentity): void {
  const email = identity?.email?.toLowerCase();
  if (
    !identity ||
    !email?.endsWith(".gserviceaccount.com") ||
    identity.actorId !== `serviceAccount:${email}` ||
    !identity.issuer ||
    !identity.subject
  ) {
    throw new PluginAuthError(
      "OPS_IDENTITY_REQUIRED",
      "Plugin operations identity is required",
    );
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidRequest();
  }
}

function boundedString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalidRequest();
  return value;
}

function strictIso(value: unknown): string {
  if (typeof value !== "string") invalidRequest();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalidRequest();
  return value;
}

function boundedInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    invalidRequest();
  }
  return value as number;
}

function normalizePayload(action: ReplayAdminAction, value: unknown): ReplayAdminPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRequest();
  const payload = value as Record<string, unknown>;
  if (action === "rollback" || action === "finalize") {
    exactKeys(payload, ["replay_id"]);
    return { replay_id: boundedString(payload.replay_id, REPLAY_ID) };
  }
  exactKeys(payload, ["replay_id", "generation", "from", "to", "cutover_scope", "page_size", "max_pages"]);
  const from = strictIso(payload.from);
  const to = strictIso(payload.to);
  if (from >= to) invalidRequest();
  return {
    replay_id: boundedString(payload.replay_id, REPLAY_ID),
    generation: boundedString(payload.generation, GENERATION),
    from,
    to,
    cutover_scope: payload.cutover_scope === "global" || payload.cutover_scope === "partition"
      ? payload.cutover_scope
      : invalidRequest(),
    page_size: boundedInteger(payload.page_size, 200),
    max_pages: boundedInteger(payload.max_pages, 100),
  };
}

function payloadDigest(action: ReplayAdminAction, payload: ReplayAdminPayload): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, payload }))
    .digest("hex");
}

function actionField(value: unknown): ReplayAdminAction {
  if (value !== "run" && value !== "rollback" && value !== "finalize") invalidRequest();
  return value;
}

function reviewIdField(value: unknown): string {
  return boundedString(value, REVIEW_ID);
}

function asReview(data: DocumentData | undefined): ReplayApprovalDocument | undefined {
  return data as ReplayApprovalDocument | undefined;
}

function timestampMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    const date = (value as { toDate(): Date }).toDate();
    return date instanceof Date ? date.getTime() : Number.NaN;
  }
  return Number.NaN;
}

export class FirestoreReplayApprovalService {
  public constructor(
    private readonly firestore: Firestore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async request(input: {
    identity: VerifiedPluginOpsIdentity;
    action: ReplayAdminAction;
    payload: unknown;
  }): Promise<{ review_id: string; expires_at: string }> {
    assertServiceAccount(input.identity);
    const action = actionField(input.action);
    const payload = normalizePayload(action, input.payload);
    const now = this.clock();
    const reviewId = `replayrev_${randomBytes(18).toString("base64url")}`;
    const record: ReplayApprovalDocument = {
      review_id: reviewId,
      action,
      payload,
      payload_digest: payloadDigest(action, payload),
      requester_actor_id: input.identity.actorId,
      approver_actor_id: null,
      executor_actor_id: null,
      status: "requested",
      requested_at: now,
      approved_at: null,
      execution_started_at: null,
      executed_at: null,
      expires_at: new Date(now.getTime() + REVIEW_TTL_MS),
      result_status: null,
    };
    await this.firestore.collection(REVIEW_COLLECTION).doc(reviewId).create(record);
    return { review_id: reviewId, expires_at: record.expires_at.toISOString() };
  }

  public async approve(input: {
    identity: VerifiedPluginOpsIdentity;
    reviewId: string;
  }): Promise<void> {
    assertServiceAccount(input.identity);
    const reviewId = reviewIdField(input.reviewId);
    const reference = this.firestore.collection(REVIEW_COLLECTION).doc(reviewId);
    const approved = await this.firestore.runTransaction(async (transaction) => {
      const review = asReview((await transaction.get(reference)).data());
      const now = this.clock();
      if (
        !review ||
        review.status !== "requested" ||
        review.requester_actor_id === input.identity.actorId ||
        timestampMillis(review.expires_at) <= now.getTime()
      ) {
        return false;
      }
      transaction.update(reference, {
        status: "approved",
        approver_actor_id: input.identity.actorId,
        approved_at: now,
      });
      return true;
    });
    if (!approved) {
      throw new ReplayAdminError(
        "REPLAY_APPROVAL_REQUIRED",
        403,
        "A separate replay approval is required",
      );
    }
  }

  public async execute(input: {
    identity: VerifiedPluginOpsIdentity;
    reviewId: string;
    action: ReplayAdminAction;
    payload: unknown;
    replay: ReplayRunner;
  }): Promise<FirestoreReplayRunResult | { status: string }> {
    assertServiceAccount(input.identity);
    const reviewId = reviewIdField(input.reviewId);
    const action = actionField(input.action);
    const payload = normalizePayload(action, input.payload);
    const digest = payloadDigest(action, payload);
    const reference = this.firestore.collection(REVIEW_COLLECTION).doc(reviewId);
    const claimed = await this.firestore.runTransaction(async (transaction) => {
      const review = asReview((await transaction.get(reference)).data());
      const now = this.clock();
      if (
        !review ||
        review.status !== "approved" ||
        !review.approver_actor_id ||
        timestampMillis(review.expires_at) <= now.getTime() ||
        review.action !== action ||
        review.payload_digest !== digest
      ) {
        return false;
      }
      transaction.update(reference, {
        status: "executing",
        executor_actor_id: input.identity.actorId,
        execution_started_at: now,
      });
      return true;
    });
    if (!claimed) {
      throw new ReplayAdminError(
        "REPLAY_REVIEW_UNAVAILABLE",
        409,
        "Replay review is unavailable",
      );
    }

    try {
      const result = action === "run"
        ? await input.replay.run({
          replayId: payload.replay_id,
          generation: (payload as ReplayRunPayload).generation,
          from: new Date((payload as ReplayRunPayload).from),
          to: new Date((payload as ReplayRunPayload).to),
          ownerId: reviewId,
          pageSize: (payload as ReplayRunPayload).page_size,
          maxPages: (payload as ReplayRunPayload).max_pages,
          cutoverScope: (payload as ReplayRunPayload).cutover_scope,
        })
        : action === "rollback"
          ? await input.replay.rollback({
            replayId: payload.replay_id,
            ownerId: reviewId,
          })
          : await input.replay.finalize({
            replayId: payload.replay_id,
            ownerId: reviewId,
          });
      await reference.update({
        status: "executed",
        executed_at: this.clock(),
        result_status: result.status,
      });
      return result;
    } catch (error) {
      await this.firestore.runTransaction(async (transaction) => {
        const review = asReview((await transaction.get(reference)).data());
        if (review?.status === "executing") {
          transaction.update(reference, {
            status: "failed",
            executed_at: this.clock(),
            result_status: error instanceof ReplayOperationError ? error.code : "operation_failed",
          });
        }
      });
      throw error;
    }
  }
}

function readBody(request: Request): Record<string, unknown> {
  if (
    !request.is("application/json") ||
    (request.rawBody?.byteLength ?? 0) > 16_384 ||
    !request.body ||
    typeof request.body !== "object" ||
    Array.isArray(request.body)
  ) {
    invalidRequest();
  }
  return request.body as Record<string, unknown>;
}

function publicError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ReplayAdminError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof PluginAuthError) {
    return {
      status: error.code === "OPS_IDENTITY_REQUIRED" ? 401 : 400,
      code: error.code,
      message: error.publicMessage,
    };
  }
  if (error instanceof ReplayOperationError) {
    return { status: 409, code: error.code, message: error.message };
  }
  return { status: 503, code: "REPLAY_OPERATION_FAILED", message: "Replay operation failed" };
}

export function createReplayAdminEndpointHandler(input: {
  approvals: FirestoreReplayApprovalService;
  verifier: ReplayIdentityVerifier;
  replay: ReplayRunner;
}): (request: Request, response: Response) => Promise<void> {
  return async (request, response) => {
    try {
      requireHttps(request);
      if (request.method !== "POST") invalidRequest();
      const identity = await authenticatePluginOpsRequest(request.headers, input.verifier);
      const body = readBody(request);
      const operation = body.operation;
      if (operation === "request") {
        exactKeys(body, ["operation", "action", "payload"]);
        const result = await input.approvals.request({
          identity,
          action: actionField(body.action),
          payload: body.payload,
        });
        response.status(200).json({ ok: true, result });
        return;
      }
      if (operation === "approve") {
        exactKeys(body, ["operation", "review_id"]);
        await input.approvals.approve({
          identity,
          reviewId: reviewIdField(body.review_id),
        });
        response.status(200).json({ ok: true, result: { status: "approved" } });
        return;
      }
      if (operation === "run" || operation === "rollback" || operation === "finalize") {
        exactKeys(body, ["operation", "review_id", "payload"]);
        const result = await input.approvals.execute({
          identity,
          reviewId: reviewIdField(body.review_id),
          action: operation,
          payload: body.payload,
          replay: input.replay,
        });
        response.status(200).json({ ok: true, result });
        return;
      }
      invalidRequest();
    } catch (error) {
      const failure = publicError(error);
      response.status(failure.status).json({
        ok: false,
        error: { code: failure.code, message: failure.message },
      });
    }
  };
}

function runtimeHandler() {
  const app = getApps().length > 0 ? getApp() : initializeApp();
  const firestore = getFirestore(app);
  return createReplayAdminEndpointHandler({
    approvals: new FirestoreReplayApprovalService(firestore),
    verifier: createRuntimePluginOpsIdentityVerifier(),
    replay: new FirestoreReplayService({ firestore }),
  });
}

export const usageReplayAdmin = onRequest(
  {
    timeoutSeconds: 540,
    memory: "512MiB",
    cors: false,
    invoker: "private",
  },
  async (request, response) => {
    await runtimeHandler()(request, response);
  },
);
