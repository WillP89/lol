import { describe, expect, test } from 'vitest';
import { computeQualityScore, MIN_PUBLISHABLE_QUALITY_SCORE } from '../../src/services/qualityScoring';
import type { CanonicalListingInput } from '../../src/providers/types';

function fakeInput(overrides: Partial<CanonicalListingInput> = {}): CanonicalListingInput {
  return {
    name: 'Test event',
    description: 'A proper description of the event, long enough to count.',
    category: 'LIVE_MUSIC',
    subcategories: ['indie'],
    venueName: 'Test Venue',
    latitude: 51.5,
    longitude: -0.1,
    startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    endsAt: null,
    timezone: 'Europe/London',
    priceMinMinor: 2000,
    priceMaxMinor: 4000,
    currency: 'GBP',
    bookingStatus: 'AVAILABLE',
    imageUrl: 'https://example.invalid/image.jpg',
    imageSource: 'TICKETMASTER',
    tags: { energy: 'high', groupFriendly: true },
    externalUrl: 'https://example.invalid',
    commissionEligible: false,
    ...overrides,
  };
}

describe('computeQualityScore', () => {
  test('a complete, fresh, bookable listing scores highly', () => {
    const score = computeQualityScore(fakeInput(), new Date());
    expect(score).toBeGreaterThan(80);
  });

  test('a listing with no price, image or description scores far lower', () => {
    const score = computeQualityScore(
      fakeInput({ description: '', imageUrl: null, priceMinMinor: null, priceMaxMinor: null, tags: {} }),
      new Date(),
    );
    expect(score).toBeLessThan(MIN_PUBLISHABLE_QUALITY_SCORE);
  });

  test('a sold-out listing is penalised', () => {
    const available = computeQualityScore(fakeInput(), new Date());
    const soldOut = computeQualityScore(fakeInput({ bookingStatus: 'SOLD_OUT' }), new Date());
    expect(soldOut).toBeLessThan(available);
  });

  test('a listing in the past is penalised', () => {
    const future = computeQualityScore(fakeInput(), new Date());
    const past = computeQualityScore(fakeInput({ startsAt: new Date(Date.now() - 1000) }), new Date());
    expect(past).toBeLessThan(future);
  });

  test('stale data (not refreshed in days) loses freshness points', () => {
    const fresh = computeQualityScore(fakeInput(), new Date());
    const stale = computeQualityScore(fakeInput(), new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
    expect(stale).toBeLessThan(fresh);
  });
});
