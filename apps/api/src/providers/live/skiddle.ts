import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams, ProviderHealth } from '../types';
import { withRetry } from '../../lib/retry';
import { config } from '../../lib/config';
import { logger } from '../../lib/logger';
import { resolveCityCenter } from '../../data/ukPlaces';

/**
 * Real Skiddle Events API adapter — a genuinely self-serve UK listings source distinct from
 * Ticketmaster's own coverage (independent club nights, UK festivals, comedy nights, smaller
 * venues Ticketmaster doesn't carry). `isLive` is false — and this adapter simply isn't
 * registered — whenever SKIDDLE_API_KEY isn't set; see registry.ts. See
 * docs/providers/ticketing.md for exactly how to get a key.
 *
 * NOT exercised against the live API from this environment — outbound network to
 * www.skiddle.com isn't reachable from the sandbox this was written in (the same restriction
 * that blocks every other live provider this session touched — Ticketmaster, Wikipedia,
 * Overpass, postcodes.io). Written against Skiddle's own documented API contract
 * (github.com/Skiddle/web-api) plus cross-checked field usage in several independent, actively-
 * maintained open-source consumers of the same endpoint — verify against Render's own logs once
 * a real key is configured there, the same discipline already applied to every other live
 * adapter this session added.
 *
 * Real legal constraint, not just a technical one — Skiddle's API terms require crediting
 * Skiddle "by name and brand logo" wherever their data is shown, and require every result to
 * link out via Skiddle's own `link` field (never rewritten/proxied). Images are tagged with
 * their own `imageSource: 'SKIDDLE'` (never 'MANUAL' — that value means operator-curated
 * elsewhere in this codebase, e.g. POST /admin/experiences/manual, which this isn't). Skiddle's
 * own attribution requirement is satisfied at the UI layer (Explore's own attribution line, same
 * pattern as the OpenStreetMap ODbL credit), not by the image tag. `externalUrl` is always
 * Skiddle's own unmodified `link` — see mapToCanonical — satisfying the "don't modify the link"
 * clause by construction, not by convention.
 */

const SKIDDLE_BASE = 'https://www.skiddle.com/api/v1/events/search/';
// One request per category — Skiddle's `eventcode` takes exactly one value per call, so
// covering several real Plot categories means several real requests per city per sync. Picked
// the categories with the cleanest, least-ambiguous mapping onto Plot's own ExperienceCategory
// enum; see mapEventCode's own comment for the ones deliberately left out and why.
const EVENT_CODES = ['FEST', 'LIVE', 'CLUB', 'COMEDY', 'THEATRE', 'ARTS', 'SPORT'] as const;
const RADIUS_MILES = 15;
const PAGE_SIZE = 50;
// Observed real-world pacing from an actively-maintained open-source consumer of this exact
// endpoint (no official rate limit is published — see docs/providers/ticketing.md) — a small,
// polite delay between the several per-category requests one sync makes, not a hard requirement
// this code can otherwise verify.
const REQUEST_SPACING_MS = 350;
// Real production bug this closes: fetchOneCategory used withRetry's DEFAULT budget (3 attempts
// x 8s timeout each ≈ 24s worst case) per category, and this adapter makes up to 7 sequential
// category requests — so a slow/unresponsive Skiddle endpoint could add 170+ seconds to a
// single `ensureInventory` call, which the whole request-serving path awaits synchronously
// (see inventorySync.ts#ensureInventoryProduction and services/explore.ts). That's exactly what
// broke Discover the moment SKIDDLE_API_KEY was first configured live. Fail fast per category —
// one attempt, a short timeout — rather than patiently retrying a source that has 6 more
// categories still waiting behind it.
const PER_CATEGORY_RETRY = { attempts: 1, timeoutMs: 6000 };
// Hard ceiling on this adapter's OWN total contribution to one sync, regardless of how many
// categories are slow/unresponsive — a second, independent backstop on top of
// PER_CATEGORY_RETRY's fast-fail budget, so a change to EVENT_CODES or a genuinely broken
// endpoint can never again silently reintroduce an unbounded synchronous stall in the read path.
// checked before each category request, not just once at the top, so an early slow category
// still lets healthy ones after it get skipped cleanly rather than starting one more request
// that's certain to blow the budget anyway.
const OVERALL_BUDGET_MS = 15_000;

interface SkiddleVenue {
  id?: number;
  name?: string;
  town?: string;
  latitude?: string | number;
  longitude?: string | number;
}

interface SkiddleEvent {
  id: string | number;
  eventname: string;
  description?: string;
  date?: string; // YYYY-MM-DD
  openingtimes?: { doorsopen?: string; doorsclose?: string };
  entryprice?: string; // free-text, e.g. "£12.50", "Free", "£10 - £15"
  imageurl?: string;
  largeimageurl?: string;
  link: string;
  EventCode?: string;
  cancelled?: string | number | boolean;
  venue?: SkiddleVenue;
}

interface SkiddleSearchResponse {
  error?: string;
  totalcount?: number;
  results?: SkiddleEvent[];
}

/**
 * Skiddle's `eventcode` taxonomy doesn't map 1:1 onto Plot's ExperienceCategory either — same
 * "best-effort, not lossless" situation as the Ticketmaster adapter. Deliberately NOT requesting
 * every Skiddle event code: BARPUB overlaps heavily with OpenStreetMap's own real pub/bar
 * coverage (lower marginal value for an extra request), KIDS/DATE/LGB/EXHIB map onto Plot's
 * categories awkwardly enough that a forced mapping would be more misleading than useful. The
 * seven requested here all have a clean, honest destination category.
 */
function mapEventCode(code: string | undefined): ExperienceCategory {
  switch (code) {
    case 'FEST':
      return 'FESTIVAL';
    case 'LIVE':
      return 'LIVE_MUSIC';
    case 'CLUB':
      return 'CLUBBING';
    case 'COMEDY':
      return 'COMEDY';
    case 'THEATRE':
      return 'THEATRE';
    case 'ARTS':
      return 'ART_CULTURE';
    case 'SPORT':
      return 'SPORT';
    default:
      return 'COMMUNITY';
  }
}

/** `entryprice` is Skiddle's own free-text display string ("£12.50", "Free", "£10 - £15",
 * occasionally something not price-shaped at all) — never a structured number. Best-effort
 * parse; anything that doesn't look like a price honestly returns null rather than guessing. */
function parseEntryPrice(entryprice: string | undefined): { minMinor: number | null; maxMinor: number | null } {
  if (!entryprice) return { minMinor: null, maxMinor: null };
  const text = entryprice.trim().toLowerCase();
  if (text === 'free' || text === '£0' || text === '£0.00') return { minMinor: 0, maxMinor: 0 };
  const amounts = [...text.matchAll(/(\d+(?:\.\d{1,2})?)/g)].map((m) => Math.round(parseFloat(m[1]) * 100));
  if (amounts.length === 0) return { minMinor: null, maxMinor: null };
  return { minMinor: Math.min(...amounts), maxMinor: Math.max(...amounts) };
}

function mapBookingStatus(cancelled: SkiddleEvent['cancelled']): CanonicalListingInput['bookingStatus'] {
  const isCancelled = cancelled === true || cancelled === 1 || cancelled === '1';
  return isCancelled ? 'SOLD_OUT' : 'AVAILABLE'; // excluded from Match's pool either way, same effect as genuinely sold out
}

async function fetchOneCategory(eventcode: string, params: FetchListingsParams, signal: AbortSignal): Promise<SkiddleEvent[]> {
  const center = resolveCityCenter(params.city);
  const url = new URL(SKIDDLE_BASE);
  url.searchParams.set('api_key', config.SKIDDLE_API_KEY ?? '');
  url.searchParams.set('latitude', String(center.lat));
  url.searchParams.set('longitude', String(center.lng));
  url.searchParams.set('radius', String(RADIUS_MILES));
  url.searchParams.set('country', 'GB');
  url.searchParams.set('eventcode', eventcode);
  url.searchParams.set('minDate', params.fromDate.toISOString().slice(0, 10));
  url.searchParams.set('maxDate', params.toDate.toISOString().slice(0, 10));
  url.searchParams.set('order', 'date');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('description', '1');

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) {
    throw new Error(`Skiddle events API returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as SkiddleSearchResponse;
  if (body.error) {
    throw new Error(`Skiddle events API error: ${body.error}`);
  }
  return body.results ?? [];
}

export const skiddleProvider: ProviderAdapter = {
  id: 'skiddle',
  displayName: 'Skiddle',
  categories: ['FESTIVAL', 'LIVE_MUSIC', 'CLUBBING', 'COMEDY', 'THEATRE', 'ART_CULTURE', 'SPORT'],
  isLive: Boolean(config.SKIDDLE_API_KEY),

  async healthCheck(): Promise<ProviderHealth> {
    if (!config.SKIDDLE_API_KEY) {
      return { status: 'DOWN', error: 'SKIDDLE_API_KEY not configured', checkedAt: new Date() };
    }
    try {
      await withRetry((signal) => fetchOneCategory('LIVE', { city: 'Birmingham', fromDate: new Date(), toDate: new Date() }, signal), { attempts: 1 });
      return { status: 'ACTIVE', checkedAt: new Date() };
    } catch (err) {
      return { status: 'DOWN', error: String(err), checkedAt: new Date() };
    }
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    if (!config.SKIDDLE_API_KEY) return [];

    const startedAt = Date.now();
    const events: SkiddleEvent[] = [];
    for (const eventcode of EVENT_CODES) {
      if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
        logger.warn(
          { city: params.city, remainingCategories: EVENT_CODES.slice(EVENT_CODES.indexOf(eventcode)) },
          'Skiddle fetch hit its overall time budget — returning what was gathered rather than risk stalling the request that triggered this sync',
        );
        break;
      }
      try {
        const pageEvents = await withRetry((signal) => fetchOneCategory(eventcode, params, signal), PER_CATEGORY_RETRY);
        events.push(...pageEvents);
      } catch (err) {
        // One category failing (a transient error, an eventcode Skiddle rejects) must not take
        // the other six down with it — same "one provider outage can't cascade" principle every
        // adapter in this codebase follows, just applied within a single adapter's own multiple
        // requests here since Skiddle's API shape forces several calls per sync.
        logger.warn({ err, eventcode, city: params.city }, 'Skiddle category fetch failed — continuing with the other categories');
      }
      await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS));
    }

    const listings: RawListing[] = [];
    for (const event of events) {
      const lat = Number(event.venue?.latitude);
      const lng = Number(event.venue?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        logger.warn({ eventId: event.id, name: event.eventname }, 'Skiddle event missing venue coordinates — skipped');
        continue;
      }
      listings.push({ externalId: String(event.id), raw: event });
    }
    return listings;
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const event = listing.raw as SkiddleEvent;
    const lat = Number(event.venue?.latitude);
    const lng = Number(event.venue?.longitude);
    const { minMinor, maxMinor } = parseEntryPrice(event.entryprice);
    const doorsOpen = event.openingtimes?.doorsopen;
    const startsAtIso = event.date ? `${event.date}T${doorsOpen && /^\d{2}:\d{2}/.test(doorsOpen) ? doorsOpen : '19:00'}:00` : null;

    return {
      name: event.eventname,
      // Skiddle's own terms require not modifying the data they provide — passed through as-is,
      // not rewritten/summarised.
      description: event.description || `${event.eventname}${event.venue?.name ? ` at ${event.venue.name}` : ''}.`,
      category: mapEventCode(event.EventCode),
      subcategories: event.EventCode ? [event.EventCode.toLowerCase()] : [],
      venueName: event.venue?.name ?? 'Venue TBC',
      latitude: lat,
      longitude: lng,
      startsAt: startsAtIso ? new Date(startsAtIso) : new Date(),
      endsAt: null, // Skiddle's doorsclose is a closing time, not necessarily this event's own end
      timezone: 'Europe/London',
      priceMinMinor: minMinor,
      priceMaxMinor: maxMinor,
      currency: 'GBP',
      bookingStatus: mapBookingStatus(event.cancelled),
      imageUrl: event.largeimageurl || event.imageurl || null,
      imageSource: event.largeimageurl || event.imageurl ? 'SKIDDLE' : null,
      tags: {
        provider: 'skiddle',
        eventCode: event.EventCode ?? null,
      },
      // Skiddle's own event/ticket URL, unmodified — the API terms require linking out via
      // exactly this field, never a rewritten/proxied version of it.
      externalUrl: event.link,
      // Not claimed automatically — Skiddle's affiliate programme is a SEPARATE application
      // (skiddle.com/affiliates/join.php) from the plain data-API key this adapter uses; see
      // docs/providers/ticketing.md. Flip this once that's actually joined and confirmed.
      commissionEligible: false,
    };
  },
};
