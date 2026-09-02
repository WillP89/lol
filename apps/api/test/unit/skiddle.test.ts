import { describe, expect, test } from 'vitest';
import { skiddleProvider } from '../../src/providers/live/skiddle';

/**
 * Pure mapping logic (category, price parsing, booking status, image selection) — testable
 * without a live API key or network access. What this does NOT cover: whether Skiddle's real
 * API returns this exact shape, or that a real key/account works — that needs a real key and a
 * real request against www.skiddle.com, neither reachable from this sandbox. See
 * providers/live/skiddle.ts's own top comment and docs/providers/ticketing.md.
 */
function fakeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sk-123',
    eventname: 'Test Club Night',
    description: 'A real description straight from Skiddle, unmodified.',
    date: '2026-09-15',
    openingtimes: { doorsopen: '22:00', doorsclose: '03:00' },
    entryprice: '£12.50',
    imageurl: 'https://example.com/small.jpg',
    largeimageurl: 'https://example.com/large.jpg',
    link: 'https://www.skiddle.com/whats-on/Test/test-club-night/12345/',
    EventCode: 'CLUB',
    cancelled: '0',
    venue: { name: 'Test Venue', town: 'Birmingham', latitude: '52.4862', longitude: '-1.8904' },
    ...overrides,
  };
}

describe('skiddleProvider.mapToCanonical', () => {
  test('maps a well-formed club event correctly', () => {
    const result = skiddleProvider.mapToCanonical({ externalId: 'sk-123', raw: fakeEvent() });
    expect(result.name).toBe('Test Club Night');
    expect(result.category).toBe('CLUBBING');
    expect(result.venueName).toBe('Test Venue');
    expect(result.latitude).toBe(52.4862);
    expect(result.longitude).toBe(-1.8904);
    expect(result.priceMinMinor).toBe(1250);
    expect(result.priceMaxMinor).toBe(1250);
    expect(result.bookingStatus).toBe('AVAILABLE');
    // Skiddle's own unmodified link — the API terms require never rewriting/proxying it.
    expect(result.externalUrl).toBe('https://www.skiddle.com/whats-on/Test/test-club-night/12345/');
    expect(result.imageUrl).toBe('https://example.com/large.jpg'); // prefers the large crop
    expect(result.imageSource).toBe('SKIDDLE'); // never 'MANUAL' — that means operator-curated elsewhere
    expect(result.commissionEligible).toBe(false); // affiliate programme is a separate, unconfirmed application
    expect(result.startsAt.toISOString()).toContain('2026-09-15');
  });

  test('maps each Skiddle eventcode onto its own destination category', () => {
    const cases: Array<[string, string]> = [
      ['FEST', 'FESTIVAL'],
      ['LIVE', 'LIVE_MUSIC'],
      ['CLUB', 'CLUBBING'],
      ['COMEDY', 'COMEDY'],
      ['THEATRE', 'THEATRE'],
      ['ARTS', 'ART_CULTURE'],
      ['SPORT', 'SPORT'],
    ];
    for (const [code, category] of cases) {
      const result = skiddleProvider.mapToCanonical({ externalId: `sk-${code}`, raw: fakeEvent({ EventCode: code }) });
      expect(result.category).toBe(category);
    }
  });

  test('an unrecognised eventcode falls back to COMMUNITY rather than dropping the event', () => {
    const result = skiddleProvider.mapToCanonical({ externalId: 'sk-999', raw: fakeEvent({ EventCode: 'BARPUB' }) });
    expect(result.category).toBe('COMMUNITY');
  });

  test('"Free" entryprice maps to a real zero, not an unknown price', () => {
    const result = skiddleProvider.mapToCanonical({ externalId: 'sk-free', raw: fakeEvent({ entryprice: 'Free' }) });
    expect(result.priceMinMinor).toBe(0);
    expect(result.priceMaxMinor).toBe(0);
  });

  test('a price range ("£10 - £15") captures both ends, not just the first number', () => {
    const result = skiddleProvider.mapToCanonical({ externalId: 'sk-range', raw: fakeEvent({ entryprice: '£10 - £15' }) });
    expect(result.priceMinMinor).toBe(1000);
    expect(result.priceMaxMinor).toBe(1500);
  });

  test('a non-price-shaped entryprice honestly maps to unknown rather than guessing', () => {
    const result = skiddleProvider.mapToCanonical({ externalId: 'sk-tbc', raw: fakeEvent({ entryprice: 'See website' }) });
    expect(result.priceMinMinor).toBeNull();
    expect(result.priceMaxMinor).toBeNull();
  });

  test('a cancelled event maps to SOLD_OUT so Match excludes it, not UNKNOWN', () => {
    const result = skiddleProvider.mapToCanonical({ externalId: 'sk-cancelled', raw: fakeEvent({ cancelled: '1' }) });
    expect(result.bookingStatus).toBe('SOLD_OUT');
  });

  test('falls back to a 19:00 start when doorsopen is missing or malformed', () => {
    const result = skiddleProvider.mapToCanonical({ externalId: 'sk-notime', raw: fakeEvent({ openingtimes: {} }) });
    expect(result.startsAt.toISOString()).toContain('2026-09-15T19:00:00');
  });

  test('missing description falls back to an honest generated one, never fabricated flavour text', () => {
    const result = skiddleProvider.mapToCanonical({ externalId: 'sk-nodesc', raw: fakeEvent({ description: '' }) });
    expect(result.description).toBe('Test Club Night at Test Venue.');
  });
});

describe('skiddleProvider registration', () => {
  test('isLive is false without a configured API key (this test env has none)', () => {
    expect(skiddleProvider.isLive).toBe(false);
  });

  test('fetchListings returns nothing when no API key is configured, rather than throwing', async () => {
    const listings = await skiddleProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });
    expect(listings).toEqual([]);
  });
});
