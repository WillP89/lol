import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams, ProviderHealth } from '../types';
import { withRetry } from '../../lib/retry';
import { config } from '../../lib/config';
import { logger } from '../../lib/logger';
import { resolveCityCenter } from '../../data/ukPlaces';

/**
 * Real Google Places API (New) adapter — the highest-quality restaurant/bar discovery source
 * researched for "the restaurants and food options right now are shocking": real photos venues
 * themselves uploaded, real ratings, real opening hours, real price tier, the best UK coverage of
 * any places API. Deliberately gated behind `GOOGLE_PLACES_API_KEY` (unlike OpenStreetMap/FHRS)
 * because it is NOT free at real production volume — Google's own pricing is pay-as-you-go past a
 * monthly free credit. This adapter exists so the moment a key IS provisioned, real Google data
 * flows through the exact same canonical pipeline as every other source; it is a genuine BUDGET
 * decision for whoever runs this, not an engineering one — see docs/providers/food-and-places.md
 * for the current pricing note and how to verify it before turning this on.
 *
 * Uses the Places API (New) Nearby Search endpoint (`places:searchNearby`) — the actively
 * maintained API; the legacy "Places API" this superseded is deprecated. Real photos are built
 * directly from the search response's own `photos[].name` reference via the Photos endpoint's
 * documented media URL pattern (`.../{photo name}/media?maxWidthPx=...&key=...`) — no separate
 * photo-metadata request needed, and never a search-result thumbnail cached/rehosted elsewhere.
 *
 * `isLive` is false — and this adapter simply isn't registered — whenever
 * `GOOGLE_PLACES_API_KEY` isn't set; see registry.ts. NOT exercised against the live API from
 * this environment — outbound network to places.googleapis.com is blocked from this sandbox, the
 * same restriction documented on every other live adapter here. Written against the Places API
 * (New)'s own publicly documented Nearby Search contract (endpoint, field mask header, response
 * shape) — verify against Render's own logs once a real key is configured there.
 */

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const SEARCH_RADIUS_METERS = 6000; // same "worth the trip" catchment as OpenStreetMap's own dining radius
const MAX_RESULT_COUNT = 20; // Nearby Search's own documented per-request cap
const FETCH_RETRY = { attempts: 2, timeoutMs: 8_000 };
const PHOTO_MAX_WIDTH_PX = 1600; // matches lib/imageDimensions.ts's own MIN_IMAGE_WIDTH floor — see ticketmaster.ts's identical constant for the exact retina-display reasoning

// The Places API (New) requires an explicit field mask — asking only for what this adapter
// actually uses keeps both the response payload and (since Places API New bills per requested
// field group) the real per-request cost down.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.priceLevel',
  'places.rating',
  'places.userRatingCount',
  'places.googleMapsUri',
  'places.websiteUri',
  'places.photos',
].join(',');

// Real, worth-going-to place TYPES this adapter asks for — Google's own documented Place Type
// taxonomy. Deliberately excludes `meal_delivery` (not "going out") and generic `food`/
// `point_of_interest` (too broad, would pull in irrelevant results this adapter would then have
// to filter back out).
const INCLUDED_TYPES = ['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway', 'night_club'] as const;

interface GPlaceLocation {
  latitude: number;
  longitude: number;
}

interface GPlacePhoto {
  name: string; // "places/{place_id}/photos/{photo_id}" — used to build the real media URL below
  widthPx?: number;
  heightPx?: number;
}

interface GPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: GPlaceLocation;
  types?: string[];
  priceLevel?: string; // 'PRICE_LEVEL_UNSPECIFIED' | 'PRICE_LEVEL_FREE' | 'PRICE_LEVEL_INEXPENSIVE' | 'PRICE_LEVEL_MODERATE' | 'PRICE_LEVEL_EXPENSIVE' | 'PRICE_LEVEL_VERY_EXPENSIVE'
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  websiteUri?: string;
  photos?: GPlacePhoto[];
}

interface GSearchResponse {
  places?: GPlace[];
}

/** Google's own Place Type taxonomy doesn't line up 1:1 with Plot's ExperienceCategory either —
 *  same best-effort, not lossless, situation as every other adapter's mapCategory. Checked in an
 *  order that means a place returning multiple types (common — a gastropub is both "restaurant"
 *  and "bar") lands on the more specific real distinction Plot actually cares about. */
function mapCategory(types: string[] | undefined): ExperienceCategory | null {
  const set = new Set(types ?? []);
  if (set.has('night_club')) return 'CLUBBING';
  if (set.has('bar') || set.has('pub')) return 'BAR';
  if (set.has('restaurant') || set.has('cafe') || set.has('bakery') || set.has('meal_takeaway')) return 'RESTAURANT';
  return null;
}

/** Google's own priceLevel is a coarse 6-value enum, never a real minor-unit amount — mapping it
 *  to a fabricated £X.XX–£Y.YY range would be exactly the "never guess a price" line this
 *  codebase holds everywhere else (OSM/PredictHQ/FHRS all leave price null for the same honest
 *  reason). Kept in `tags` instead, as real, honest, coarse signal — see mapToCanonical below. */
function priceLevelLabel(priceLevel: string | undefined): string | null {
  switch (priceLevel) {
    case 'PRICE_LEVEL_FREE':
      return 'free';
    case 'PRICE_LEVEL_INEXPENSIVE':
      return 'inexpensive';
    case 'PRICE_LEVEL_MODERATE':
      return 'moderate';
    case 'PRICE_LEVEL_EXPENSIVE':
      return 'expensive';
    case 'PRICE_LEVEL_VERY_EXPENSIVE':
      return 'very_expensive';
    default:
      return null;
  }
}

/** The real, documented Places Photos (New) media URL pattern — built directly from the search
 *  response's own `photos[].name` reference, no second metadata request needed. Requires the
 *  same API key as the search call (billed the same way — see this file's own top comment). */
function photoUrl(photos: GPlacePhoto[] | undefined): string | null {
  const first = photos?.[0];
  if (!first?.name) return null;
  return `https://places.googleapis.com/v1/${first.name}/media?maxWidthPx=${PHOTO_MAX_WIDTH_PX}&key=${config.GOOGLE_PLACES_API_KEY ?? ''}`;
}

/** Same honest "next sensible time to go" convention as OpenStreetMap/FHRS — Places API (New)
 *  does expose real opening hours (`regularOpeningHours`), a genuine future enhancement once this
 *  adapter is actually live and that field's real shape can be verified against production; not
 *  requested in this first pass to keep the field mask (and real per-request cost) minimal. */
function nextSensibleTime(hour: number): Date {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(hour, 0, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

async function searchNearby(params: FetchListingsParams, signal: AbortSignal): Promise<GSearchResponse> {
  const center = resolveCityCenter(params.city);
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.GOOGLE_PLACES_API_KEY ?? '',
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: INCLUDED_TYPES,
      maxResultCount: MAX_RESULT_COUNT,
      locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: SEARCH_RADIUS_METERS } },
    }),
  });
  if (!res.ok) {
    throw new Error(`Google Places API (New) returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as GSearchResponse;
}

export const googlePlacesProvider: ProviderAdapter = {
  id: 'google_places',
  displayName: 'Google Places',
  categories: ['RESTAURANT', 'BAR', 'CLUBBING'],
  isLive: Boolean(config.GOOGLE_PLACES_API_KEY),

  async healthCheck(): Promise<ProviderHealth> {
    if (!config.GOOGLE_PLACES_API_KEY) {
      return { status: 'DOWN', error: 'GOOGLE_PLACES_API_KEY not configured', checkedAt: new Date() };
    }
    try {
      await withRetry((signal) => searchNearby({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() }, signal), { attempts: 1 });
      return { status: 'ACTIVE', checkedAt: new Date() };
    } catch (err) {
      return { status: 'DOWN', error: String(err), checkedAt: new Date() };
    }
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    if (!config.GOOGLE_PLACES_API_KEY) return [];

    let places: GPlace[] = [];
    try {
      const data = await withRetry((signal) => searchNearby(params, signal), FETCH_RETRY);
      places = data.places ?? [];
    } catch (err) {
      logger.warn({ err, city: params.city }, 'Google Places API (New) query failed — no Google Places inventory this sync');
      return [];
    }

    const listings: RawListing[] = [];
    for (const place of places) {
      const category = mapCategory(place.types);
      if (!category || !place.displayName?.text || !place.location) {
        continue; // an unrecognised type, or a malformed row missing a name/location — dropped, not guessed
      }
      listings.push({ externalId: place.id, raw: { ...place, __category: category } });
    }
    return listings;
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const place = listing.raw as GPlace & { __category: ExperienceCategory };
    const category = place.__category;
    const isDining = category === 'RESTAURANT';
    const image = photoUrl(place.photos);

    return {
      name: place.displayName?.text ?? 'Unnamed venue',
      description: `${place.displayName?.text ?? 'This venue'}${place.formattedAddress ? ` — ${place.formattedAddress}` : ''}.`,
      category,
      subcategories: (place.types ?? []).map((t) => t.replace(/_/g, ' ')),
      venueName: place.displayName?.text ?? 'Unnamed venue',
      latitude: place.location?.latitude ?? 0,
      longitude: place.location?.longitude ?? 0,
      startsAt: nextSensibleTime(isDining ? 19 : 20),
      endsAt: null,
      timezone: 'Europe/London',
      // Google's priceLevel is a coarse 6-value enum, never a real minor-unit amount — honestly
      // left null rather than guessed (kept in tags as `priceLevel` instead, see priceLevelLabel).
      priceMinMinor: null,
      priceMaxMinor: null,
      currency: 'GBP',
      bookingStatus: 'AVAILABLE',
      imageUrl: image,
      imageSource: image ? 'GOOGLE_PLACES' : null,
      tags: {
        provider: 'google_places',
        priceLevel: priceLevelLabel(place.priceLevel),
        rating: place.rating ?? null,
        userRatingCount: place.userRatingCount ?? null,
      },
      // A real, working Google Maps place page — never a fabricated booking link. Falls back to
      // the venue's own website if Google somehow gives no Maps URI (not expected in practice).
      externalUrl: place.googleMapsUri ?? place.websiteUri ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.formattedAddress ?? place.displayName?.text ?? 'UK')}`,
      commissionEligible: false,
    };
  },
};
