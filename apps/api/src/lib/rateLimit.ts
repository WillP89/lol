/**
 * In-memory sliding-window rate limiter.
 *
 * Deliberately not Redis-backed: the pilot runs as a single API instance, and an in-memory
 * limiter is zero-dependency and easy to reason about. It stops working correctly the moment
 * we run more than one instance behind a load balancer (each instance has its own counts) —
 * that's the explicit trigger to swap this for a Redis-backed limiter (see
 * docs/DECISIONS.md#rate-limiting). Do not scale the API horizontally without doing that first.
 */

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();

export function isRateLimited(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStartedAt > windowMs) {
    buckets.set(key, { count: 1, windowStartedAt: now });
    return false;
  }

  existing.count += 1;
  return existing.count > maxRequests;
}

// Periodically sweep stale buckets so this doesn't grow unboundedly on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStartedAt > 10 * 60 * 1000) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();
