import { describe, expect, test } from 'vitest';
import { googlePlacesProvider } from '../../src/providers/live/googlePlaces';
import type { RawListing } from '../../src/providers/types';

/**
 * Pure mapping logic (category, price-tier label, real photo URL construction, honest null
 * price) — testable without a live API key or network access. What this does NOT cover: whether
 * places.googleapis.com actually returns this shape for real, or that a real key/billing account
 * works — that needs a real key and a real request, neither available in this environment. See
 * this adapter's own file header for the full research/pricing writeup.
 *
 * `fetchListings` attaches `__category` onto the raw place before `mapToCanonical` ever sees it
 * (see googlePlaces.ts) — these fixtures include that the same way.
 */
function fakePlace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ChIJ-gplace-1',
    displayName: { text: 'The Wilderness' },
    formattedAddress: '19 Warstone Lane, Birmingham B18 6JQ, UK',
    location: { latitude: 52.4837, longitude: -1.9096 },
    types: ['bar', 'restaurant'],
    priceLevel: 'PRICE_LEVEL_MODERATE',
    rating: 4.6,
    userRatingCount: 812,
    googleMapsUri: 'https://maps.google.com/?cid=12345',
    websiteUri: 'https://wearethewilderness.co.uk',
    photos: [{ name: 'places/ChIJ-gplace-1/photos/abc123', widthPx: 4032, heightPx: 3024 }],
    __category: 'BAR',
    ...overrides,
  };
}

function listing(overrides: Record<string, unknown> = {}): RawListing {
  const raw = fakePlace(overrides);
  return { externalId: raw.id as string, raw };
}

describe('googlePlacesProvider.mapToCanonical', () => {
  test('maps a real place to its category with real name/address/coordinates', () => {
    const result = googlePlacesProvider.mapToCanonical(listing());
    expect(result.name).toBe('The Wilderness');
    expect(result.category).toBe('BAR');
    expect(result.venueName).toBe('The Wilderness');
    expect(result.latitude).toBe(52.4837);
    expect(result.longitude).toBe(-1.9096);
    expect(result.description).toContain('Warstone Lane');
  });

  test('a real photos[].name reference becomes a real Places Photos (New) media URL, tagged GOOGLE_PLACES', () => {
    const result = googlePlacesProvider.mapToCanonical(listing());
    expect(result.imageUrl).toContain('places/ChIJ-gplace-1/photos/abc123/media');
    expect(result.imageUrl).toContain('maxWidthPx=');
    expect(result.imageSource).toBe('GOOGLE_PLACES');
  });

  test('no photos means no fabricated image', () => {
    const result = googlePlacesProvider.mapToCanonical(listing({ photos: undefined }));
    expect(result.imageUrl).toBeNull();
    expect(result.imageSource).toBeNull();
  });

  test('priceLevel is a coarse enum, honestly left out of priceMinMinor/priceMaxMinor and kept as a real tag instead', () => {
    const result = googlePlacesProvider.mapToCanonical(listing());
    expect(result.priceMinMinor).toBeNull();
    expect(result.priceMaxMinor).toBeNull();
    expect(result.tags.priceLevel).toBe('moderate');
  });

  test('an unrecognised priceLevel maps to a null tag, never guessed', () => {
    const result = googlePlacesProvider.mapToCanonical(listing({ priceLevel: 'PRICE_LEVEL_UNSPECIFIED' }));
    expect(result.tags.priceLevel).toBeNull();
  });

  test('externalUrl is the real Google Maps place URI, never fabricated', () => {
    const result = googlePlacesProvider.mapToCanonical(listing());
    expect(result.externalUrl).toBe('https://maps.google.com/?cid=12345');
  });

  test('falls back to the venue website, then a real Maps search, if googleMapsUri is missing', () => {
    const withWebsite = googlePlacesProvider.mapToCanonical(listing({ googleMapsUri: undefined }));
    expect(withWebsite.externalUrl).toBe('https://wearethewilderness.co.uk');

    const withNeither = googlePlacesProvider.mapToCanonical(listing({ googleMapsUri: undefined, websiteUri: undefined }));
    expect(withNeither.externalUrl).toContain('google.com/maps/search');
  });

  test('a night_club type maps to CLUBBING', () => {
    const result = googlePlacesProvider.mapToCanonical(listing({ types: ['night_club'], __category: 'CLUBBING' }));
    expect(result.category).toBe('CLUBBING');
  });

  test('startsAt is always in the future, never presented as a real booking slot', () => {
    const result = googlePlacesProvider.mapToCanonical(listing());
    expect(result.startsAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.bookingStatus).toBe('AVAILABLE');
    expect(result.commissionEligible).toBe(false);
  });
});

describe('googlePlacesProvider registration', () => {
  test('isLive reflects whether GOOGLE_PLACES_API_KEY is configured — no key means not live', () => {
    // GOOGLE_PLACES_API_KEY is unset in this test environment, same as every other key-gated adapter.
    expect(googlePlacesProvider.isLive).toBe(false);
  });

  test('covers RESTAURANT/BAR/CLUBBING', () => {
    expect(googlePlacesProvider.categories).toEqual(['RESTAURANT', 'BAR', 'CLUBBING']);
  });
});
