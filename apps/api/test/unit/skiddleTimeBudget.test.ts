import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Regression coverage for a real live bug: Skiddle's own `eventcode` query param only accepts
 * one value per request, so `fetchListings` makes up to 7 sequential category requests — and
 * with `withRetry`'s DEFAULT budget (3 attempts x 8s timeout each), one slow/unresponsive
 * category could cost ~24s, times 7 categories, sequentially, inside `ensureInventory` — which
 * the whole request-serving path (Explore, crew recommendations) awaits synchronously. That's
 * 170+ seconds of possible added latency to a single page load, and is exactly what broke
 * Discover the moment SKIDDLE_API_KEY was first configured live. See skiddle.ts's own
 * PER_CATEGORY_RETRY/OVERALL_BUDGET_MS comments for the fix this proves.
 *
 * Isolated into its own file (rather than skiddle.test.ts) because it needs to mock
 * lib/config's SKIDDLE_API_KEY and lib/retry's withRetry — mocks that would otherwise leak into
 * skiddle.test.ts's own "no key configured" assertions.
 */
vi.mock('../../src/lib/config', () => ({ config: { SKIDDLE_API_KEY: 'test-key' } }));

const withRetryCalls: Array<{ attempts?: number; timeoutMs?: number }> = [];
vi.mock('../../src/lib/retry', () => ({
  // Deliberately never invokes `fn` — this adapter's `fetchOneCategory` makes a real
  // `fetch()` call to www.skiddle.com, and this test suite must stay network-free (same
  // convention providers/live/openStreetMap.ts documents for its own tests). Only the options
  // passed to withRetry and the number of times it's called are under test here.
  withRetry: vi.fn(async (_fn: (signal: AbortSignal) => Promise<unknown>, options: { attempts?: number; timeoutMs?: number } = {}) => {
    withRetryCalls.push(options);
    return [];
  }),
}));

describe('skiddleProvider.fetchListings time budget', () => {
  beforeEach(() => {
    withRetryCalls.length = 0;
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('every per-category call uses a fast-fail budget, not withRetry\'s default 3x8s', async () => {
    const { skiddleProvider } = await import('../../src/providers/live/skiddle');
    await skiddleProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });

    expect(withRetryCalls.length).toBeGreaterThan(0);
    for (const options of withRetryCalls) {
      // The regression this guards: withRetry's own defaults are attempts=3, timeoutMs=8000 —
      // asserting strictly less than that default proves this adapter passes its own tighter
      // budget rather than silently falling back to it.
      expect(options.attempts ?? 3).toBeLessThan(3);
      expect(options.timeoutMs ?? 8000).toBeLessThanOrEqual(6000);
    }
  });

  test('stops issuing further category requests once the overall time budget is spent', async () => {
    // Real elapsed time, not simulated — withRetry is mocked to resolve instantly, so this
    // exercises the actual Date.now()-based budget check in fetchListings without needing fake
    // timers. jumpingClock makes each Date.now() call appear to advance by 3s, so by the 5th or
    // 6th (of 7) category the loop's own budget check sees >15s elapsed and stops early — while
    // the test itself still finishes in milliseconds of real wall-clock time.
    let simulatedNow = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      simulatedNow += 3000;
      return simulatedNow;
    });

    const { skiddleProvider } = await import('../../src/providers/live/skiddle');
    const listings = await skiddleProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });

    expect(listings).toEqual([]);
    // 7 event codes exist (see EVENT_CODES) — proving fewer than 7 withRetry calls happened is
    // the actual evidence the overall budget cut the loop short, not just that it eventually
    // returned.
    expect(withRetryCalls.length).toBeLessThan(7);
  });
});
