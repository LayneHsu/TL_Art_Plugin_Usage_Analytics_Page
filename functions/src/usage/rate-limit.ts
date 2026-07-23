import type { RateLimitConfiguration } from "./types";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly maxEntries = 10_000;

  public constructor(private readonly configuration: RateLimitConfiguration) {
    if (!Number.isFinite(configuration.capacity) || configuration.capacity <= 0 || !Number.isFinite(configuration.refillPerSecond) || configuration.refillPerSecond < 0) {
      throw new Error("Invalid rate limit configuration");
    }
  }

  public check(key: string, amount = 1, now = Date.now()): RateLimitDecision {
    for (const [candidate, bucket] of this.buckets) {
      if (now - bucket.at > 3_600_000) this.buckets.delete(candidate);
    }
    if (!this.buckets.has(key) && this.buckets.size >= this.maxEntries) {
      const oldest = [...this.buckets.entries()].sort((left, right) => left[1].at - right[1].at || left[0].localeCompare(right[0]))[0]?.[0];
      if (oldest) this.buckets.delete(oldest);
    }
    const bucket = this.buckets.get(key) ?? { tokens: this.configuration.capacity, at: now };
    bucket.tokens = Math.min(this.configuration.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.configuration.refillPerSecond);
    bucket.at = now;
    if (bucket.tokens < amount) {
      const missing = amount - bucket.tokens;
      const retryAfterSeconds = this.configuration.refillPerSecond > 0 ? Math.max(1, Math.ceil(missing / this.configuration.refillPerSecond)) : 60;
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterSeconds };
    }
    bucket.tokens -= amount;
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  public size(): number {
    return this.buckets.size;
  }
}
