import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams, ProviderHealth } from '../types';
import { withRetry } from '../../lib/retry';
import { config } from '../../lib/config';
import { logger } from '../../lib/logger';
import { resolveCityCenter } from '../../data/ukPlaces';

/**
 * Real PredictHQ Events API adapter — the direct answer to the live product report "I only see
 * comedy and live music, the app should hold food, drinks, motorbike events, horse racing,
 * WHATEVER IT IS". Ticketmaster + Skiddle are both genuinely self-serve (see docs/providers/
 * ticketing.md) but both are ticketed-event listings sites — their own UK catalogue for a
 * small-to-mid town really does skew toward comedy nights and gigs inside any 3-week window
 * (match.ts's CANDIDATE_WINDOW_DAYS), because that's what those two sites primarily sell tickets
 * to. PredictHQ is a different SHAPE of source: an events-intelligence aggregator that indexes
 * community listings, festivals, expos, food & drink events, performing arts and sport from many
 * public sources at once, searchable by a real lat/lng radius (`within=<radius>@<lat>,<lng>`) —
 * the same location model Plot already uses for Ticketmaster/Skiddle, not a bolt-on.
 *
 * TWO THINGS TO VERIFY BEFORE RELYING ON THIS, NOT GLOSSED OVER:
 *
 * 1. **Self-serve terms/pricing** — PredictHQ has historically offered a free evaluation tier via
 *    self-serve signup at predicthq.com, with paid plans for real production volume. This
 *    codebase cannot confirm CURRENT terms from this sandbox (outbound network here is blocked to
 *    everything except api.github.com — the same restriction documented in every other live
 *    adapter's own header). Check predicthq.com/pricing directly before applying, the same
 *    discipline already applied to Skiddle's business-activity clause (docs/providers/
 *    ticketing.md).
 * 2. **No public click-through link.** Unlike Ticketmaster/Skiddle, PredictHQ is an intelligence
 *    API, not a consumer listings site — its event objects do not include a public "buy tickets"
 *    or "view event" URL. Fabricating one would be exactly the kind of dishonest data this
 *    codebase's own directive forbids. `externalUrl` below instead points at a real, always-valid
 *    Google Maps search for the venue/address PredictHQ DOES give us — genuinely useful ("here's
 *    where it is"), clearly NOT a booking link. If PredictHQ ever exposes a real source link, or
 *    a specific event's venue can be cross-referenced to a real booking page some other way,
 *    swap this — see the `externalUrl` field below for exactly where.
 *
 * `isLive` is false — and this adapter simply isn't registered — whenever
 * `PREDICTHQ_ACCESS_TOKEN` isn't set; see registry.ts. Not exercised against the live API from
 * this environment for the same egress reason as every other adapter here — written against
 * PredictHQ's own publicly documented Events API v1 contract; verify against Render's own logs
 * once a real token is configured there.
 */

const PHQ_BASE = 'https://api.predicthq.com/v1/events/';
// Deliberately NOT requesting every PredictHQ category — public-holidays/school-holidays/
// academic/politics/severe-weather/disasters/airport-delays are real PredictHQ categories but
// none of them is a "thing a Crew could go and do", so asking for them would just be noise this
// adapter would then have to filter back out. These eight are the ones that map onto a real
// Plot category — see mapCategory's own comment for exactly how.
const PHQ_CATEGORIES = ['community', 'concerts', 'conferences', 'expos', 'festivals', 'food-drink', 'performing-arts', 'sports'] as const;
const SEARCH_RADIUS_KM = 40; // a real "worth going to" catchment for a broad community/culture aggregator — narrower than Ticketmaster's 100km sweep since this source skews local/grassroots, not touring-act national listings
const PAGE_SIZE = 100;
const MAX_PAGES = 2; // this is one of several providers one sync now runs concurrently (see inventorySync.ts#syncAllProviders) — bounded the same way Ticketmaster's own MAX_PAGES is
const PAGE_RETRY = { attempts: 2, timeoutMs: 6000 }; // same shape as Ticketmaster's own PAGE_RETRY — see that file's comment for the worst-case-latency reasoning this mirrors

interface PhqEntity {
  entity_id: string;
  name: string;
  type: string; // 'venue' | 'street-address' | ... — PredictHQ's own taxonomy
  formatted_address?: string;
}

interface PhqEvent {
  id: string;
  title: string;
  description?: string;
  category: string;
  start: string; // ISO datetime, UTC
  end?: string;
  timezone?: string;
  location?: [number, number]; // [lon, lat]
  entities?: PhqEntity[];
  rank?: number;
  phq_attendance?: number;
}

interface PhqSearchResponse {
  count?: number;
  next?: string | null;
  results?: PhqEvent[];
}

/**
 * PredictHQ's own category taxonomy doesn't line up 1:1 with Plot's ExperienceCategory either —
 * same "best-effort, not lossless" situation as every other adapter's mapCategory. `food-drink`
 * is the one worth calling out: it's PredictHQ's real, distinct category for tastings, food
 * markets, restaurant weeks and similar — mapped to RESTAURANT as the closest existing Plot
 * category, not to FESTIVAL (PredictHQ already has its own separate `festivals` category, so a
 * `food-drink` event is one PredictHQ itself did NOT call a festival).
 */
function mapCategory(phqCategory: string): ExperienceCategory {
  switch (phqCategory) {
    case 'concerts':
      return 'LIVE_MUSIC';
    case 'festivals':
      return 'FESTIVAL';
    case 'food-drink':
      return 'RESTAURANT';
    case 'performing-arts':
      return 'THEATRE';
    case 'sports':
      return 'SPORT';
    case 'community':
    case 'conferences':
    case 'expos':
    default:
      return 'COMMUNITY';
  }
}

function venueEntity(entities: PhqEntity[] | undefined): PhqEntity | undefined {
  return entities?.find((e) => e.type === 'venue') ?? entities?.[0];
}

/** See this file's own top comment (point 2) — PredictHQ gives no public click-through URL, so
 * this is a real, always-valid Google Maps search for the venue/address it DOES give us, never a
 * fabricated booking link. Falls back to searching the event title itself only when PredictHQ
 * gave no location text at all. */
function bestEffortExternalUrl(event: PhqEvent): string {
  const venue = venueEntity(event.entities);
  const query = venue?.formatted_address ?? venue?.name ?? `${event.title} UK`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

async function fetchPage(params: FetchListingsParams, offset: number, signal: AbortSignal): Promise<PhqSearchResponse> {
  const center = resolveCityCenter(params.city);
  const url = new URL(PHQ_BASE);
  url.searchParams.set('within', `${SEARCH_RADIUS_KM}km@${center.lat},${center.lng}`);
  url.searchParams.set('country', 'GB');
  url.searchParams.set('category', PHQ_CATEGORIES.join(','));
  url.searchParams.set('active.gte', params.fromDate.toISOString().slice(0, 10));
  url.searchParams.set('active.lte', params.toDate.toISOString().slice(0, 10));
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('sort', 'start');

  const res = await fetch(url.toString(), {
    signal,
    headers: { Authorization: `Bearer ${config.PREDICTHQ_ACCESS_TOKEN ?? ''}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`PredictHQ Events API returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as PhqSearchResponse;
}

export const predictHqProvider: ProviderAdapter = {
  id: 'predicthq',
  displayName: 'PredictHQ',
  categories: ['LIVE_MUSIC', 'FESTIVAL', 'RESTAURANT', 'THEATRE', 'SPORT', 'COMMUNITY'],
  isLive: Boolean(config.PREDICTHQ_ACCESS_TOKEN),

  async healthCheck(): Promise<ProviderHealth> {
    if (!config.PREDICTHQ_ACCESS_TOKEN) {
      return { status: 'DOWN', error: 'PREDICTHQ_ACCESS_TOKEN not configured', checkedAt: new Date() };
    }
    try {
      await withRetry((signal) => fetchPage({ city: 'Birmingham', fromDate: new Date(), toDate: new Date() }, 0, signal), { attempts: 1 });
      return { status: 'ACTIVE', checkedAt: new Date() };
    } catch (err) {
      return { status: 'DOWN', error: String(err), checkedAt: new Date() };
    }
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    if (!config.PREDICTHQ_ACCESS_TOKEN) return [];

    const events: PhqEvent[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await withRetry((signal) => fetchPage(params, page * PAGE_SIZE, signal), PAGE_RETRY);
      const pageEvents = data.results ?? [];
      events.push(...pageEvents);
      if (!data.next || pageEvents.length === 0) break;
    }

    const listings: RawListing[] = [];
    for (const event of events) {
      if (!event.location || event.location.length !== 2) {
        logger.warn({ eventId: event.id, name: event.title }, 'PredictHQ event missing a location — skipped');
        continue;
      }
      listings.push({ externalId: event.id, raw: event });
    }
    return listings;
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const event = listing.raw as PhqEvent;
    const [lng, lat] = event.location as [number, number];
    const venue = venueEntity(event.entities);

    return {
      name: event.title,
      description: event.description?.trim() || `${event.title}${venue?.name ? ` at ${venue.name}` : ''}.`,
      category: mapCategory(event.category),
      subcategories: [event.category],
      venueName: venue?.name ?? 'Venue TBC',
      latitude: lat,
      longitude: lng,
      startsAt: new Date(event.start),
      endsAt: event.end ? new Date(event.end) : null,
      timezone: event.timezone ?? 'Europe/London',
      // PredictHQ is an events-intelligence API, not a ticketing site — it has no price data at
      // all, honestly left null rather than guessed (same posture as OpenStreetMap's own price
      // fields).
      priceMinMinor: null,
      priceMaxMinor: null,
      currency: 'GBP',
      // PredictHQ has no booking-status concept (no "sold out"/"cancelled" field on an event) —
      // always AVAILABLE, same honest default OpenStreetMap's adapter uses for the same reason.
      bookingStatus: 'AVAILABLE',
      imageUrl: null, // PredictHQ has no images — falls into inventorySync.ts's own enrichment chain
      imageSource: null,
      tags: {
        provider: 'predicthq',
        phqCategory: event.category,
        rank: event.rank ?? null,
        phqAttendance: event.phq_attendance ?? null,
      },
      externalUrl: bestEffortExternalUrl(event),
      commissionEligible: false,
    };
  },
};
