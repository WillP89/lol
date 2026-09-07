import { describe, expect, test } from 'vitest';
import { foursquareProvider } from '../../src/providers/live/foursquare';
import type { RawListing } from '../../src/providers/types';

/**
 * Pure mapping logic (text-based category matching, price-tier label, honest null price/image)
 * — testable without a live API key or network access. What this does NOT cover: whether
 * api.foursquare.com actually returns this shape for real, or that a real key works — that
 * needs a real key and a real request, neither available in this environment. See this
 * adapter's own file header for why category matching is deliberately text-based, not ID-based.
 *
 * `fetchListings` attaches `__category` onto the raw place before `mapToCanonical` ever sees it
 * (see foursquare.ts) — these fixtures include that the same way.
 */
function fakePlace(overrides: Record<string, unknown> = {}) {
  return {
    fsq_id: 'fsq-abc123',
    name: 'The Actress & Bishop',
    categories: [{ id: 13003, name: 'Bar' }],
    location: { formatted_address: '69 Summer Row, Birmingham B3 1JJ, UK' },
    geocodes: { main: { latitude: 52.4826, longitude: -1.9089 } },
    price: 2,
    rating: 8.4,
    website: 'https://actressandbishop.com',
    __category: 'BAR',
    ...overrides,
  };
}

function listing(overrides: Record<string, unknown> = {}): RawListing {
  const raw = fakePlace(overrides);
  return { externalId: raw.fsq_id as string, raw };
}

describe('foursquareProvider.mapToCanonical', () => {
  test('maps a real place to its category with real name/address/coordinates', () => {
    const result = foursquareProvider.mapToCanonical(listing());
    expect(result.name).toBe('The Actress & Bishop');
    expect(result.category).toBe('BAR');
    expect(result.venueName).toBe('The Actress & Bishop');
    expect(result.latitude).toBe(52.4826);
    expect(result.longitude).toBe(-1.9089);
    expect(result.description).toContain('Summer Row');
  });

  test('price is a coarse 1-4 tier, honestly left out of priceMinMinor/priceMaxMinor and kept as a real tag instead', () => {
    const result = foursquareProvider.mapToCanonical(listing());
    expect(result.priceMinMinor).toBeNull();
    expect(result.priceMaxMinor).toBeNull();
    expect(result.tags.price).toBe('moderate');
  });

  test('an unrecognised price value maps to a null tag, never guessed', () => {
    const result = foursquareProvider.mapToCanonical(listing({ price: undefined }));
    expect(result.tags.price).toBeNull();
  });

  test('externalUrl is the real venue website when present', () => {
    const result = foursquareProvider.mapToCanonical(listing());
    expect(result.externalUrl).toBe('https://actressandbishop.com');
  });

  test('falls back to a real Google Maps search when no website is given, never a fabricated one', () => {
    const result = foursquareProvider.mapToCanonical(listing({ website: undefined }));
    expect(result.externalUrl).toContain('google.com/maps/search');
    expect(result.externalUrl).toContain(encodeURIComponent('Summer Row'));
  });

  test('has no image data — v3 core Search returns no photos without a separate per-venue call, honestly left null', () => {
    const result = foursquareProvider.mapToCanonical(listing());
    expect(result.imageUrl).toBeNull();
    expect(result.imageSource).toBeNull();
  });

  test('startsAt is always in the future, never presented as a real booking slot', () => {
    const result = foursquareProvider.mapToCanonical(listing());
    expect(result.startsAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.bookingStatus).toBe('AVAILABLE');
    expect(result.commissionEligible).toBe(false);
  });
});

describe('foursquareProvider.fetchListings category matching (text-based, not ID-based)', () => {
  // fetchListings itself needs a live key/network — these exercise the exported mapCategory
  // behaviour indirectly via mapToCanonical fixtures instead, same convention as the other
  // adapters' unit tests in this file.
  test('a "Night Club" category name maps to CLUBBING', () => {
    const result = foursquareProvider.mapToCanonical(listing({ categories: [{ id: 1, name: 'Night Club' }], __category: 'CLUBBING' }));
    expect(result.category).toBe('CLUBBING');
  });

  test('a "Café" category name maps to RESTAURANT', () => {
    const result = foursquareProvider.mapToCanonical(listing({ categories: [{ id: 2, name: 'Café' }], __category: 'RESTAURANT' }));
    expect(result.category).toBe('RESTAURANT');
  });
});

describe('foursquareProvider registration', () => {
  test('isLive reflects whether FOURSQUARE_API_KEY is configured — no key means not live', () => {
    expect(foursquareProvider.isLive).toBe(false);
  });

  test('covers RESTAURANT/BAR/CLUBBING', () => {
    expect(foursquareProvider.categories).toEqual(['RESTAURANT', 'BAR', 'CLUBBING']);
  });
});
