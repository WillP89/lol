import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams, ProviderHealth } from '../types';
import { withRetry } from '../../lib/retry';
import { config } from '../../lib/config';
import { logger } from '../../lib/logger';
import { resolveCityCenter } from '../../data/ukPlaces';

/**
 * Real Foursquare Places API v3 adapter — a genuinely DIFFERENT venue graph from Google Places
 * (still real, crowd-and-merchant-maintained coverage, historically strong specifically for
 * nightlife/bars — the category Plot's own inventory is thinnest on outside Skiddle/OSM's
 * `amenity=nightclub`). Researched alongside Google Places for "every single open API" on the
 * restaurant/food gap; kept as its own adapter rather than folded into Google's because dedup
 * (services/entityResolution.ts) already handles the same real venue appearing in both, and each
 * source's contributors miss real venues the other one has.
 *
 * Deliberately gated behind `FOURSQUARE_API_KEY` (self-serve free-tier signup at
 * location.foursquare.com/developer — a real free tier exists, unlike Yelp's paid-only-since-2024
 * posture documented elsewhere in this codebase) rather than always-live like OpenStreetMap/FHRS,
 * because it IS a commercial API key a real operator has to go get, even if the entry tier is free.
 *
 * Category matching is deliberately TEXT-based — checking each result's own `categories[].name`
 * strings — rather than Foursquare's numeric/hex category ID taxonomy. This is an honest
 * limitation, not a shortcut: I don't have full confidence the exact current ID list matches what
 * this adapter would ship from memory, and a wrong hardcoded ID mapping would silently drop or
 * miscategorise real venues with no obvious symptom. Matching on the category's own display name
 * is slower to iterate on if Foursquare renames a category, but it fails LOUDLY (the venue simply
 * isn't matched, logged as zero-results if it happens at scale) rather than silently miscategorising.
 *
 * What v3's core Search endpoint does NOT give without a separate per-venue request: photos. This
 * adapter deliberately does not make that second call per result (real per-request cost, and this
 * codebase's own `never fetch N+1` discipline elsewhere) — `imageUrl` stays null here, same as
 * FHRS, falling into inventorySync.ts's own enrichment chain like every other image-less source.
 * `price` is Foursquare's own coarse 1-4 tier (not a real minor-unit amount) — kept in `tags`
 * only, never converted into a fabricated price range, same posture as every other adapter here.
 *
 * NOT exercised against the live API from this environment — outbound network to
 * api.foursquare.com is blocked from this sandbox, the same restriction documented on every
 * other live adapter here. Written against Foursquare Places API v3's own publicly documented
 * Search endpoint (endpoint shape, `Authorization` header — a raw key, NOT a Bearer-prefixed
 * one — field selection, response shape) — verify against Render's own logs once a real key is
 * configured there.
 */

const SEARCH_URL = 'https://api.foursquare.com/v3/places/search';
const SEARCH_RADIUS_METERS = 6000; // same "worth the trip" catchment as OpenStreetMap/Google Places' own dining radius
const SEARCH_LIMIT = 50; // v3 Search's own documented per-request cap
const FETCH_RETRY = { attempts: 2, timeoutMs: 8_000 };

// Only the fields this adapter actually uses — keeps the response payload down, same discipline
// as Google Places' own FIELD_MASK.
const FIELDS = ['fsq_id', 'name', 'categories', 'location', 'geocodes', 'price', 'rating', 'website', 'tel'].join(',');

interface FsqCategory {
  id?: number;
  name?: string;
}

interface FsqLocation {
  formatted_address?: string;
  address?: string;
  locality?: string;
  postcode?: string;
}

interface FsqGeocodeLatLng {
  latitude?: number;
  longitude?: number;
}

interface FsqPlace {
  fsq_id: string;
  name?: string;
  categories?: FsqCategory[];
  location?: FsqLocation;
  geocodes?: { main?: FsqGeocodeLatLng };
  price?: number; // 1-4, Foursquare's own coarse tier — never a real minor-unit amount
  rating?: number; // 0-10
  website?: string;
  tel?: string;
}

interface FsqSearchResponse {
  results?: FsqPlace[];
}

/**
 * Text-based, not ID-based — see this file's own top comment for why. Checked in an order that
 * puts the more specific real distinction Plot cares about first, same convention as Google
 * Places' own mapCategory (a venue commonly carries several category names at once).
 */
function mapCategory(categories: FsqCategory[] | undefined): ExperienceCategory | null {
  const names = (categories ?? []).map((c) => (c.name ?? '').toLowerCase());
  const has = (needle: string) => names.some((n) => n.includes(needle));
  if (has('night club') || has('nightclub')) return 'CLUBBING';
  if (has('bar') || has('pub') || has('brewery') || has('speakeasy')) return 'BAR';
  if (has('restaurant') || has('café') || has('cafe') || has('coffee') || has('bakery') || has('food truck') || has('food court') || has('diner') || has('bistro')) return 'RESTAURANT';
  return null;
}

/** Foursquare's own 1-4 price tier is real, coarse signal — never converted into a fabricated
 *  minor-unit range, same honest posture as Google Places' priceLevelLabel. */
function priceLabel(price: number | undefined): string | null {
  switch (price) {
    case 1:
      return 'inexpensive';
    case 2:
      return 'moderate';
    case 3:
      return 'expensive';
    case 4:
      return 'very_expensive';
    default:
      return null;
  }
}

function formatAddress(location: FsqLocation | undefined): string {
  return location?.formatted_address ?? [location?.address, location?.locality, location?.postcode].filter(Boolean).join(', ');
}

/** Same honest "next sensible time to go" convention as every other places adapter here —
 *  Foursquare v3's core Search doesn't return real opening hours without a separate per-venue
 *  request this adapter deliberately doesn't make (see this file's own top comment). */
function nextSensibleTime(hour: number): Date {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(hour, 0, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

async function searchNearby(params: FetchListingsParams, signal: AbortSignal): Promise<FsqSearchResponse> {
  const center = resolveCityCenter(params.city);
  const url = new URL(SEARCH_URL);
  url.searchParams.set('ll', `${center.lat},${center.lng}`);
  url.searchParams.set('radius', String(SEARCH_RADIUS_METERS));
  url.searchParams.set('limit', String(SEARCH_LIMIT));
  url.searchParams.set('fields', FIELDS);

  const res = await fetch(url.toString(), {
    signal,
    headers: {
      // A raw key, not "Bearer <key>" — Foursquare v3's own documented convention, unlike most
      // other REST APIs this codebase talks to.
      Authorization: config.FOURSQUARE_API_KEY ?? '',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Foursquare Places API v3 returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as FsqSearchResponse;
}

export const foursquareProvider: ProviderAdapter = {
  id: 'foursquare',
  displayName: 'Foursquare',
  categories: ['RESTAURANT', 'BAR', 'CLUBBING'],
  isLive: Boolean(config.FOURSQUARE_API_KEY),

  async healthCheck(): Promise<ProviderHealth> {
    if (!config.FOURSQUARE_API_KEY) {
      return { status: 'DOWN', error: 'FOURSQUARE_API_KEY not configured', checkedAt: new Date() };
    }
    try {
      await withRetry((signal) => searchNearby({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() }, signal), { attempts: 1 });
      return { status: 'ACTIVE', checkedAt: new Date() };
    } catch (err) {
      return { status: 'DOWN', error: String(err), checkedAt: new Date() };
    }
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    if (!config.FOURSQUARE_API_KEY) return [];

    let places: FsqPlace[] = [];
    try {
      const data = await withRetry((signal) => searchNearby(params, signal), FETCH_RETRY);
      places = data.results ?? [];
    } catch (err) {
      logger.warn({ err, city: params.city }, 'Foursquare Places API v3 query failed — no Foursquare inventory this sync');
      return [];
    }

    const listings: RawListing[] = [];
    for (const place of places) {
      const category = mapCategory(place.categories);
      const lat = place.geocodes?.main?.latitude;
      const lng = place.geocodes?.main?.longitude;
      if (!category || !place.name || typeof lat !== 'number' || typeof lng !== 'number') {
        continue; // an unrecognised category, or a malformed row missing a name/location — dropped, not guessed
      }
      listings.push({ externalId: place.fsq_id, raw: { ...place, __category: category } });
    }
    return listings;
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const place = listing.raw as FsqPlace & { __category: ExperienceCategory };
    const category = place.__category;
    const isDining = category === 'RESTAURANT';
    const address = formatAddress(place.location);
    const lat = place.geocodes?.main?.latitude ?? 0;
    const lng = place.geocodes?.main?.longitude ?? 0;

    return {
      name: place.name ?? 'Unnamed venue',
      description: `${place.name ?? 'This venue'}${address ? ` — ${address}` : ''}.`,
      category,
      subcategories: (place.categories ?? []).map((c) => (c.name ?? '').toLowerCase()).filter(Boolean),
      venueName: place.name ?? 'Unnamed venue',
      latitude: lat,
      longitude: lng,
      startsAt: nextSensibleTime(isDining ? 19 : 20),
      endsAt: null,
      timezone: 'Europe/London',
      // Foursquare's price is a coarse 1-4 tier, never a real minor-unit amount — honestly left
      // null rather than guessed (kept in tags as `price` instead, see priceLabel).
      priceMinMinor: null,
      priceMaxMinor: null,
      currency: 'GBP',
      bookingStatus: 'AVAILABLE',
      imageUrl: null, // v3 core Search returns no photos without a separate per-venue call — see top comment
      imageSource: null,
      tags: {
        provider: 'foursquare',
        price: priceLabel(place.price),
        rating: place.rating ?? null,
      },
      // A real venue website when Foursquare has one; otherwise the same honest Google Maps
      // search fallback every other places adapter here uses — never a fabricated permalink.
      externalUrl: place.website ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || place.name || 'UK')}`,
      commissionEligible: false,
    };
  },
};
