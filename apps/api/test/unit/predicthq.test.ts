import { describe, expect, test } from 'vitest';
import { predictHqProvider } from '../../src/providers/live/predicthq';

/**
 * Pure mapping logic (category, venue/location, best-effort external URL) — testable without a
 * live access token or network access. What this does NOT cover: whether PredictHQ's Events API
 * actually returns this shape for real, or that the account/token works — that needs a real
 * token and a real request, neither available in this environment. See this adapter's own file
 * header for the two open questions (current pricing, and the lack of a public click-through
 * URL) that still need verifying against the real API before relying on it in production.
 */
function fakeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'phq-123',
    title: 'Stafford Food & Drink Market',
    description: 'A monthly food market in the town centre.',
    category: 'food-drink',
    start: '2026-09-20T10:00:00Z',
    end: '2026-09-20T16:00:00Z',
    timezone: 'Europe/London',
    location: [-2.1169, 52.8062],
    entities: [{ entity_id: 'v1', name: 'Market Square', type: 'venue', formatted_address: 'Market Square, Stafford, UK' }],
    rank: 40,
    phq_attendance: 500,
    ...overrides,
  };
}

describe('predictHqProvider.mapToCanonical', () => {
  test('maps a food-drink event to RESTAURANT, not FESTIVAL — PredictHQ already has its own separate festivals category', () => {
    const result = predictHqProvider.mapToCanonical({ externalId: 'phq-123', raw: fakeEvent() });
    expect(result.name).toBe('Stafford Food & Drink Market');
    expect(result.category).toBe('RESTAURANT');
    expect(result.venueName).toBe('Market Square');
    expect(result.latitude).toBe(52.8062);
    expect(result.longitude).toBe(-2.1169);
    expect(result.startsAt.toISOString()).toBe('2026-09-20T10:00:00.000Z');
    expect(result.endsAt?.toISOString()).toBe('2026-09-20T16:00:00.000Z');
  });

  test('maps concerts/festivals/performing-arts/sports/community to their closest Plot category', () => {
    expect(predictHqProvider.mapToCanonical({ externalId: 'a', raw: fakeEvent({ category: 'concerts' }) }).category).toBe('LIVE_MUSIC');
    expect(predictHqProvider.mapToCanonical({ externalId: 'b', raw: fakeEvent({ category: 'festivals' }) }).category).toBe('FESTIVAL');
    expect(predictHqProvider.mapToCanonical({ externalId: 'c', raw: fakeEvent({ category: 'performing-arts' }) }).category).toBe('THEATRE');
    expect(predictHqProvider.mapToCanonical({ externalId: 'd', raw: fakeEvent({ category: 'sports' }) }).category).toBe('SPORT');
    expect(predictHqProvider.mapToCanonical({ externalId: 'e', raw: fakeEvent({ category: 'community' }) }).category).toBe('COMMUNITY');
  });

  test('has no price or image data — honestly left null, never guessed', () => {
    const result = predictHqProvider.mapToCanonical({ externalId: 'phq-123', raw: fakeEvent() });
    expect(result.priceMinMinor).toBeNull();
    expect(result.priceMaxMinor).toBeNull();
    expect(result.imageUrl).toBeNull();
    expect(result.imageSource).toBeNull();
    expect(result.bookingStatus).toBe('AVAILABLE');
    expect(result.commissionEligible).toBe(false);
  });

  test('externalUrl is a real Google Maps search for the venue address, never a fabricated booking link', () => {
    const result = predictHqProvider.mapToCanonical({ externalId: 'phq-123', raw: fakeEvent() });
    expect(result.externalUrl).toBe('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Market Square, Stafford, UK'));
  });

  test('with no venue entity at all, externalUrl falls back to searching the event title rather than throwing', () => {
    const result = predictHqProvider.mapToCanonical({ externalId: 'phq-456', raw: fakeEvent({ entities: [] }) });
    expect(result.externalUrl).toBe('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Stafford Food & Drink Market UK'));
  });

  test('falls back to a generated description when PredictHQ gives an empty one', () => {
    const result = predictHqProvider.mapToCanonical({ externalId: 'phq-789', raw: fakeEvent({ description: '' }) });
    expect(result.description).toBe('Stafford Food & Drink Market at Market Square.');
  });
});

describe('predictHqProvider registration', () => {
  test('isLive is false without a configured access token (this test env has none)', () => {
    expect(predictHqProvider.isLive).toBe(false);
  });
});
