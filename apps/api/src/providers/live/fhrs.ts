import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams, ProviderHealth } from '../types';
import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import { UK_FALLBACK_CENTER, resolveCityCenter, type UkPlace } from '../../data/ukPlaces';

/**
 * Real UK Food Standards Agency Food Hygiene Rating Scheme (FHRS) adapter — the strongest find
 * from researching "every open API" for restaurant/food coverage (live product report: "the
 * restaurants and food options right now are shocking"). This is OFFICIAL UK GOVERNMENT open
 * data: every food business registered with a local authority in England, Wales and Northern
 * Ireland (restaurants, takeaways, pubs, cafes) — real name, real address, real geocoded
 * location, real business type, real published hygiene rating. Genuinely free, genuinely
 * self-serve, no API key or approval process at all — a real government open-data API, not a
 * commercial product with a free tier that could change.
 *
 * `isLive` is always true here, same as OpenStreetMap — no credential exists to be missing.
 * Registered as a SECOND, independent restaurant-discovery source alongside OpenStreetMap
 * (services/entityResolution.ts's own dedup already handles the same real venue appearing in
 * both sources), not a replacement — FHRS's national-register coverage and OSM's crowd-mapped
 * coverage each catch real venues the other one's contributors happened to miss.
 *
 * What this does NOT give: opening hours, cuisine type, price, photos, or booking availability —
 * FHRS is a hygiene register, not a places-discovery product. `startsAt` uses the same honest
 * "next sensible time to go" convention as openStreetMap.ts (never a real reservation slot);
 * `imageUrl` is left null (falls into inventorySync.ts's own enrichment chain, same as every
 * other image-less source).
 *
 * NOT exercised against the live API from this environment — outbound network to
 * api.ratings.food.gov.uk is blocked from this sandbox, the same restriction documented on
 * every other live adapter in this codebase. Written against the FSA's own publicly documented
 * FHRS Open Data API (api.ratings.food.gov.uk) — the endpoint shape, `x-api-version` header
 * requirement, and field names (BusinessName, BusinessType, RatingValue, geocode, ...) have been
 * publicly stable for years; verify against Render's own logs once deployed, same discipline as
 * every other adapter here.
 *
 * Scotland is NOT covered by FHRS — it runs its own, separately-published Food Hygiene
 * Information Scheme (FHIS) with different open data. Out of scope for this first pass; a real,
 * addressable follow-up if Scottish coverage becomes a live gap (see this file's own
 * `SCOTLAND_NOTE` below for exactly why nothing here silently fails for a Scottish city).
 */

const FHRS_BASE = 'https://api.ratings.food.gov.uk/Establishments';
const SEARCH_RADIUS_MILES = 4; // roughly the same "worth the trip" catchment as OSM's own 6km dining radius
const PAGE_SIZE = 100;
const MAX_PAGES = 2; // bounded the same way every other adapter's own MAX_PAGES is — one of several sources one sync runs concurrently
const FETCH_RETRY = { attempts: 2, timeoutMs: 8_000 }; // same shape as OpenStreetMap's own FETCH_RETRY

// Real, honest reason this doesn't just silently return nothing for a Scottish city: FHRS's own
// API accepts any UK lat/lng and will not error for Scotland, it will simply — correctly —
// return few or no results, since Scottish authorities publish through FHIS instead, not FHRS.
// Logged (not silently swallowed) so an operator investigating "why is Glasgow thin on food
// results" finds this explanation rather than assuming the adapter is broken.
const SCOTLAND_NOTE =
  'FHRS (this adapter) only covers England/Wales/NI — Scottish establishments are published separately via Food Hygiene Information Scotland (FHIS), not integrated here yet.';

interface FhrsGeocode {
  longitude?: string;
  latitude?: string;
}

interface FhrsEstablishment {
  FHRSID: number;
  BusinessName: string;
  BusinessType?: string;
  AddressLine1?: string;
  AddressLine2?: string;
  AddressLine3?: string;
  AddressLine4?: string;
  PostCode?: string;
  RatingValue?: string; // '5'..'0', or 'Exempt'/'AwaitingInspection'/'AwaitingPublication' — never numeric-guaranteed
  RatingDate?: string;
  LocalAuthorityName?: string;
  geocode?: FhrsGeocode;
}

interface FhrsSearchResponse {
  establishments?: FhrsEstablishment[];
  meta?: { totalCount?: number; totalPages?: number };
}

/**
 * FHRS's own BusinessType taxonomy is a fixed, published list — this maps only the values that
 * are genuinely a real, visitable food-and-drink venue onto Plot's ExperienceCategory. Every
 * other BusinessType (School/College/University, Hospitals/Childcare/Caring Premises,
 * Manufacturers/packers, Farmers/growers, Distributors/Transporters, Retailers) is deliberately
 * NOT mapped — these are real FHRS entries but not somewhere a Crew would go for a night out, and
 * `fetchListings` below drops them before they ever reach the database, the same honest filtering
 * every other adapter applies to its own source's irrelevant categories.
 */
function mapCategory(businessType: string | undefined): ExperienceCategory | null {
  switch (businessType) {
    case 'Restaurant/Cafe/Canteen':
    case 'Takeaway/sandwich shop':
    case 'Mobile caterer': // real, honest home for street food stalls/vans — exactly the category this adapter exists to strengthen
    case 'Other catering premises':
      return 'RESTAURANT';
    case 'Pub/bar/nightclub':
      return 'BAR';
    default:
      return null;
  }
}

function formatAddress(e: FhrsEstablishment): string {
  return [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4, e.PostCode].filter(Boolean).join(', ');
}

/** Same honest convention as openStreetMap.ts's own nextSensibleTime — FHRS has no booking-slot
 *  concept at all, so this is never presented as a real reservation time. */
function nextSensibleTime(hour: number): Date {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(hour, 0, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/** FHRS gives no public venue-page permalink field usable without separate confirmation of its
 *  exact URL format — rather than guess at one, this uses the same honest Google Maps search
 *  fallback PredictHQ's own adapter uses for a real address FHRS DOES give us. Never a fabricated
 *  booking or menu link. */
function externalUrlFor(e: FhrsEstablishment): string {
  const query = formatAddress(e) || `${e.BusinessName} UK`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

async function fetchPage(center: UkPlace, pageNumber: number, signal: AbortSignal): Promise<FhrsSearchResponse> {
  const url = new URL(FHRS_BASE);
  url.searchParams.set('latitude', String(center.lat));
  url.searchParams.set('longitude', String(center.lng));
  url.searchParams.set('maxDistanceLimit', String(SEARCH_RADIUS_MILES));
  url.searchParams.set('sortOptionKey', 'distance');
  url.searchParams.set('pageNumber', String(pageNumber));
  url.searchParams.set('pageSize', String(PAGE_SIZE));

  const res = await fetch(url.toString(), {
    signal,
    headers: { 'x-api-version': '2', Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`FHRS Open Data API returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as FhrsSearchResponse;
}

export const fhrsProvider: ProviderAdapter = {
  id: 'fhrs',
  displayName: 'Food Standards Agency (FHRS)',
  categories: ['RESTAURANT', 'BAR'],
  isLive: true, // no credential — official government open data, always "configured"

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await withRetry((signal) => fetchPage(UK_FALLBACK_CENTER, 1, signal), { attempts: 1, timeoutMs: 10_000 });
      return { status: 'ACTIVE', checkedAt: new Date() };
    } catch (err) {
      return { status: 'DOWN', error: String(err), checkedAt: new Date() };
    }
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    const center = resolveCityCenter(params.city);
    const establishments: FhrsEstablishment[] = [];
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await withRetry((signal) => fetchPage(center, page, signal), FETCH_RETRY);
        const pageResults = data.establishments ?? [];
        establishments.push(...pageResults);
        const totalPages = data.meta?.totalPages ?? 1;
        if (page >= totalPages || pageResults.length === 0) break;
      }
    } catch (err) {
      logger.warn({ err, city: params.city }, 'FHRS Open Data API query failed — no FHRS inventory this sync');
      return [];
    }
    if (establishments.length === 0) logger.info({ city: params.city, note: SCOTLAND_NOTE }, 'FHRS returned zero establishments for this city');

    const listings: RawListing[] = [];
    for (const e of establishments) {
      const category = mapCategory(e.BusinessType);
      const lat = e.geocode?.latitude ? Number(e.geocode.latitude) : NaN;
      const lng = e.geocode?.longitude ? Number(e.geocode.longitude) : NaN;
      if (!category || !e.BusinessName || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      listings.push({ externalId: String(e.FHRSID), raw: { ...e, __lat: lat, __lng: lng, __category: category } });
    }
    return listings;
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const e = listing.raw as FhrsEstablishment & { __lat: number; __lng: number; __category: ExperienceCategory };
    const category = e.__category;
    const isDining = category === 'RESTAURANT';
    const address = formatAddress(e);

    return {
      name: e.BusinessName,
      description: `${e.BusinessType ?? 'Food business'}${address ? ` — ${address}` : ''}.`,
      category,
      // A real, if coarse, signal — "takeaway"/"mobile caterer" genuinely helps street-food
      // matching even without a cuisine tag (FHRS has none), the same honest "coarser than a
      // taxonomy match but still real evidence" convention this codebase already applies to OSM's
      // own subcategories.
      subcategories: e.BusinessType ? [e.BusinessType.toLowerCase()] : [],
      venueName: e.BusinessName,
      latitude: e.__lat,
      longitude: e.__lng,
      startsAt: nextSensibleTime(isDining ? 19 : 20),
      endsAt: null,
      timezone: 'Europe/London',
      // FHRS is a hygiene register, not a ticketing/booking site — genuinely no price data,
      // honestly left null rather than guessed, same posture as OpenStreetMap/PredictHQ.
      priceMinMinor: null,
      priceMaxMinor: null,
      currency: 'GBP',
      bookingStatus: 'AVAILABLE',
      imageUrl: null, // no image data — falls into inventorySync.ts's own enrichment chain
      imageSource: null,
      tags: {
        provider: 'fhrs',
        businessType: e.BusinessType ?? null,
        hygieneRating: e.RatingValue ?? null,
        localAuthority: e.LocalAuthorityName ?? null,
      },
      externalUrl: externalUrlFor(e),
      commissionEligible: false,
    };
  },
};
