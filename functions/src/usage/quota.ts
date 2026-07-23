import { createHash } from "node:crypto";

import type { Firestore } from "firebase-admin/firestore";

export interface UsageQuotaDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface UsageQuota {
  consume(input: { bindingId: string; pluginPrincipalId: string; eventCount: number; now: Date }): Promise<UsageQuotaDecision>;
}

export class FirestoreUsageQuota implements UsageQuota {
  public constructor(private readonly firestore: Firestore, private readonly limits = { eventsPerMinute: 500, requestsPerMinute: 120 }) {}

  public async consume(input: { bindingId: string; pluginPrincipalId: string; eventCount: number; now: Date }): Promise<UsageQuotaDecision> {
    const minute = Math.floor(input.now.getTime() / 60_000);
    const bucketStart = new Date(minute * 60_000);
    const identityHash = createHash("sha256").update(`${input.pluginPrincipalId}\u0000${input.bindingId}`).digest("hex");
    const id = `${minute}_${identityHash}`;
    const reference = this.firestore.collection("usageQuotas").doc(id);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const current = snapshot.exists ? snapshot.data() ?? {} : {};
      const events = Number(current.events ?? 0);
      const requests = Number(current.requests ?? 0);
      const allowed = events + input.eventCount <= this.limits.eventsPerMinute && requests + 1 <= this.limits.requestsPerMinute;
      transaction.set(reference, {
        events: allowed ? events + input.eventCount : events,
        requests: allowed ? requests + 1 : requests,
        minute,
        bucket_start: bucketStart,
        expires_at: new Date((minute + 1) * 60_000),
        identity_hash: identityHash,
      }, { merge: true });
      return { allowed, retryAfterSeconds: allowed ? 0 : Math.max(1, 60 - Math.floor((input.now.getTime() % 60_000) / 1000)) };
    });
  }
}

export class InMemoryUsageQuota implements UsageQuota {
  private readonly counters = new Map<string, { events: number; requests: number }>();
  public constructor(private readonly limits = { eventsPerMinute: 500, requestsPerMinute: 120 }) {}

  public async consume(input: { bindingId: string; pluginPrincipalId: string; eventCount: number; now: Date }): Promise<UsageQuotaDecision> {
    const key = `${Math.floor(input.now.getTime() / 60_000)}:${input.pluginPrincipalId}:${input.bindingId}`;
    const current = this.counters.get(key) ?? { events: 0, requests: 0 };
    if (current.events + input.eventCount > this.limits.eventsPerMinute || current.requests + 1 > this.limits.requestsPerMinute) {
      this.counters.set(key, current);
      return { allowed: false, retryAfterSeconds: 1 };
    }
    current.events += input.eventCount;
    current.requests += 1;
    this.counters.set(key, current);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
