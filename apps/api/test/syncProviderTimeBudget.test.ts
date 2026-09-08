import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';
import type { ProviderAdapter, RawListing, CanonicalListingInput } from '../src/providers/types';

/**
 * Real, live-reproduced production incident this closes: the admin "Sync inventory now" button
 * (POST /admin/sync, a direct, unconditional `await syncAllProviders(city)`) 502'd outright for a
 * real Crew's city — not slow, no response at all, because Render's own proxy gave up long before
 * the request finished. Root cause traced to `syncProvider`'s per-listing loop: every listing with
 * no pre-existing photo runs THREE-to-FOUR sequential live network calls (Wikipedia/TheSportsDB,
 * then Commons/Pexels stock fallback, then an image-quality byte probe) with no overall time
 * budget — unlike every one of this codebase's own provider `fetchListings()` calls, which are
 * all individually bounded (see Skiddle's OVERALL_BUDGET_MS, OpenStreetMap/FHRS/Google/Foursquare's
 * own FETCH_RETRY). A brand-new city (or FHRS alone, which routinely returns 100+ photo-less UK
 * town listings) means every one of those listings needs full enrichment — minutes, not seconds,
 * for a single sync. This isn't just the admin button's problem either: `ensureInventoryProduction`
 * awaits this exact same unbounded loop for any genuinely-empty city, which is precisely the path
 * a brand-new user's first "send a recommendation the moment a Crew hits 2 members" trigger goes
 * through — so an un-synced city could silently blow that trigger's request budget too.
 *
 * Mirrors `test/unit/skiddleTimeBudget.test.ts`'s own jumping-clock technique: `Date.now()` is
 * mocked to advance by a fixed step on every call, so the loop's own budget check sees the budget
 * exhausted after a couple of iterations — proving the real code path, not simulated time, while
 * the test itself still finishes in milliseconds of real wall-clock time.
 */
vi.mock('../src/lib/imageEnrichment', () => ({
  enrichImageFromTheSportsDb: vi.fn(async () => null),
  enrichImageFromWikipedia: vi.fn(async () => null),
}));
vi.mock('../src/lib/categoryStockImages', () => ({
  getCategoryStockImage: vi.fn(async () => null),
}));
vi.mock('../src/lib/pexelsStockImages', () => ({
  getPexelsStockImage: vi.fn(async () => null),
}));

const TOTAL_LISTINGS = 20;

vi.mock('../src/providers/registry', () => ({
  providerRegistry: [
    {
      id: 'budget_test_adapter',
      displayName: 'Budget Test Adapter',
      categories: ['LIVE_MUSIC'],
      isLive: true,
      async healthCheck() {
        return { status: 'ACTIVE' as const, checkedAt: new Date() };
      },
      async fetchListings(): Promise<RawListing[]> {
        return Array.from({ length: TOTAL_LISTINGS }, (_, i) => ({ externalId: `listing-${i}`, raw: { i } }));
      },
      mapToCanonical(listing: RawListing): CanonicalListingInput {
        const i = (listing.raw as { i: number }).i;
        return {
          name: `Budget Test Event ${i}`,
          description: 'A test listing for the upsert-loop time budget.',
          category: 'LIVE_MUSIC',
          subcategories: [],
          venueName: `Budget Test Venue ${i}`,
          latitude: 52.8062,
          longitude: -2.1169, // real Stafford coordinates
          startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          endsAt: null,
          timezone: 'Europe/London',
          priceMinMinor: null,
          priceMaxMinor: null,
          currency: 'GBP',
          bookingStatus: 'AVAILABLE',
          imageUrl: null, // forces every listing through the full enrichment chain
          imageSource: null,
          tags: {},
          externalUrl: `https://example.invalid/event/${i}`,
          commissionEligible: false,
        };
      },
    } as unknown as ProviderAdapter,
  ],
  hasLiveProvider: true,
  hasLiveTicketedProvider: true,
  getProvider: () => undefined,
}));

describe('syncProvider upsert-loop time budget', () => {
  beforeEach(async () => {
    vi.resetModules();
    await resetDatabase();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('stops upserting further listings once the overall budget is spent, rather than processing all of them unbounded', async () => {
    // Real elapsed time, not simulated — every mocked enrichment call resolves instantly, so
    // this exercises the actual Date.now()-based budget check in syncProvider without needing
    // fake timers or real delays. Each Date.now() call advances the clock by 3s, so by roughly
    // the 5th or 6th of 20 listings the loop's own check sees >15s elapsed and stops early.
    let simulatedNow = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      simulatedNow += 3000;
      return simulatedNow;
    });

    const { syncProvider } = await import('../src/services/inventorySync');
    const { providerRegistry } = await import('../src/providers/registry');
    const fromDate = new Date();
    const toDate = new Date(fromDate.getTime() + 60 * 24 * 60 * 60 * 1000);

    const result = await syncProvider(providerRegistry[0], { city: 'Stafford', fromDate, toDate });

    // The real evidence the budget cut the loop short, not just that it eventually returned:
    // fewer than all 20 fetched listings actually got upserted.
    expect(result.fetched).toBe(TOTAL_LISTINGS);
    expect(result.upserted).toBeGreaterThan(0);
    expect(result.upserted).toBeLessThan(TOTAL_LISTINGS);

    // What the loop DID reach really is in the database — a partial pass is real progress, not
    // silently dropped, and whatever this run didn't reach gets picked up on the next sync.
    const savedCount = await prisma.experience.count({ where: { venue: { city: 'Stafford' } } });
    expect(savedCount).toBe(result.upserted);
  });

  test('a genuinely fast sync (few listings, well inside the budget) still upserts everything', async () => {
    const { syncProvider } = await import('../src/services/inventorySync');
    const { providerRegistry } = await import('../src/providers/registry');
    const fromDate = new Date();
    const toDate = new Date(fromDate.getTime() + 60 * 24 * 60 * 60 * 1000);

    const result = await syncProvider(providerRegistry[0], { city: 'Stafford', fromDate, toDate });

    // Real (non-mocked) Date.now() here — proving the budget only ever cuts a loop short when
    // it's actually earned that, never as an artificial cap on a normal-sized, fast sync.
    expect(result.fetched).toBe(TOTAL_LISTINGS);
    expect(result.upserted).toBe(TOTAL_LISTINGS);
  });
});
