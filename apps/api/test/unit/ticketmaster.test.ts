import { describe, expect, test } from 'vitest';
import { ticketmasterProvider } from '../../src/providers/live/ticketmaster';

/**
 * Pure mapping logic (category, booking status, image selection) — testable without a live
 * API key or network access. What this does NOT cover: whether Ticketmaster's Discovery API
 * actually returns this shape for real, or that the account/key works — that needs a real key
 * and a real request, neither available in this environment. See docs/DECISIONS.md#real-events.
 */
function fakeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tm-123',
    name: 'Test Gig',
    url: 'https://www.ticketmaster.co.uk/event/tm-123',
    images: [
      { url: 'https://example.com/square.jpg', width: 200, height: 200, ratio: '1_1' },
      { url: 'https://example.com/wide.jpg', width: 1024, height: 576, ratio: '16_9' },
    ],
    dates: { start: { dateTime: '2026-09-15T19:30:00Z' }, status: { code: 'onsale' } },
    classifications: [{ segment: { name: 'Music' }, genre: { name: 'Electronic' } }],
    priceRanges: [{ min: 25, max: 60, currency: 'GBP' }],
    _embedded: { venues: [{ name: 'Test Venue', city: { name: 'London' }, location: { latitude: '51.5', longitude: '-0.1' } }] },
    ...overrides,
  };
}

describe('ticketmasterProvider.mapToCanonical', () => {
  test('maps a well-formed Music event correctly', () => {
    const result = ticketmasterProvider.mapToCanonical({ externalId: 'tm-123', raw: fakeEvent() });
    expect(result.name).toBe('Test Gig');
    expect(result.category).toBe('LIVE_MUSIC');
    expect(result.venueName).toBe('Test Venue');
    expect(result.latitude).toBe(51.5);
    expect(result.longitude).toBe(-0.1);
    expect(result.priceMinMinor).toBe(2500);
    expect(result.priceMaxMinor).toBe(6000);
    expect(result.bookingStatus).toBe('AVAILABLE');
    expect(result.externalUrl).toBe('https://www.ticketmaster.co.uk/event/tm-123');
    expect(result.imageUrl).toBe('https://example.com/wide.jpg'); // prefers the 16:9 crop
  });

  test('maps Arts & Theatre / comedy genre to COMEDY, not the generic ART_CULTURE bucket', () => {
    const result = ticketmasterProvider.mapToCanonical({
      externalId: 'tm-456',
      raw: fakeEvent({ classifications: [{ segment: { name: 'Arts & Theatre' }, genre: { name: 'Comedy' } }] }),
    });
    expect(result.category).toBe('COMEDY');
  });

  test('a cancelled event maps to SOLD_OUT so Match excludes it, not UNKNOWN', () => {
    const result = ticketmasterProvider.mapToCanonical({
      externalId: 'tm-789',
      raw: fakeEvent({ dates: { start: { dateTime: '2026-09-15T19:30:00Z' }, status: { code: 'cancelled' } } }),
    });
    expect(result.bookingStatus).toBe('SOLD_OUT');
  });

  test('a festival genre maps to FESTIVAL regardless of which segment it sits under — the real gap behind "where are the food festivals?"', () => {
    const musicFestival = ticketmasterProvider.mapToCanonical({
      externalId: 'tm-fest-1',
      raw: fakeEvent({ classifications: [{ segment: { name: 'Music' }, genre: { name: 'Festival' } }] }),
    });
    expect(musicFestival.category).toBe('FESTIVAL');

    const foodFestival = ticketmasterProvider.mapToCanonical({
      externalId: 'tm-fest-2',
      raw: fakeEvent({ classifications: [{ segment: { name: 'Miscellaneous' }, genre: { name: 'Food & Drink' }, subGenre: { name: 'Food & Drink Festival' } }] }),
    });
    expect(foodFestival.category).toBe('FESTIVAL');
  });

  test('falls back to COMMUNITY for an unrecognised segment rather than dropping the event', () => {
    const result = ticketmasterProvider.mapToCanonical({
      externalId: 'tm-999',
      raw: fakeEvent({ classifications: [{ segment: { name: 'Miscellaneous' } }] }),
    });
    expect(result.category).toBe('COMMUNITY');
  });
});

describe('ticketmasterProvider registration', () => {
  test('isLive is false without a configured API key (this test env has none)', () => {
    expect(ticketmasterProvider.isLive).toBe(false);
  });
});
