import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams, ProviderHealth } from '../types';
import { withRetry } from '../../lib/retry';
import { config } from '../../lib/config';
import { logger } from '../../lib/logger';

/**
 * Real Eventbrite API v3 adapter — self-serve, free (developer.eventbrite.com), no partner
 * agreement needed to GET a key, unlike DICE/OpenTable. See docs/providers/ticketing.md.
 *
 * IMPORTANT CAVEAT, read before assuming this "just works" once a key is set: Eventbrite
 * significantly restricted its public API around 2020. A fresh self-serve key is confirmed to
 * be able to read events belonging to *your own* Eventbrite organization; whether the general
 * public search this adapter calls (`GET /v3/events/search/`, historically how a third-party
 * app browsed ALL public Eventbrite listings in a city) is still available to new apps is
 * genuinely uncertain from here — this environment can't reach api.eventbrite.com to check,
 * the same restriction that blocks Ticketmaster/Postmark. Before relying on this: set
 * EVENTBRITE_API_KEY, then from anywhere with real network access run
 *   curl -H "Authorization: Bearer $EVENTBRITE_API_KEY" \
 *     "https://www.eventbriteapi.com/v3/events/search/?location.address=Stafford,UK"
 * A 200 with real event results confirms this works as written. A 404 or an empty/
 * organization-scoped result means the search endpoint is no longer available to a new key,
 * and this adapter needs a different Eventbrite endpoint (or Eventbrite isn't a real option
 * for public discovery anymore) — tell me which you see and I'll adjust.
 */

const SEARCH_BASE = 'https://www.eventbriteapi.com/v3/events/search/';
const PAGE_SIZE = 50;
const MAX_PAGES = 3;

interface EbImage {
  url: string;
}
interface EbVenue {
  name?: string;
  address?: { city?: string; latitude?: string; longitude?: string };
}
interface EbCategory {
  name?: string;
}
interface EbEvent {
  id: string;
  name?: { text?: string };
  description?: { text?: string };
  url: string;
  start?: { utc?: string };
  end?: { utc?: string };
  logo?: EbImage;
  is_free?: boolean;
  venue?: EbVenue;
  category?: EbCategory;
  status?: string;
}
interface EbSearchResponse {
  events?: EbEvent[];
  pagination?: { page_count?: number };
}

/** Eventbrite's category taxonomy (a free-text name, not a stable enum in the search response)
 * doesn't map cleanly onto Plot's ExperienceCategory — best-effort by keyword, COMMUNITY for
 * anything unrecognised (Eventbrite's own catalogue skews toward exactly that: markets,
 * workshops, local meetups — genuinely COMMUNITY, not a mapping failure). */
function mapCategory(categoryName: string | undefined): ExperienceCategory {
  const name = (categoryName ?? '').toLowerCase();
  if (name.includes('music')) return 'LIVE_MUSIC';
  if (name.includes('food') || name.includes('drink')) return 'RESTAURANT';
  if (name.includes('film') || name.includes('media')) return 'CINEMA';
  if (name.includes('sport') || name.includes('fitness')) return 'SPORT';
  if (name.includes('comedy')) return 'COMEDY';
  if (name.includes('theatre') || name.includes('performing arts')) return 'THEATRE';
  if (name.includes('art')) return 'ART_CULTURE';
  if (name.includes('festival')) return 'FESTIVAL';
  if (name.includes('outdoor') || name.includes('hobbies')) return 'DAY_ACTIVITY';
  return 'COMMUNITY';
}

async function fetchPage(params: FetchListingsParams, page: number, signal: AbortSignal): Promise<EbSearchResponse> {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set('location.address', `${params.city}, UK`);
  url.searchParams.set('start_date.range_start', params.fromDate.toISOString());
  url.searchParams.set('start_date.range_end', params.toDate.toISOString());
  url.searchParams.set('page_size', String(PAGE_SIZE));
  url.searchParams.set('page', String(page + 1)); // Eventbrite pages are 1-indexed
  url.searchParams.set('expand', 'venue,category');

  const res = await fetch(url.toString(), {
    signal,
    headers: { Authorization: `Bearer ${config.EVENTBRITE_API_KEY ?? ''}` },
  });
  if (!res.ok) {
    throw new Error(`Eventbrite search API returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as EbSearchResponse;
}

export const eventbriteProvider: ProviderAdapter = {
  id: 'eventbrite',
  displayName: 'Eventbrite',
  categories: ['LIVE_MUSIC', 'RESTAURANT', 'CINEMA', 'SPORT', 'COMEDY', 'THEATRE', 'ART_CULTURE', 'FESTIVAL', 'DAY_ACTIVITY', 'COMMUNITY'],
  isLive: Boolean(config.EVENTBRITE_API_KEY),

  async healthCheck(): Promise<ProviderHealth> {
    if (!config.EVENTBRITE_API_KEY) {
      return { status: 'DOWN', error: 'EVENTBRITE_API_KEY not configured', checkedAt: new Date() };
    }
    try {
      await withRetry((signal) => fetchPage({ city: 'London', fromDate: new Date(), toDate: new Date() }, 0, signal), { attempts: 1 });
      return { status: 'ACTIVE', checkedAt: new Date() };
    } catch (err) {
      return { status: 'DOWN', error: String(err), checkedAt: new Date() };
    }
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    if (!config.EVENTBRITE_API_KEY) return [];

    const events: EbEvent[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await withRetry((signal) => fetchPage(params, page, signal));
      const pageEvents = data.events ?? [];
      events.push(...pageEvents);
      const totalPages = data.pagination?.page_count ?? 1;
      if (page + 1 >= totalPages || pageEvents.length === 0) break;
    }

    const listings: RawListing[] = [];
    for (const event of events) {
      if (event.status && event.status !== 'live') continue; // draft/cancelled/etc — not bookable
      const lat = event.venue?.address?.latitude ? Number(event.venue.address.latitude) : NaN;
      const lng = event.venue?.address?.longitude ? Number(event.venue.address.longitude) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        logger.warn({ eventId: event.id }, 'Eventbrite event missing venue coordinates — skipped');
        continue;
      }
      listings.push({ externalId: event.id, raw: event });
    }
    return listings;
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const event = listing.raw as EbEvent;
    const lat = Number(event.venue?.address?.latitude);
    const lng = Number(event.venue?.address?.longitude);
    const name = event.name?.text ?? 'Untitled event';

    return {
      name,
      description: event.description?.text?.slice(0, 500) ?? `${name}${event.venue?.name ? ` at ${event.venue.name}` : ''}.`,
      category: mapCategory(event.category?.name),
      subcategories: event.category?.name ? [event.category.name] : [],
      venueName: event.venue?.name ?? 'Venue TBC',
      latitude: lat,
      longitude: lng,
      startsAt: event.start?.utc ? new Date(event.start.utc) : new Date(),
      endsAt: event.end?.utc ? new Date(event.end.utc) : null,
      timezone: 'Europe/London',
      // Eventbrite's search response doesn't reliably include ticket price tiers (that needs a
      // separate /events/:id/ticket_classes/ call per event) — free events are the one case we
      // can say something concrete about; everything else is genuinely unknown until clicked
      // through, not "£0".
      priceMinMinor: event.is_free ? 0 : null,
      priceMaxMinor: null,
      currency: 'GBP',
      bookingStatus: 'UNKNOWN',
      imageUrl: event.logo?.url ?? null,
      tags: { provider: 'eventbrite', category: event.category?.name ?? null },
      externalUrl: event.url,
      commissionEligible: false,
    };
  },
};
