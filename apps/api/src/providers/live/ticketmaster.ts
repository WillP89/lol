import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams, ProviderHealth } from '../types';
import { withRetry } from '../../lib/retry';
import { config } from '../../lib/config';
import { logger } from '../../lib/logger';
import { UK_FALLBACK_CENTER } from '../../data/ukPlaces';

/**
 * Real Ticketmaster Discovery API v2 adapter — see docs/providers/ticketing.md for access
 * details (self-serve key, read-only event data; real commission needs their invite-only
 * Partner API, a separate business conversation). `isLive` is false — and this adapter is
 * simply not registered — whenever TICKETMASTER_API_KEY isn't set; see registry.ts. Nothing
 * here has been exercised against a live key from this environment (outbound network to
 * app.ticketmaster.com isn't reachable from the dev sandbox this was written in) — verify
 * against Render's logs once a real key is configured there.
 */

const DISCOVERY_BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';
const PAGE_SIZE = 100;

// Ticketmaster's own docs list 5 req/s / 5000 req/day on the free tier. withRetry's backoff
// handles a stray 429; this cap keeps a single sync from blowing through the daily quota by
// itself if a city genuinely has more than a few hundred events in the window.
const MAX_PAGES = 3;

interface TmImage {
  url: string;
  width: number;
  height: number;
  ratio?: string;
}

interface TmVenue {
  name?: string;
  city?: { name?: string };
  location?: { latitude?: string; longitude?: string };
  address?: { line1?: string };
}

interface TmClassification {
  segment?: { name?: string };
  genre?: { name?: string };
  subGenre?: { name?: string };
}

interface TmEvent {
  id: string;
  name: string;
  url: string;
  images?: TmImage[];
  dates?: {
    start?: { dateTime?: string; localDate?: string; localTime?: string };
    status?: { code?: string };
  };
  classifications?: TmClassification[];
  priceRanges?: { min?: number; max?: number; currency?: string }[];
  _embedded?: { venues?: TmVenue[] };
}

interface TmSearchResponse {
  _embedded?: { events?: TmEvent[] };
  page?: { totalPages?: number };
}

/**
 * Ticketmaster's classification taxonomy (segment/genre/subGenre) doesn't line up 1:1 with
 * Plot's ExperienceCategory — this is a best-effort mapping, not a lossless one. Unrecognised
 * segments fall back to COMMUNITY rather than being dropped, since an unmapped category still
 * beats losing a real event entirely.
 *
 * Real gap this closes: FESTIVAL was never once returned by this function — a genuine event
 * ("where are the food festivals?") is exactly what that category exists for. Ticketmaster's
 * own data doesn't have a dedicated "Festival" segment; a festival is a genre/subGenre value
 * (e.g. "Festival", or a specific one like "Food & Drink Festival") most commonly nested under
 * the Music or Miscellaneous segment, not something the segment-first checks below would ever
 * reach. Checked first, across every segment, so a festival is never mis-mapped to LIVE_MUSIC
 * (or COMMUNITY) just because of which segment Ticketmaster happened to file it under.
 */
function mapCategory(classifications: TmClassification[] | undefined): ExperienceCategory {
  const segment = classifications?.[0]?.segment?.name?.toLowerCase() ?? '';
  const genre = classifications?.[0]?.genre?.name?.toLowerCase() ?? '';
  const subGenre = classifications?.[0]?.subGenre?.name?.toLowerCase() ?? '';

  if (genre.includes('festival') || subGenre.includes('festival')) return 'FESTIVAL';
  if (segment === 'music') return 'LIVE_MUSIC';
  if (segment === 'sports') return 'SPORT';
  if (segment === 'film') return 'CINEMA';
  if (segment === 'arts & theatre' || segment === 'arts &amp; theatre') {
    if (genre.includes('comedy')) return 'COMEDY';
    if (genre.includes('theatre') || genre.includes('musical')) return 'THEATRE';
    return 'ART_CULTURE';
  }
  if (genre.includes('comedy')) return 'COMEDY';
  return 'COMMUNITY';
}

function mapBookingStatus(statusCode: string | undefined): CanonicalListingInput['bookingStatus'] {
  switch (statusCode) {
    case 'onsale':
      return 'AVAILABLE';
    case 'cancelled':
      return 'SOLD_OUT'; // excluded from Match's candidate pool, same effect as genuinely sold out
    case 'offsale':
    case 'postponed':
    case 'rescheduled':
    default:
      return 'UNKNOWN';
  }
}

function bestImage(images: TmImage[] | undefined): string | null {
  if (!images?.length) return null;
  // Prefer a wide 16:9 image (Ticketmaster's standard promo crop) over square/portrait ones.
  const wide = images.find((img) => img.ratio === '16_9' && img.width >= 640);
  return (wide ?? images[0]).url;
}

async function fetchPage(params: FetchListingsParams, page: number, signal: AbortSignal): Promise<TmSearchResponse> {
  const url = new URL(DISCOVERY_BASE);
  url.searchParams.set('apikey', config.TICKETMASTER_API_KEY ?? '');
  url.searchParams.set('city', params.city);
  url.searchParams.set('countryCode', 'GB');
  url.searchParams.set('startDateTime', params.fromDate.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  url.searchParams.set('endDateTime', params.toDate.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  url.searchParams.set('size', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('sort', 'date,asc');

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) {
    throw new Error(`Ticketmaster Discovery API returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as TmSearchResponse;
}

export const ticketmasterProvider: ProviderAdapter = {
  id: 'ticketmaster',
  displayName: 'Ticketmaster',
  categories: ['LIVE_MUSIC', 'SPORT', 'CINEMA', 'ART_CULTURE', 'THEATRE', 'COMEDY', 'COMMUNITY'],
  isLive: Boolean(config.TICKETMASTER_API_KEY),

  async healthCheck(): Promise<ProviderHealth> {
    if (!config.TICKETMASTER_API_KEY) {
      return { status: 'DOWN', error: 'TICKETMASTER_API_KEY not configured', checkedAt: new Date() };
    }
    try {
      // Any real UK city works as a smoke test; a genuinely UK-central, high-event-density one
      // (not London specifically — see docs/DECISIONS.md#uk-wide-location) avoids a false "DOWN"
      // reading from a smaller town simply having zero events today.
      await withRetry((signal) => fetchPage({ city: UK_FALLBACK_CENTER.name, fromDate: new Date(), toDate: new Date() }, 0, signal), { attempts: 1 });
      return { status: 'ACTIVE', checkedAt: new Date() };
    } catch (err) {
      return { status: 'DOWN', error: String(err), checkedAt: new Date() };
    }
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    if (!config.TICKETMASTER_API_KEY) return [];

    const events: TmEvent[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await withRetry((signal) => fetchPage(params, page, signal));
      const pageEvents = data._embedded?.events ?? [];
      events.push(...pageEvents);
      const totalPages = data.page?.totalPages ?? 1;
      if (page + 1 >= totalPages || pageEvents.length === 0) break;
    }

    // One malformed event (missing venue coordinates, mainly — Ticketmaster occasionally
    // returns a venue with no lat/lng) is dropped and logged, not allowed to fail the sync.
    const listings: RawListing[] = [];
    for (const event of events) {
      const venue = event._embedded?.venues?.[0];
      const lat = venue?.location?.latitude ? Number(venue.location.latitude) : NaN;
      const lng = venue?.location?.longitude ? Number(venue.location.longitude) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        logger.warn({ eventId: event.id, name: event.name }, 'Ticketmaster event missing venue coordinates — skipped');
        continue;
      }
      listings.push({ externalId: event.id, raw: event });
    }
    return listings;
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const event = listing.raw as TmEvent;
    const venue = event._embedded?.venues?.[0];
    const lat = Number(venue?.location?.latitude);
    const lng = Number(venue?.location?.longitude);
    const priceRange = event.priceRanges?.[0];
    const startsAtIso = event.dates?.start?.dateTime ?? (event.dates?.start?.localDate ? `${event.dates.start.localDate}T${event.dates.start.localTime ?? '20:00:00'}` : null);

    return {
      name: event.name,
      description: `${event.name}${venue?.name ? ` at ${venue.name}` : ''}.`,
      category: mapCategory(event.classifications),
      subcategories: (event.classifications?.[0]?.genre?.name ? [event.classifications[0].genre!.name!] : []) as string[],
      venueName: venue?.name ?? 'Venue TBC',
      latitude: lat,
      longitude: lng,
      startsAt: startsAtIso ? new Date(startsAtIso) : new Date(),
      endsAt: null, // Discovery API doesn't reliably provide an end time
      timezone: 'Europe/London',
      priceMinMinor: priceRange?.min !== undefined ? Math.round(priceRange.min * 100) : null,
      priceMaxMinor: priceRange?.max !== undefined ? Math.round(priceRange.max * 100) : null,
      currency: priceRange?.currency ?? 'GBP',
      bookingStatus: mapBookingStatus(event.dates?.status?.code),
      imageUrl: bestImage(event.images),
      imageSource: bestImage(event.images) ? 'TICKETMASTER' : null,
      tags: {
        provider: 'ticketmaster',
        genre: event.classifications?.[0]?.genre?.name ?? null,
      },
      externalUrl: event.url,
      commissionEligible: false, // Discovery API only — see docs/providers/ticketing.md
    };
  },
};
