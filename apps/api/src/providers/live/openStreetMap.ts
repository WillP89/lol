import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams, ProviderHealth } from '../types';
import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import { UK_PLACES, UK_FALLBACK_CENTER, type UkPlace } from '../../data/ukPlaces';

/**
 * Real OpenStreetMap adapter (queried via the Overpass API) — the PLOT-CONTENT directive's
 * "food must become real" gap, closed with zero credential required. This is the ONE genuinely
 * self-serve, no-key source found for restaurants/cafes/bars/pubs/museums/markets/attractions
 * after researching the realistic options (Yelp Fusion moved to paid-only in 2024, no free
 * tier; Foursquare's free tier excludes its Photos endpoint — Premium-only; OpenTable/Resy/
 * SevenRooms are all partner-gated, already documented in docs/providers/restaurants.md).
 * OpenStreetMap's data is crowd-mapped but genuinely real — actual venue names, addresses,
 * coordinates, opening hours, cuisines, websites — not fabricated.
 *
 * `isLive` is always true here — no credential exists to be missing. `healthCheck` still exists
 * because the PUBLIC Overpass instance itself can be down or rate-limiting (directive §16
 * "provider failure handling" — one provider's outage must not break the others).
 *
 * NOT exercised against the live Overpass API from this environment — outbound network to
 * overpass-api.de is blocked from the sandbox this was written in (confirmed via both direct
 * curl and the WebFetch tool; the same restriction that blocks Ticketmaster/Eventbrite/
 * Postmark/Wikipedia). Overpass QL's query syntax and JSON response shape have been stable and
 * publicly documented for well over a decade — verify against Render's own logs once deployed.
 *
 * Licensing: OpenStreetMap data is © OpenStreetMap contributors, ODbL-licensed — attribution is
 * a real requirement of using it, not a courtesy. See routes exposing this data / the web
 * client for where that attribution actually renders (Explore's provider-source line).
 *
 * Rate limits: the public overpass-api.de instance has no published hard quota but is a shared
 * community resource — "moderate" query volume, not the polling cadence a paid API would
 * tolerate. `MAX_RESULTS_PER_CITY` bounds the query radius/result count deliberately small, and
 * `withRetry`'s backoff (shared with every other adapter) handles the occasional 429/504 this
 * kind of public instance is known to return under load. A dedicated Overpass instance (or a
 * self-hosted one) would be the right upgrade once sync volume grows — see docs/providers/
 * food-and-places.md.
 */

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const SEARCH_RADIUS_METERS = 6000; // dining/nightlife — a real "worth the trip" catchment, not a whole county
const CULTURE_RADIUS_METERS = 9000; // museums/attractions/markets are sparser — search a bit wider
const MAX_RESULTS = 60; // keeps one sync run's DB writes and the shared Overpass instance's load bounded

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OsmElement[];
}

/** OSM's tagging vocabulary (amenity/tourism/leisure/shop, each with many free-text values) is
 * far richer than Plot's ExperienceCategory — this is a deliberately small, high-confidence
 * mapping covering the tags actually queried below, not an attempt to map all of OSM. */
function mapCategory(tags: Record<string, string>): ExperienceCategory {
  const amenity = tags.amenity;
  const tourism = tags.tourism;
  const leisure = tags.leisure;
  if (amenity === 'bar' || amenity === 'pub') return 'BAR';
  if (amenity === 'restaurant' || amenity === 'cafe' || amenity === 'fast_food' || amenity === 'marketplace') return 'RESTAURANT';
  if (tourism === 'museum' || tourism === 'gallery' || tourism === 'attraction') return 'ART_CULTURE';
  if (leisure) return 'DAY_ACTIVITY';
  return 'COMMUNITY';
}

function label(tags: Record<string, string>): string {
  if (tags.amenity === 'marketplace') return 'Market';
  if (tags.tourism === 'museum') return 'Museum';
  if (tags.tourism === 'gallery') return 'Gallery';
  if (tags.tourism === 'attraction') return 'Attraction';
  if (tags.leisure) return tags.leisure.replace(/_/g, ' ');
  return tags.cuisine ? tags.cuisine.split(';')[0].replace(/_/g, ' ') : (tags.amenity ?? 'Place').replace(/_/g, ' ');
}

/** OSM has no notion of a booking slot — the honest convention here (matching
 * providers/mock/restaurantProvider.ts's existing one) is "the next sensible time to go":
 * `hour` tonight if that hasn't passed yet, else tomorrow at `hour`. Not a real reservation
 * time, never presented as one (bookingStatus stays 'AVAILABLE', externalUrl is the venue's
 * real site/OSM page, not a fake booking link). */
function nextSensibleTime(hour: number): Date {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(hour, 0, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function coordsOf(el: OsmElement): { lat: number; lon: number } | null {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lon: el.lon };
  if (el.center) return el.center;
  return null;
}

/** A direct raster file — OSM's free-text `image` tag is sometimes a real photo URL, sometimes
 * a Wikimedia Commons wiki PAGE (e.g. `.../wiki/File:Example.jpg` — not itself a renderable
 * image, despite ending in what looks like an image extension). Real bug this exact check
 * catches, found by its own unit test: a plain file-extension regex matches that wiki-page URL
 * too, since MediaWiki page titles for files are literally named after the filename. Reject any
 * `/wiki/` path first — only a URL that is BOTH extension-shaped AND not a wiki page view is
 * trusted, never rendered as an <img> src otherwise. */
function directImageTag(tags: Record<string, string>): string | null {
  const raw = tags.image;
  if (!raw) return null;
  if (/\/wiki\//i.test(raw)) return null;
  return /\.(jpe?g|png|webp)(\?.*)?$/i.test(raw) ? raw : null;
}

function resolveCityCenter(city: string): UkPlace {
  const exact = UK_PLACES.find((p) => p.name.toLowerCase() === city.trim().toLowerCase());
  return exact ?? UK_FALLBACK_CENTER;
}

function buildQuery(center: UkPlace): string {
  const { lat, lng } = center;
  return `[out:json][timeout:25];(
    node["amenity"~"^(restaurant|cafe|bar|pub|fast_food)$"]["name"](around:${SEARCH_RADIUS_METERS},${lat},${lng});
    way["amenity"~"^(restaurant|cafe|bar|pub|fast_food)$"]["name"](around:${SEARCH_RADIUS_METERS},${lat},${lng});
    node["amenity"="marketplace"]["name"](around:${CULTURE_RADIUS_METERS},${lat},${lng});
    node["tourism"~"^(museum|gallery|attraction)$"]["name"](around:${CULTURE_RADIUS_METERS},${lat},${lng});
    way["tourism"~"^(museum|gallery|attraction)$"]["name"](around:${CULTURE_RADIUS_METERS},${lat},${lng});
    node["leisure"~"^(escape_game|bowling_alley|trampoline_park|amusement_arcade)$"]["name"](around:${CULTURE_RADIUS_METERS},${lat},${lng});
  );
  out center tags ${MAX_RESULTS};`;
}

async function runQuery(center: UkPlace, signal: AbortSignal): Promise<OsmElement[]> {
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Plot/1.0 (https://plotmaker.co.uk; discovery)' },
    body: buildQuery(center),
  });
  if (!res.ok) {
    throw new Error(`Overpass API returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = (await res.json()) as OverpassResponse;
  return data.elements ?? [];
}

export const openStreetMapProvider: ProviderAdapter = {
  id: 'openstreetmap',
  displayName: 'OpenStreetMap',
  categories: ['RESTAURANT', 'BAR', 'ART_CULTURE', 'DAY_ACTIVITY', 'COMMUNITY'],
  isLive: true, // no credential — a public API, always "configured"

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await withRetry((signal) => runQuery(UK_FALLBACK_CENTER, signal), { attempts: 1, timeoutMs: 10_000 });
      return { status: 'ACTIVE', checkedAt: new Date() };
    } catch (err) {
      return { status: 'DOWN', error: String(err), checkedAt: new Date() };
    }
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    const center = resolveCityCenter(params.city);
    let elements: OsmElement[];
    try {
      elements = await withRetry((signal) => runQuery(center, signal), { timeoutMs: 15_000 });
    } catch (err) {
      logger.warn({ err, city: params.city }, 'Overpass query failed — no OpenStreetMap inventory this sync');
      return [];
    }

    const listings: RawListing[] = [];
    for (const el of elements) {
      const tags = el.tags ?? {};
      const coords = coordsOf(el);
      if (!tags.name || !coords) continue; // unnamed or geometry-less POIs aren't useful to show
      listings.push({ externalId: `${el.type}/${el.id}`, raw: { ...el, tags, lat: coords.lat, lon: coords.lon } });
    }
    return listings;
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const el = listing.raw as OsmElement & { lat: number; lon: number; tags: Record<string, string> };
    const tags = el.tags;
    const category = mapCategory(tags);
    const isDining = category === 'RESTAURANT' || category === 'BAR';
    const startsAt = nextSensibleTime(isDining ? 19 : 11);
    const image = directImageTag(tags);
    const website = tags.website ?? tags['contact:website'];

    return {
      name: tags.name,
      description: `${label(tags)}${tags['addr:suburb'] || tags['addr:city'] ? ` in ${tags['addr:suburb'] ?? tags['addr:city']}` : ''}.`,
      category,
      subcategories: tags.cuisine ? tags.cuisine.split(';').map((c) => c.trim()) : [],
      venueName: tags.name,
      latitude: el.lat,
      longitude: el.lon,
      startsAt,
      endsAt: null,
      timezone: 'Europe/London',
      // Overpass has no reliable price data — left unknown rather than guessed; the quality
      // scorer correctly marks this down relative to a source (Ticketmaster) that has real
      // prices, which is the scorer doing its job, not a bug.
      priceMinMinor: null,
      priceMaxMinor: null,
      currency: 'GBP',
      bookingStatus: 'AVAILABLE',
      imageUrl: image,
      imageSource: image ? 'OPENSTREETMAP' : null,
      tags: { provider: 'openstreetmap', osmType: el.type, osmId: el.id, cuisine: tags.cuisine ?? null },
      // A real website when OSM has one; otherwise a real, working OpenStreetMap.org permalink
      // for this exact node/way — never a fabricated `.invalid` URL like the mock providers use.
      externalUrl: website ?? `https://www.openstreetmap.org/${el.type}/${el.id}`,
      commissionEligible: false,
    };
  },
};
