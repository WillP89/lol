import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Real gap this closes, found in a follow-up gate audit: `fetchOneCategory` used to make exactly
 * ONE request per event code (limit=50), sorted by date ascending, and never read the response's
 * own `totalcount` field — so a dense event code (LIVE/CLUB in a city with 65+ real gigs across
 * the sync window) silently and permanently lost everything past the earliest 50 by date, every
 * sync. See skiddle.ts's own MAX_PAGES_PER_CATEGORY comment for the fix this proves: a real
 * `offset`-based pagination loop, same shape as Ticketmaster's MAX_PAGES.
 *
 * Isolated into its own file for the same reason skiddleTimeBudget.test.ts is — mocking
 * lib/config and lib/retry here would otherwise leak into skiddle.test.ts's "no key configured"
 * assertions.
 */
vi.mock('../../src/lib/config', () => ({ config: { SKIDDLE_API_KEY: 'test-key' } }));

let fetchMock: ReturnType<typeof vi.fn>;

function skiddleResponse(results: unknown[], totalcount: number) {
  return { ok: true, json: async () => ({ results, totalcount }) };
}

describe('skiddleProvider.fetchListings pagination', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('a category with more real results than one page fetches a second page via offset, not just the first 50', async () => {
    const page0Events = Array.from({ length: 50 }, (_, i) => ({
      id: `evt-${i}`,
      eventname: `Event ${i}`,
      date: '2026-09-15',
      link: `https://www.skiddle.com/e/${i}`,
      EventCode: 'CLUB',
      venue: { name: 'Venue', latitude: '52.4862', longitude: '-1.8904' },
    }));
    const page1Events = [
      { id: 'evt-50', eventname: 'Event 50 — only reachable via page 2', date: '2026-09-20', link: 'https://www.skiddle.com/e/50', EventCode: 'CLUB', venue: { name: 'Venue', latitude: '52.4862', longitude: '-1.8904' } },
    ];

    fetchMock.mockImplementation(async (url: string) => {
      const offset = new URL(url).searchParams.get('offset');
      const eventcode = new URL(url).searchParams.get('eventcode');
      if (eventcode !== 'CLUB') return skiddleResponse([], 0);
      if (offset === '0') return skiddleResponse(page0Events, 51);
      if (offset === '50') return skiddleResponse(page1Events, 51);
      return skiddleResponse([], 51); // page 3 should never be requested — only 51 real results exist
    });

    const { skiddleProvider } = await import('../../src/providers/live/skiddle');
    const listings = await skiddleProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });

    // The real regression this proves fixed: before the fix, only the 50 page-0 events would
    // ever be fetched — event 50 genuinely exists (Skiddle's own totalcount says so) but would
    // have been silently and permanently lost.
    expect(listings.some((l) => l.externalId === 'evt-50')).toBe(true);
    expect(listings.length).toBe(51);
  });

  test('a category with fewer results than one page never requests a second page', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const eventcode = new URL(url).searchParams.get('eventcode');
      const offset = new URL(url).searchParams.get('offset');
      if (eventcode !== 'LIVE') return skiddleResponse([], 0);
      if (offset !== '0') throw new Error('Should never request a second page when the first came back short');
      return skiddleResponse(
        [{ id: 'evt-only', eventname: 'The Only Gig', date: '2026-09-15', link: 'https://www.skiddle.com/e/only', EventCode: 'LIVE', venue: { name: 'Venue', latitude: '52.4862', longitude: '-1.8904' } }],
        1,
      );
    });

    const { skiddleProvider } = await import('../../src/providers/live/skiddle');
    const listings = await skiddleProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });
    expect(listings.filter((l) => l.externalId === 'evt-only').length).toBe(1);
  });
});
