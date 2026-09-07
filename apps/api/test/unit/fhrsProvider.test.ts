import { describe, expect, test } from 'vitest';
import { fhrsProvider } from '../../src/providers/live/fhrs';
import type { RawListing } from '../../src/providers/types';

/**
 * Pure mapping logic (category, address, honest null price/image) — testable without live
 * network access. What this does NOT cover: whether api.ratings.food.gov.uk actually returns
 * this shape for real — that needs a real request, not available in this environment. See this
 * adapter's own file header for the full research writeup.
 *
 * `fetchListings` attaches `__lat`/`__lng`/`__category` onto the raw establishment before
 * `mapToCanonical` ever sees it (see fhrs.ts) — these fixtures include those the same way.
 */
function fakeEstablishment(overrides: Record<string, unknown> = {}) {
  return {
    FHRSID: 123456,
    BusinessName: "Purnell's",
    BusinessType: 'Restaurant/Cafe/Canteen',
    AddressLine1: '55 Cornwall Street',
    AddressLine2: 'Birmingham',
    PostCode: 'B3 2DH',
    RatingValue: '5',
    LocalAuthorityName: 'Birmingham City Council',
    geocode: { latitude: '52.4831', longitude: '-1.9037' },
    __lat: 52.4831,
    __lng: -1.9037,
    __category: 'RESTAURANT',
    ...overrides,
  };
}

function listing(overrides: Record<string, unknown> = {}): RawListing {
  const raw = fakeEstablishment(overrides);
  return { externalId: String(raw.FHRSID), raw };
}

describe('fhrsProvider.mapToCanonical', () => {
  test('maps a real establishment to RESTAURANT with real name/address', () => {
    const result = fhrsProvider.mapToCanonical(listing());
    expect(result.name).toBe("Purnell's");
    expect(result.category).toBe('RESTAURANT');
    expect(result.venueName).toBe("Purnell's");
    expect(result.latitude).toBe(52.4831);
    expect(result.longitude).toBe(-1.9037);
    expect(result.description).toContain('Cornwall Street');
  });

  test('a Pub/bar/nightclub BusinessType maps to BAR', () => {
    const result = fhrsProvider.mapToCanonical(listing({ BusinessName: 'The Wellington', BusinessType: 'Pub/bar/nightclub', __category: 'BAR' }));
    expect(result.category).toBe('BAR');
  });

  test('has no price or image data — honestly left null, never guessed', () => {
    const result = fhrsProvider.mapToCanonical(listing());
    expect(result.priceMinMinor).toBeNull();
    expect(result.priceMaxMinor).toBeNull();
    expect(result.imageUrl).toBeNull();
    expect(result.imageSource).toBeNull();
    expect(result.bookingStatus).toBe('AVAILABLE');
    expect(result.commissionEligible).toBe(false);
  });

  test('carries the real hygiene rating and local authority through as honest, coarse tags', () => {
    const result = fhrsProvider.mapToCanonical(listing());
    expect(result.tags.hygieneRating).toBe('5');
    expect(result.tags.localAuthority).toBe('Birmingham City Council');
    expect(result.tags.provider).toBe('fhrs');
  });

  test('externalUrl is a real Google Maps search for the address, never a fabricated venue-page link', () => {
    const result = fhrsProvider.mapToCanonical(listing());
    expect(result.externalUrl).toContain('google.com/maps/search');
    expect(result.externalUrl).toContain(encodeURIComponent('Cornwall Street'));
  });

  test('startsAt is always in the future, never presented as a real booking slot', () => {
    const result = fhrsProvider.mapToCanonical(listing());
    expect(result.startsAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('fhrsProvider registration', () => {
  test('is always live — official government open data, no credential to be missing', () => {
    expect(fhrsProvider.isLive).toBe(true);
  });

  test('only covers RESTAURANT/BAR — a hygiene register, not a general places API', () => {
    expect(fhrsProvider.categories).toEqual(['RESTAURANT', 'BAR']);
  });
});
