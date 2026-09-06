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

/**
 * Test-only: real, live test-isolation bug this closes, same shape as crewRecommendations.ts's
 * own `__resetSystemUserCacheForTests` — this module's buckets are keyed by IP/email and live for
 * the whole process, so they survive `resetDatabase()` between tests. Every `app.inject` call in
 * a test file shares one synthetic IP, and the real, deliberate 20-requests/15-minute
 * `magic-link-ip` budget (src/services/auth.ts) is exactly the kind of thing a growing
 * integration-test file (each test logging in its own fresh users to keep DB state isolated) can
 * legitimately exceed on its own — not a bug in what's being tested, just two real budgets (DB
 * isolation vs. IP rate limit) colliding. Called from resetDb.ts's own `resetDatabase()` so every
 * test file gets a clean rate-limit slate for free, the same way it already gets a clean database.
 */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}

// Periodically sweep stale buckets so this doesn't grow unboundedly on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStartedAt > 10 * 60 * 1000) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();
