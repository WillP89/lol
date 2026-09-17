import { afterEach, describe, expect, test, vi } from 'vitest';
import { openStreetMapProvider } from '../../src/providers/live/openStreetMap';
import type { RawListing } from '../../src/providers/types';

/** A real Overpass response shape (a node for a pub) — hand-built from the documented Overpass
 * QL `out center tags` JSON contract, not a guess: {type, id, lat, lon, tags}. */
function rawNode(tags: Record<string, string>, overrides: Partial<{ lat: number; lon: number; id: number; type: 'node' | 'way' }> = {}): RawListing {
  const el = { type: overrides.type ?? 'node', id: overrides.id ?? 12345, lat: overrides.lat ?? 52.4862, lon: overrides.lon ?? -1.8904, tags };
  return { externalId: `${el.type}/${el.id}`, raw: el };
}

describe('openStreetMapProvider.mapToCanonical', () => {
  test('a pub maps to BAR with a real name/venue and no fabricated price', () => {
    const listing = rawNode({ name: "The King's Head", amenity: 'pub', 'addr:suburb': 'Digbeth' });
    const result = openStreetMapProvider.mapToCanonical(listing);
    expect(result.category).toBe('BAR');
    expect(result.name).toBe("The King's Head");
    expect(result.venueName).toBe("The King's Head");
    expect(result.priceMinMinor).toBeNull(); // honest: OSM has no price data, never guessed
    expect(result.imageSource).toBeNull(); // no image tag on this fixture
  });

  test('a restaurant with a cuisine tag carries it through as a subcategory', () => {
    const listing = rawNode({ name: 'Smoking Goat', amenity: 'restaurant', cuisine: 'thai;asian' });
    const result = openStreetMapProvider.mapToCanonical(listing);
    expect(result.category).toBe('RESTAURANT');
    expect(result.subcategories).toEqual(['thai', 'asian']);
  });

  test('a museum maps to ART_CULTURE', () => {
    const listing = rawNode({ name: 'Ikon Gallery', tourism: 'gallery' });
    expect(openStreetMapProvider.mapToCanonical(listing).category).toBe('ART_CULTURE');
  });

  test('a bowling alley maps to DAY_ACTIVITY', () => {
    const listing = rawNode({ name: 'Hollywood Bowl', leisure: 'bowling_alley' });
    expect(openStreetMapProvider.mapToCanonical(listing).category).toBe('DAY_ACTIVITY');
  });

  test('a nightclub maps to CLUBBING — a real, free second source alongside Skiddle\'s CLUB eventcode', () => {
    const listing = rawNode({ name: 'Mode', amenity: 'nightclub' });
    expect(openStreetMapProvider.mapToCanonical(listing).category).toBe('CLUBBING');
  });

  test('a cinema maps to CINEMA and a theatre maps to THEATRE — real local venues beyond ticketed listings', () => {
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'The Electric', amenity: 'cinema' })).category).toBe('CINEMA');
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'The Rep', amenity: 'theatre' })).category).toBe('THEATRE');
  });

  test('a gym/sports centre/pool maps to FITNESS — previously a mock-only category with zero real source', () => {
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'PureGym', leisure: 'fitness_centre' })).category).toBe('FITNESS');
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'Leisure Centre', leisure: 'sports_centre' })).category).toBe('FITNESS');
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'Lido', leisure: 'swimming_pool' })).category).toBe('FITNESS');
  });

  test('a horse riding centre maps to DAY_ACTIVITY, not fabricated as a horse racing fixture', () => {
    const result = openStreetMapProvider.mapToCanonical(rawNode({ name: 'Staffordshire Riding School', leisure: 'horse_riding' }));
    expect(result.category).toBe('DAY_ACTIVITY');
  });

  test('a real website tag becomes the externalUrl, not a fabricated one', () => {
    const listing = rawNode({ name: 'Purnell\'s', amenity: 'restaurant', website: 'https://purnellsrestaurant.com' });
    expect(openStreetMapProvider.mapToCanonical(listing).externalUrl).toBe('https://purnellsrestaurant.com');
  });

  test('with no website tag, externalUrl is a real, working OpenStreetMap.org permalink for this exact element — never a fabricated .invalid URL', () => {
    const listing = rawNode({ name: 'The Wellington', amenity: 'pub' }, { id: 999, type: 'way' });
    const result = openStreetMapProvider.mapToCanonical(listing);
    expect(result.externalUrl).toBe('https://www.openstreetmap.org/way/999');
    expect(result.externalUrl).not.toContain('.invalid');
  });

  test('a direct raster image tag is trusted and tagged OPENSTREETMAP; a Commons wiki-page link is not', () => {
    const withRealImage = openStreetMapProvider.mapToCanonical(rawNode({ name: 'A', amenity: 'cafe', image: 'https://example.com/photo.jpg' }));
    expect(withRealImage.imageUrl).toBe('https://example.com/photo.jpg');
    expect(withRealImage.imageSource).toBe('OPENSTREETMAP');

    const withCommonsPage = openStreetMapProvider.mapToCanonical(rawNode({ name: 'B', amenity: 'cafe', image: 'https://commons.wikimedia.org/wiki/File:Example.jpg' }));
    expect(withCommonsPage.imageUrl).toBeNull();
    expect(withCommonsPage.imageSource).toBeNull();
  });

  test('a food court, an ice cream parlour, and specialty food shops (deli/bakery/butcher/etc) all map to RESTAURANT — the "food options are shocking" widening', () => {
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'The Food Hall', amenity: 'food_court' })).category).toBe('RESTAURANT');
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: "Marco's Gelato", amenity: 'ice_cream' })).category).toBe('RESTAURANT');
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'The Deli Counter', shop: 'deli' })).category).toBe('RESTAURANT');
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'Village Bakery', shop: 'bakery' })).category).toBe('RESTAURANT');
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'H. Smith Butchers', shop: 'butcher' })).category).toBe('RESTAURANT');
  });

  test('a biergarten maps to BAR, same as a pub', () => {
    expect(openStreetMapProvider.mapToCanonical(rawNode({ name: 'The Beer Garden', amenity: 'biergarten' })).category).toBe('BAR');
  });

  test('startsAt is always in the future, never a fixed slot presented as a real booking time', () => {
    const result = openStreetMapProvider.mapToCanonical(rawNode({ name: 'X', amenity: 'restaurant' }));
    expect(result.startsAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.bookingStatus).toBe('AVAILABLE');
    expect(result.commissionEligible).toBe(false);
  });
});

describe('openStreetMapProvider registration', () => {
  test('is always live — no credential to be missing for a public API', () => {
    expect(openStreetMapProvider.isLive).toBe(true);
  });
});

/**
 * Real production incident this closes: /admin/providers reported this adapter DOWN with a bare
 * `TypeError: fetch failed` — no bug in the query/parsing logic itself, which points at the
 * single shared public Overpass instance (rate-limited, temporarily unreachable, or blocking
 * this app's own egress IP specifically). `fetchListings`/`healthCheck` now try each of the
 * known public mirrors in `OVERPASS_ENDPOINTS` in turn — these tests prove that fallback
 * actually happens, using a real Overpass QL response shape, rather than trusting the code read.
 */
describe('openStreetMapProvider mirror fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('fetchListings still returns real results when the primary mirror is down but a later one works', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      callCount += 1;
      if (url.includes('overpass-api.de')) {
        throw new TypeError('fetch failed'); // the exact real production error
      }
      return {
        ok: true,
        json: async () => ({ elements: [{ type: 'node', id: 1, lat: 52.48, lon: -1.89, tags: { name: 'The Fallback Arms', amenity: 'pub' } }] }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const listings = await openStreetMapProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });
    expect(listings).toHaveLength(1);
    expect(callCount).toBeGreaterThan(1); // proves it actually moved past the failing primary
    expect(fetchMock.mock.calls[0][0]).toContain('overpass-api.de');
    expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]).not.toContain('overpass-api.de');
  });

  test('fetchListings resolves to an empty array (never throws) when every mirror fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const listings = await openStreetMapProvider.fetchListings({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() });
    expect(listings).toEqual([]);
  });

  test('healthCheck reports ACTIVE once ANY mirror succeeds, not just the primary', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('overpass-api.de')) throw new TypeError('fetch failed');
      return { ok: true, json: async () => ({ elements: [] }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const health = await openStreetMapProvider.healthCheck();
    expect(health.status).toBe('ACTIVE');
  });

  test('healthCheck reports DOWN only when every mirror genuinely fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const health = await openStreetMapProvider.healthCheck();
    expect(health.status).toBe('DOWN');
  });
});
