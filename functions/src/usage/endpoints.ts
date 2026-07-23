import type { Response } from "express";
import { createHash } from "node:crypto";
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest, type Request } from "firebase-functions/v2/https";

import { createRuntimePluginAuthDecisionService, pluginAuthRuntimeSecrets, recordRuntimePluginAuthFailure, requireHttps } from "../plugin-auth/endpoints";
import { PluginAuthError, pluginAuthHttpStatus } from "../plugin-auth/errors";
import { assertPluginEndpointHeaders } from "../plugin-auth/http-boundary";
import { UsageIngestionError, UsageIngestionService } from "./ingestion";
import { FirestoreUsageStore } from "./store";
import { FirestoreUsageQuota } from "./quota";
import { TokenBucketRateLimiter } from "./rate-limit";
import { FirestoreMonitoringService } from "./monitoring-firestore";
import { assertBundledRegistry, BUNDLED_TOOL_REGISTRY } from "./contract-artifacts";

class RuntimeClock {
  public now(): Date {
    return new Date();
  }
}

const sourceLimiter = new TokenBucketRateLimiter({ capacity: 120, refillPerSecond: 2 });
let cachedRuntimeService: UsageIngestionService | undefined;

function runtimeRegistry() {
  return assertBundledRegistry(BUNDLED_TOOL_REGISTRY);
}

function runtimeIngestionService(): UsageIngestionService {
  if (cachedRuntimeService) return cachedRuntimeService;
  const app = getApps().length > 0 ? getApp() : initializeApp();
  const firestore = getFirestore(app);
  const monitoring = new FirestoreMonitoringService(firestore);
  cachedRuntimeService = new UsageIngestionService({
    auth: createRuntimePluginAuthDecisionService(),
    store: new FirestoreUsageStore(firestore, {
      onCommittedWrites: async (count) => {
        await monitoring.incrementCounter("firestore_writes", count, new Date());
      },
    }),
    quota: new FirestoreUsageQuota(firestore),
    clock: new RuntimeClock(),
    registry: runtimeRegistry(),
  });
  return cachedRuntimeService;
}

function requestBody(request: Request): unknown {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new UsageIngestionError("invalid_request", false, "Invalid ingestion request");
  }
  return request.body;
}

export function createUsageIngestionEndpointHandler(service: UsageIngestionService, hooks: {
  recordAuthFailure?: (reason: string) => Promise<void>;
  monitoring?: FirestoreMonitoringService;
  clock?: () => Date;
} = {}) {
  return async (request: Request, response: Response): Promise<void> => {
    const recordCounter = async (name: string, delta = 1): Promise<void> => {
      if (!hooks.monitoring || delta <= 0) return;
      try {
        await hooks.monitoring.incrementCounter(name, delta, hooks.clock?.() ?? new Date());
      } catch {
        // Monitoring is best-effort and must not change an ingestion decision.
      }
    };
    try {
      if (request.method !== "POST") {
        throw new UsageIngestionError("invalid_request", false, "POST is required");
      }
      await recordCounter("ingestion_requests");
      requireHttps(request);
      const source = request.ip || request.get("x-forwarded-for") || "unknown";
      const sourceKey = createHash("sha256").update(source.slice(0, 256)).digest("hex");
      const sourceDecision = sourceLimiter.check(sourceKey);
      if (!sourceDecision.allowed) {
        response.set("Retry-After", String(sourceDecision.retryAfterSeconds));
        response.status(429).json({ ok: false, error: { code: "rate_limited", message: "Request rate exceeded", retry_after_seconds: sourceDecision.retryAfterSeconds } });
        return;
      }
      assertPluginEndpointHeaders(request.headers);
      if ((request.rawBody?.byteLength ?? 0) > 524_288 || !request.is("application/json")) {
        throw new UsageIngestionError("invalid_request", false, "Invalid ingestion request body");
      }
      const result = await service.ingestBatch(requestBody(request) as never);
      await recordCounter("accepted_events", result.accepted);
      await recordCounter("permanent_rejections", result.permanent_rejected);
      await recordCounter("retryable_events", result.retryable);
      const onlyRateLimited = result.results.length > 0 && result.results.every((item) => item.code === "rate_limited" || item.code === "quota_exceeded");
      const onlyTransient = result.results.length > 0 && result.results.every((item) => item.status === "retryable");
      const retryAfter = Math.max(...result.results.map((item) => item.retry_after_seconds ?? 0));
      if (retryAfter > 0) response.set("Retry-After", String(retryAfter));
      response.status(onlyRateLimited ? 429 : onlyTransient ? 503 : 200).json({ ok: true, result });
    } catch (error) {
      if (error instanceof PluginAuthError) {
        await recordCounter("auth_failures");
        try {
          await hooks.recordAuthFailure?.(`ingestion_${error.code.toLowerCase()}`);
        } catch {
          // Audit failure must preserve the original authentication denial.
        }
        response.status(pluginAuthHttpStatus(error)).json({ ok: false, error: { code: error.code, message: error.publicMessage } });
        return;
      }
      const ingestionError = error instanceof UsageIngestionError ? error : new UsageIngestionError("server_error", true, "Ingestion could not be completed");
      if (ingestionError.code === "batch_too_large") {
        response.status(413).json({ ok: false, error: { code: ingestionError.code, message: ingestionError.message, max_batch_size: 100, split_required: true } });
        return;
      }
      response.status(ingestionError.retryable ? 503 : 400).json({
        ok: false,
        error: { code: ingestionError.code, message: ingestionError.message },
      });
    }
  };
}

// Production wiring is injected by the deployment composition root after the
// registry, lease configuration and Firestore Admin client are loaded.
export const usageIngest = onRequest(
  {
    timeoutSeconds: 30,
    memory: "256MiB" as const,
    cors: false,
    secrets: pluginAuthRuntimeSecrets,
  },
  async (request, response) => {
    try {
      const app = getApps().length > 0 ? getApp() : initializeApp();
      const firestore = getFirestore(app);
      const monitoring = new FirestoreMonitoringService(firestore);
      await createUsageIngestionEndpointHandler(runtimeIngestionService(), {
        monitoring,
        recordAuthFailure: async (reason) => {
          await recordRuntimePluginAuthFailure(reason);
        },
      })(request, response);
    } catch {
      response.status(503).json({ ok: false, error: { code: "not_configured", message: "Usage ingestion is not configured" } });
    }
  },
);
