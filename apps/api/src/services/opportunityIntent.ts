import type { Experience, ExperienceCategory } from '@prisma/client';

/**
 * THE FIX FOR "CAFFÈ NERO IN LONDON" — part two of it. Part one is the location hard gate
 * (match.ts/crewRecommendations.ts). This file is the other half: even a genuinely nearby,
 * in-radius, category-matching candidate can still be the WRONG THING to push into a Crew's
 * chat unprompted, because "a coffee chain exists nearby" is not a reason a friend group makes
 * a plan. Real, live-reported failure this exists to close for good — not a Caffè-Nero-specific
 * patch (explicitly ruled out), a genuine internal classification every Crew-facing candidate
 * gets evaluated against before it can compete for Plot's one recommendation slot.
 *
 * Two internal, NEVER-user-facing concepts:
 *
 *  - `SourceKind` — is this candidate a real, dated, ticketed/RSVP'd OCCASION (Ticketmaster/
 *    Skiddle/PredictHQ/Eventbrite — a real thing happening at a specific time this Crew could
 *    plan around), or a PERMANENT PLACE listing (OpenStreetMap/FHRS/Google Places/Foursquare —
 *    "this venue exists", with a synthetic `startsAt` computed by `nextSensibleTime()` in each of
 *    those adapters, never a real occasion)? This is a genuinely reliable signal already present
 *    in `Experience.tags.provider` (every live adapter sets it) — not a guess, not an LLM
 *    classification, a fact about which real API produced this row.
 *  - `PlanWorthiness` — given that, and the category, and whether the listing's own real text
 *    (name/description/subcategories) shows a specific, special reason to go (a festival, a
 *    market, a tasting, a pop-up, a themed night), how strong a reason is this to interrupt a
 *    Crew's conversation with it? Never a fabricated score shown to a user — purely an internal
 *    gate, same "internal decision attributes, not exposed numeric scores" posture the product
 *    spec calls for.
 *
 * A PLACE-sourced RESTAURANT/BAR/CLUBBING/FITNESS/COMMUNITY listing with no specialness signal
 * defaults LOW — below the bar for Plot's own primary Crew recommendation engine (see
 * `isPlanWorthyForCrew`) — while the exact same category from a real EVENT source (a food
 * festival, a themed club night) defaults HIGH, and a well-known CHAIN name (Caffè Nero,
 * Starbucks, a fast-food chain, …) is force-floored regardless of source, because a chain
 * location is never itself a reason a friendship group plans a night out.
 *
 * This governs the CREW recommendation engine specifically (services/match.ts's shared scorer,
 * used by the automatic sweep AND the manual "Find us something"/"Suggest something" flows —
 * all three are Plot placing a bet into a Crew's own conversation, the same bar). It does NOT
 * touch Explore or Home — see docs/DECISIONS.md#crew-recommendation-architecture for why those
 * two surfaces are deliberately allowed to stay broad. Places are still real, valid Plot
 * inventory; they just don't get to compete for the one high-confidence "Plot found this"
 * slot a Crew sees unprompted.
 */

// Real permanent-place discovery APIs — every row they produce carries a synthetic `startsAt`
// (each adapter's own `nextSensibleTime()`), never a genuinely dated occasion. See each
// adapter's own file header (providers/live/openStreetMap.ts, fhrs.ts, googlePlaces.ts,
// foursquare.ts) for the "next sensible time to go, never a real booking slot" convention this
// relies on.
export const PLACE_PROVIDER_IDS = new Set(['openstreetmap', 'fhrs', 'google_places', 'foursquare']);

// Real ticketed/RSVP'd event sources — every row carries a genuinely dated, provider-supplied
// occasion, not a computed placeholder. `mock_ticketing` is the test-environment stand-in for
// Ticketmaster/DICE (see providers/mock/ticketingProvider.ts's own header — "shaped like a real
// ticketing aggregator response", real price ranges, a real sold-out percentage) — recognised
// here so the ticketed-first tiering (crewRecommendations.ts) and its own test suite exercise
// the exact same real logic a live key would, rather than a second parallel test-only rule.
export const EVENT_PROVIDER_IDS = new Set(['ticketmaster', 'skiddle', 'predicthq', 'eventbrite', 'mock_ticketing']);

export type SourceKind = 'EVENT_PROVIDER' | 'PLACE_PROVIDER' | 'UNKNOWN';

/**
 * `UNKNOWN` covers manual curation (`POST /admin/experiences/manual` always writes `tags: {}` —
 * an operator-vetted entry, never penalised the way an unreviewed place-provider row is) and
 * every mock provider (`tags.provider` is never set by any of them — see providers/mock/*.ts).
 * Deliberately NOT penalised by the place-provider downgrade below: we genuinely don't know this
 * came from an unreviewed permanent-venue lookup, so it gets the ordinary category baseline, not
 * the suspicious one.
 */
export function deriveSourceKind(experience: Pick<Experience, 'tags'>): SourceKind {
  const provider = (experience.tags as Record<string, unknown> | null)?.provider;
  if (typeof provider !== 'string') return 'UNKNOWN';
  if (EVENT_PROVIDER_IDS.has(provider)) return 'EVENT_PROVIDER';
  if (PLACE_PROVIDER_IDS.has(provider)) return 'PLACE_PROVIDER';
  return 'UNKNOWN';
}

// Real, well-known UK chains with zero destination value on their own — "Caffè Nero exists
// nearby" is never a reason a friend group makes a plan, whatever category or source it came
// from. Deliberately narrow and specific (never a broad word like "coffee" or "pub" that would
// catch genuine independent venues) — coffee/fast-food/pub CHAINS only, not restaurant chains a
// group might legitimately book (Wagamama, Nando's, etc. are common real group-dinner choices in
// the UK and are NOT on this list). Matched case-insensitively against the venue's own name.
const GENERIC_CHAIN_NAMES = [
  "caffè nero", 'caffe nero', 'starbucks', 'costa coffee', 'costa', 'greggs', "mcdonald's", 'mcdonalds',
  'kfc', 'subway', 'burger king', 'pret a manger', 'pret', 'wetherspoon', 'jd wetherspoon',
  'dunkin', 'tim hortons', 'domino\'s pizza', "domino's", 'pizza hut delivery',
];
const GENERIC_CHAIN_PATTERN = new RegExp(`\\b(${GENERIC_CHAIN_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

export function isGenericChainName(name: string): boolean {
  return GENERIC_CHAIN_PATTERN.test(name);
}

// Real, specific words that mean "this is a one-off/limited occasion", not "this place always
// exists" — found in the candidate's OWN name/description/subcategories, never inferred. A
// PLACE-sourced RESTAURANT tagged `amenity=marketplace` with "Market" literally in its name is
// exactly the honest signal this exists to catch (see openStreetMap.ts's own `label()`).
const SPECIALNESS_WORDS =
  /\b(festival|market|pop-?up|tasting|supper club|bottomless|brunch|workshop|exhibition|late night|special|launch|residency|showcase|tour|street food|takeover|series)\b/i;

function hasSpecialnessSignal(experience: Pick<Experience, 'name' | 'description' | 'subcategories'>): boolean {
  const subcats = Array.isArray(experience.subcategories) ? (experience.subcategories as string[]) : [];
  return SPECIALNESS_WORDS.test(experience.name) || SPECIALNESS_WORDS.test(experience.description) || subcats.some((s) => SPECIALNESS_WORDS.test(s));
}

// Real, specific words for DAY_ACTIVITY leisure venues that ARE inherently a "thing you do
// together" even as a permanent venue (an escape room, a round of mini golf) — distinct from
// FITNESS's more routine gym/pool venues, which stay at the ordinary baseline. Matches OSM's own
// `leisure=` vocabulary (providers/live/openStreetMap.ts's `buildQuery`).
const ACTIVITY_VENUE_WORDS = /\b(escape room|escape game|bowling|trampoline|karting|axe throwing|mini golf|crazy golf|climbing|ice rink|amusement arcade)\b/i;

export type PlanWorthiness = 'VERY_LOW' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
const PLAN_WORTHINESS_RANK: Record<PlanWorthiness, number> = { VERY_LOW: 0, LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 };

// Real category baseline — deliberately independent of source; the source-kind adjustment below
// is what actually distinguishes "a permanent chain venue" from "a specific occasion".
const CATEGORY_BASELINE: Partial<Record<ExperienceCategory, PlanWorthiness>> = {
  FESTIVAL: 'VERY_HIGH',
  LIVE_MUSIC: 'HIGH',
  COMEDY: 'HIGH',
  THEATRE: 'HIGH',
  SPORT: 'HIGH',
  ART_CULTURE: 'MEDIUM',
  CINEMA: 'MEDIUM',
  DAY_ACTIVITY: 'MEDIUM',
  CLUBBING: 'MEDIUM',
  RESTAURANT: 'MEDIUM',
  BAR: 'MEDIUM',
  FITNESS: 'MEDIUM',
  COMMUNITY: 'MEDIUM',
};

// Categories a PLACE_PROVIDER source downgrades by default — permanent-venue listings in these
// categories are exactly "there's a coffee shop/bar/gym nearby", not a plan. Deliberately does
// NOT include ART_CULTURE/CINEMA/THEATRE (a museum or cinema, even as a static place listing, is
// still a real destination a Crew can choose to go to — unlike "there's a Costa nearby").
const PLACE_PROVIDER_DOWNGRADE_CATEGORIES = new Set<ExperienceCategory>(['RESTAURANT', 'BAR', 'CLUBBING', 'FITNESS', 'COMMUNITY']);

export interface PlanWorthinessResult {
  level: PlanWorthiness;
  reasons: string[]; // internal audit trail only — see this file's own header
}

/**
 * The core classification. Every branch is traceable to real evidence (source, category,
 * literal text) — never an invented "vibe" score. See this file's own header for the full
 * reasoning; kept as one function (not spread across match.ts) so the debugger
 * (routes/admin.ts's explain-recommendation) and the hard gate below both call the exact same
 * logic, never two definitions that could drift.
 */
export function derivePlanWorthiness(
  experience: Pick<Experience, 'name' | 'description' | 'subcategories' | 'category' | 'tags'>,
): PlanWorthinessResult {
  const reasons: string[] = [];

  if (isGenericChainName(experience.name)) {
    return { level: 'VERY_LOW', reasons: ['generic_chain_name'] };
  }

  const sourceKind = deriveSourceKind(experience);
  let level = CATEGORY_BASELINE[experience.category] ?? 'MEDIUM';
  reasons.push(`category_baseline:${experience.category}=${level}`);

  if (experience.category === 'DAY_ACTIVITY') {
    const subcats = Array.isArray(experience.subcategories) ? (experience.subcategories as string[]) : [];
    const isActivityVenue = ACTIVITY_VENUE_WORDS.test(experience.name) || subcats.some((s) => ACTIVITY_VENUE_WORDS.test(s));
    if (isActivityVenue) {
      level = 'HIGH';
      reasons.push('activity_venue_signal');
    }
  }

  if (sourceKind === 'PLACE_PROVIDER' && PLACE_PROVIDER_DOWNGRADE_CATEGORIES.has(experience.category)) {
    if (hasSpecialnessSignal(experience)) {
      level = 'HIGH';
      reasons.push('place_provider_but_specialness_signal');
    } else {
      level = 'LOW';
      reasons.push('place_provider_generic_venue');
    }
  } else if (sourceKind === 'EVENT_PROVIDER' && PLACE_PROVIDER_DOWNGRADE_CATEGORIES.has(experience.category)) {
    // A real dated occasion in a normally-generic category (PredictHQ's food-drink -> RESTAURANT,
    // Skiddle's CLUB eventcode -> CLUBBING) — this IS a genuine plan, not "a place exists".
    level = 'HIGH';
    reasons.push('event_provider_dated_occasion');
  }

  return { level, reasons };
}

// The bar the automatic Crew engine AND the manual "Find us something"/"Suggest something" flows
// all require — see this file's own header on why all three share it. MEDIUM is the category
// baseline for an ordinary, non-downgraded candidate (a mock/manually-curated restaurant, a
// museum, a cinema) — this bar excludes only what was actually downgraded (a generic PLACE_
// PROVIDER venue) or force-floored (a chain name), never ordinary real inventory.
export const MIN_PLAN_WORTHINESS_FOR_CREW: PlanWorthiness = 'MEDIUM';

export function isPlanWorthyForCrew(
  experience: Pick<Experience, 'name' | 'description' | 'subcategories' | 'category' | 'tags'>,
): boolean {
  return PLAN_WORTHINESS_RANK[derivePlanWorthiness(experience).level] >= PLAN_WORTHINESS_RANK[MIN_PLAN_WORTHINESS_FOR_CREW];
}

/**
 * Canonical booking-state model (product spec Part 5) — internal, derived, never a fabricated
 * "BOOK NOW" claim. Deliberately conservative: without a real per-provider booking-availability
 * feed (Ticketmaster/Skiddle DO carry a real bookingStatus; a place-provider listing never has
 * one at all), this only ever asserts what the underlying data actually supports.
 */
export type BookingType =
  | 'TICKET_AVAILABLE'
  | 'RSVP_AVAILABLE'
  | 'BOOKING_LINK_AVAILABLE'
  | 'WALK_IN'
  | 'NO_BOOKING_REQUIRED'
  | 'SOLD_OUT'
  | 'UNKNOWN';

export function deriveBookingType(
  experience: Pick<Experience, 'bookingStatus' | 'priceMinMinor' | 'tags'>,
): BookingType {
  if (experience.bookingStatus === 'SOLD_OUT') return 'SOLD_OUT';
  const sourceKind = deriveSourceKind(experience);
  if (sourceKind === 'EVENT_PROVIDER') {
    return experience.priceMinMinor !== null ? 'TICKET_AVAILABLE' : 'RSVP_AVAILABLE';
  }
  if (sourceKind === 'PLACE_PROVIDER') return 'WALK_IN'; // no booking integration for any place-provider adapter today
  // UNKNOWN (manual curation, mock providers standing in for a real booking-aware source like
  // OpenTable — see providers/mock/restaurantProvider.ts's own header) — a real price/link
  // exists, so this is closer to a genuine booking than a bare walk-in, but never claimed as a
  // live ticket.
  return experience.priceMinMinor !== null ? 'BOOKING_LINK_AVAILABLE' : 'NO_BOOKING_REQUIRED';
}

/**
 * Real, live product requirement, stated plainly: "I need ticketed only events... don't think we
 * need to include or focus on unpaid, no ticket events. This kills the app a bit for me." A
 * genuine ticket — a real dated occasion (`EVENT_PROVIDER`) with a real price — is the strongest
 * possible proof this is worth interrupting a Crew's chat for: someone has to actually pay and
 * show up, which a permanent place listing or a free/undated one can never demonstrate. Used as
 * a PREFERENCE (a real scoring boost, see match.ts) and a TIERING rule (crewRecommendations.ts
 * picks from the ticketed subset first, only falling back to the best non-ticketed eligible
 * candidate — clearly prefaced when it does — when zero ticketed options exist) — never a hard
 * exclusion, since the honest fallback the product spec explicitly asks for ("send one as local
 * as possible... preface it") requires non-ticketed candidates to still be reachable when that's
 * genuinely all that exists near this Crew right now. */
export function isTicketedEvent(experience: Pick<Experience, 'bookingStatus' | 'priceMinMinor' | 'tags'>): boolean {
  return deriveBookingType(experience) === 'TICKET_AVAILABLE';
}
