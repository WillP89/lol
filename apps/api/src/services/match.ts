import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { MIN_PUBLISHABLE_QUALITY_SCORE } from './qualityScoring';
import { getMemberAvailability } from './availability';
import { ensureInventory } from './inventorySync';
import { dedupeNearDuplicates } from './entityResolution';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { haversineMiles } from '../lib/geo';
import { track } from './analytics';
import { sendExperienceToCrew } from './plan';
import { experienceInterestTags, experienceMatchesFreeText, categoryToTasteKey, type FreeTextSignal } from './tasteSignals';
import { assertCrewPreferencesSet } from './crewPreferencesGate';
import { interestLabel, TASTE_INTEREST_INDEX, UNAMBIGUOUS_CATEGORIES, TERRITORIES_REQUIRING_EXPLICIT_RELATION, RELATED_INTERESTS } from '@plot/shared';
import { isPlanWorthyForCrew, isTicketedEvent } from './opportunityIntent';
import type { Experience, TasteProfile, Plan, Venue } from '@prisma/client';

export interface MatchReason {
  code: string;
  label: string;
}

export interface MatchOption {
  experience: Experience;
  matchScore: number;
  reasons: MatchReason[];
  availableMemberCount: number;
  totalMemberCount: number;
  // null = distance couldn't be computed (no venue coords, or no location anchor at all) —
  // genuinely unknown, never treated as "near" or "far". THE FIX for the "Caffè Nero in
  // London sent to a 25-mile Stafford Crew" bug: the automatic recommendation engine
  // (services/crewRecommendations.ts) used to hard-filter with `!== false`, which treats this
  // `null` exactly like "near" — an unknown distance silently passed the radius gate instead of
  // being rejected. Fixed there to require `=== true` (fail closed on unknown), and fixed here
  // at the source: when the Crew has its own explicit location set (Crew.latitude/longitude),
  // that is now the SOLE anchor for this calculation — never blended with a member's personal
  // home location, so one member happening to live near an out-of-area candidate can no longer
  // "rescue" it for a Crew that has explicitly declared where IT is. See
  // docs/DECISIONS.md#crew-recommendation-architecture. The manual "Find us something"/"Suggest
  // something" flows still use this as a soft scoring input only (a member actively browsing can
  // see something further out) — the automatic engine is the one that must never be wrong here.
  withinRadius: boolean | null;
  // The real, computed distance in miles from this Crew's location anchor to the candidate's
  // venue — null under the exact same "genuinely unknown" conditions as `withinRadius`. Exposed
  // (not just folded into a reason label) so the recommendation debugger
  // (GET /admin/crews/:id/explain-recommendation) and the client can show a real "X miles away",
  // never a fabricated one — product spec's own "HOW FAR?" requirement.
  distanceMiles: number | null;
}

/**
 * Layer 4 hook (brief §45 "architect so machine-learning ranking can replace hand-tuned
 * weights over time"). The default implementation is the identity function — it does not
 * reorder anything. Swap this for a real learned ranker once there's enough RewindSignal +
 * BookingCompleted history to train one; until then, honestly, more ML here would be fitting
 * noise. See docs/DECISIONS.md#recommendation-system.
 */
export interface LearnedRanker {
  rerank(options: MatchOption[], context: { crewId: string }): Promise<MatchOption[]>;
}
export const identityRanker: LearnedRanker = {
  async rerank(options) {
    return options;
  },
};

// Exported (not just a local const) so the admin inventory-probe diagnostic (routes/admin.ts)
// can report, per real event a live provider returns, whether it actually falls inside the
// window Crew recommendations search at all — rather than a second, hand-duplicated value that
// could silently drift from the real value this file actually uses.
//
// REAL, LIVE-REPORTED GAP this widening closes: `inventorySync.ts#syncAllProviders` already
// fetches and stores a full 60 days of real inventory from every live provider on each sync —
// that's a real, already-paid-for (Ticketmaster's own daily quota) fetch, not a hypothetical
// one. This window used to be 21 days, discarding up to 39 days of ALREADY-INGESTED real
// inventory at every single Crew's own matching pass for no real reason (no product rationale
// for "21" ever existed — it was an unexamined technical default, not a deliberate "plans only
// happen within 3 weeks" decision). For an infrequent, real category (a boxing/MMA card, a
// specific niche festival) that only happens every month or two, this alone could be the entire
// difference between "Plot found something" and a false "we don't have any... yet" — the event
// was there the whole time, sitting in the database, just never looked at. 45 (not the full 60)
// leaves real margin: a candidate found on day 44 stays inside the window until the next sync
// naturally refreshes it, rather than aging out mid-week. See the admin inventory-probe's own
// `recommendationWindowDays` field for confirming this value from a live deployment.
export const CANDIDATE_WINDOW_DAYS = 45;
const RESULT_COUNT = 3;
// The onboarding default (see onboarding/page.tsx) — used whenever we need a radius and no
// member has a real TasteProfile.travelRadiusMeters yet, so a brand-new Crew still gets a
// sane "worth travelling for" distance rather than an unbounded or zero radius.
const DEFAULT_RADIUS_METERS = 24000;

async function resolveCrewCity(crewId: string, fallbackUserId?: string): Promise<string> {
  const [crew, requester] = await Promise.all([
    prisma.crew.findUnique({ where: { id: crewId }, select: { defaultCity: true } }),
    fallbackUserId
      ? prisma.user.findUnique({ where: { id: fallbackUserId }, select: { profile: { select: { homeCity: true } } } })
      : Promise.resolve(null),
  ]);
  // The Crew's own city if set, else whoever asked's home city, else a genuinely UK-central
  // fallback (never a hardcoded London assumption — see docs/DECISIONS.md#uk-wide-location).
  return crew?.defaultCity ?? requester?.profile?.homeCity ?? UK_FALLBACK_CENTER.name;
}

/**
 * The shared scoring core behind "Find us something", "Suggest something", and the automatic
 * Crew recommendation engine (services/crewRecommendations.ts) — one scorer, three call sites,
 * so a scoring change (or a bug fix in it) applies everywhere at once instead of drifting.
 * Layered, in order:
 *
 *  1. Hard constraints — publishable quality, not sold out, starts within the candidate
 *     window. Anything failing this never reaches scoring; it's a filter, not a penalty.
 *  2. Preference scoring — category affinity averaged across the crew's TasteProfiles,
 *     boosted by CrewDNA top categories when confidence is MEDIUM/HIGH.
 *  3. Context — under/over the crew's median comfortable spend, distance from the Crew's own
 *     area (soft-scored here; the automatic engine applies a hard filter on top using
 *     `withinRadius`), and how many members are free that evening (real AvailabilityWindow
 *     data, not simulated).
 *  4. Learned re-rank hook — currently a no-op; see LearnedRanker above.
 *  5. Near-duplicate suppression — collapses same-category, similar-name, near-in-time options
 *     (see entityResolution.ts#dedupeNearDuplicates) down to the single best-scoring one, so a
 *     mock-data or multi-provider near-duplicate never shows as two separate cards.
 *
 * Every option keeps its `reasons[]` so the API response is explainable, not a black box
 * score — see brief §46. Does not persist anything; callers that need an audit trail (
 * `findUsSomething`) do that themselves.
 */
export async function scoreExperiencesForCrew(
  crewId: string,
  opts: { radiusMetersOverride?: number | null } = {},
): Promise<MatchOption[]> {
  const [members, dna, recommendationSettings, pastResponses, crewLocation] = await Promise.all([
    prisma.crewMember.findMany({
      where: { crewId, status: 'ACTIVE' },
      include: { user: { include: { tasteProfile: true, profile: true } } },
    }),
    prisma.crewDNA.findUnique({ where: { crewId } }),
    // The Crew's own explicit category/interest picks (docs: CrewRecommendationSettings
    // .categoryPreferences/.interestPreferences) — fetched here rather than requiring every
    // caller to pass it in, so "Find us something"/"Suggest something" (which never touch
    // recommendation settings otherwise) also lean into what the Crew said it's about, not just
    // the automatic-sweep path. A Crew with no settings row yet (never touched the Recommendation
    // settings UI) simply has no preference — this reads, never creates, so a brand-new Crew's
    // first score isn't blocked on a settings write.
    prisma.crewRecommendationSettings.findUnique({ where: { crewId }, select: { categoryPreferences: true, interestPreferences: true, travelRadiusMeters: true } }),
    // THE LEARNING LOOP (brief §"PASS teaches Plot nothing" — this is the fix). Every past
    // response this Crew has given a CrewRecommendation, joined to what that Experience actually
    // was — turned into a per-category/per-interest bias applied to THIS scoring pass only (never
    // written back into an individual member's own TasteProfile, since a Crew's collective "not
    // for us" isn't necessarily true of any one person in it). See `buildLearningBias` below for
    // which response kinds count as taste signal vs. purely situational.
    prisma.crewRecommendation.findMany({
      where: { crewId, status: { not: 'SENT' } },
      select: { status: true, experience: { select: { category: true, subcategories: true, name: true, description: true } } },
    }),
    // The Crew's own explicit location (Crew.latitude/.longitude — see that field's own schema
    // comment) — read here alongside everything else this function already fetches once, rather
    // than requiring a second round trip.
    prisma.crew.findUnique({ where: { id: crewId }, select: { latitude: true, longitude: true } }),
  ]);
  const crewCategoryPreferences = new Set(recommendationSettings?.categoryPreferences ?? []);
  const crewInterestPreferences = new Set(recommendationSettings?.interestPreferences ?? []);
  const learningBias = buildLearningBias(pastResponses);

  const userIds = members.map((m) => m.userId);
  const tasteProfiles = members
    .map((m) => m.user.tasteProfile)
    .filter((tp): tp is TasteProfile => Boolean(tp));
  // Never expose a member's precise home coordinates to the Crew (see docs/DECISIONS.md#uk-
  // wide-location) — this stays server-side, used only to compute a distance, never returned.
  //
  // REAL, LIVE-REPORTED BUG this closes ("Crew: STAFFORD, 25-mile radius... Plot sent CAFFÈ
  // NERO IN LONDON"): a Crew's own explicit location used to be folded IN ADDITION TO every
  // member's personal home location, all treated as one undifferentiated pool of "reference
  // points, nearest wins". That meant a single member whose own personal home happened to be
  // near an out-of-area candidate could make it read as "in radius" for the WHOLE Crew, even
  // though the Crew itself had explicitly declared it was based somewhere else entirely — the
  // opposite of what "setting the location... should be part of creating a group" was supposed
  // to guarantee. Once a Crew has its own explicit location, that IS the Crew's answer to "where
  // are we" — same principle already applied to categoryPreferences/interestPreferences (an
  // explicit Crew-level pick is authoritative, member signal still ranks WITHIN it, never
  // overrides it). Member home locations remain the fallback ONLY when the Crew has no explicit
  // location of its own — exactly the pre-existing behaviour for a Crew that never set one (see
  // dispersedCrewRadius.test.ts).
  const crewHasExplicitLocation = crewLocation !== null && crewLocation.latitude !== null && crewLocation.longitude !== null;
  const memberCoords: { homeLat: number; homeLng: number }[] = [];
  if (crewHasExplicitLocation) {
    memberCoords.push({ homeLat: crewLocation!.latitude!, homeLng: crewLocation!.longitude! });
  } else {
    for (const m of members) {
      const p = m.user.profile;
      if (p && p.homeLat !== null && p.homeLng !== null) {
        memberCoords.push({ homeLat: p.homeLat, homeLng: p.homeLng });
      }
    }
  }

  const windowStart = new Date();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + CANDIDATE_WINDOW_DAYS);
  // Real bug this closes, caught by test/personalHome.test.ts's own acceptance run: without
  // this, "the next 21 days" silently means "21 days from THIS EXACT TIMESTAMP", not 21 full
  // calendar days — an event pinned to 8pm on day 21 was excluded whenever this ran earlier in
  // the day than 8pm, purely because of what time the request happened to fire, never a fact
  // about the event itself. End-of-day makes the window mean what it says.
  windowEnd.setHours(23, 59, 59, 999);

  // Layer 1: hard constraints, expressed directly as a WHERE clause rather than filtered in
  // application code — no reason to pull rows across the wire just to discard them.
  const hardConstraints: Prisma.ExperienceWhereInput = {
    qualityScore: { gte: MIN_PUBLISHABLE_QUALITY_SCORE },
    bookingStatus: { not: 'SOLD_OUT' },
    startsAt: { gte: windowStart, lte: windowEnd },
  };

  // REAL, LIVE-REPORTED BUG this closes: a Crew genuinely based in London (real, deep inventory
  // — "no food event in London? find that very hard to believe", correctly so) got the honest
  // "nothing yet" message anyway. Root cause: this query used to be a bare `take: 50` over the
  // WHOLE Experience table — every city this pilot has ever synced inventory for, combined —
  // with no location scoping and no explicit ordering at all. As that table accumulates real
  // cities beyond wherever any one Crew actually is, an arbitrary, database-order-dependent
  // slice of 50 rows can easily land entirely on OTHER cities' events, missing a Crew's own
  // city's genuinely relevant inventory completely, however deep it is. Fixed by resolving
  // candidates NEAREST to this Crew's reference points first (`memberCoords` above — every
  // member's home location, plus the Crew's own explicit location if set) via a lightweight
  // id+coordinates projection over every hard-constraint-passing row, then hydrating only the
  // nearest slice. Never a hard geographic exclusion — an experience with no venue, or genuinely
  // far from everyone, still sorts in (just last), preserving the existing "a member actively
  // browsing can still see a great match further out" soft-radius behaviour (see
  // MatchOption.withinRadius's own comment) exactly as before; only which candidates the fixed
  // `take` cap actually keeps has changed.
  let candidates: (Experience & { venue: Venue | null })[];
  if (memberCoords.length > 0) {
    // A lightweight projection (id + venue coordinates only) — cheap even over every row this
    // pilot has ever synced, and bounded by its own generous safety cap so this can never turn
    // into an unbounded table scan as inventory keeps growing.
    const proximityRows = await prisma.experience.findMany({
      where: hardConstraints,
      select: { id: true, venue: { select: { latitude: true, longitude: true } } },
      take: 5000,
    });
    const nearestDistanceMiles = (row: (typeof proximityRows)[number]): number =>
      row.venue
        ? Math.min(...memberCoords.map((c) => haversineMiles(c.homeLat, c.homeLng, row.venue!.latitude, row.venue!.longitude)))
        : Number.POSITIVE_INFINITY; // no venue = distance genuinely unknown, sorts last, never excluded
    const nearestIds = proximityRows
      .map((row) => ({ id: row.id, distance: nearestDistanceMiles(row) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 50)
      .map((row) => row.id);
    const hydrated = await prisma.experience.findMany({ where: { id: { in: nearestIds } }, include: { venue: true } });
    const hydratedById = new Map(hydrated.map((e) => [e.id, e]));
    // `findMany({ where: { id: { in: ... } } })` never guarantees it echoes back `in`'s own
    // order — re-applying the distance-sorted order here is what actually keeps "nearest first"
    // true for the scored/deduped output below, not just for this intermediate id list.
    candidates = nearestIds.map((id) => hydratedById.get(id)).filter((e): e is (typeof hydrated)[number] => Boolean(e));
  } else {
    // No member has a home location set, and the Crew has no explicit location either — nothing
    // to sort by proximity to. Falls back to the pre-fix query shape, with one still-safe
    // improvement: explicit quality ordering, since a fully arbitrary order was never actually
    // desirable even before this fix existed.
    candidates = await prisma.experience.findMany({ where: hardConstraints, include: { venue: true }, orderBy: { qualityScore: 'desc' }, take: 50 });
  }

  const dnaTopCategories = new Set((dna?.topCategories as string[] | undefined) ?? []);
  // REAL GAP this closes: the Crew's own explicit `travelRadiusMeters` (product spec's own
  // "Crew location + travel radius are known") used to only ever reach scoring via the
  // AUTOMATIC engine explicitly passing it as `radiusMetersOverride` — the manual "Find us
  // something"/"Suggest something" flows (this function's other two callers) never read it at
  // all, silently falling all the way through to a member-taste-profile median or the generic
  // onboarding default instead. A Crew that explicitly set a 25-mile radius could still have its
  // own manual "Find us something" evaluate against the unrelated ~15-mile onboarding default —
  // found writing this rebuild's own location regression tests. `opts.radiusMetersOverride`
  // still wins when a caller passes one explicitly (evaluateCrewEligibility does, for its own
  // diagnostic clarity); everyone else now gets the Crew's own real setting as the default,
  // before ever falling back to member taste profiles or the generic default.
  const radiusMeters = opts.radiusMetersOverride
    ?? recommendationSettings?.travelRadiusMeters
    ?? (medianOf(tasteProfiles.map((tp) => tp.travelRadiusMeters).filter((r) => r > 0)) || DEFAULT_RADIUS_METERS);
  const radiusMiles = radiusMeters / 1609.34;

  // Layer 1b: the Crew's OWN explicit category/interest picks, when set, are a HARD FILTER on
  // the candidate pool — never just a scoring bonus blended in with individual member taste.
  // REAL, LIVE-REPORTED BUG this fixes: a brand-new Crew's preferences were set to food ONLY,
  // and the very first thing Plot ever sent that Crew was a comedy event. Root cause — below,
  // `crewCategoryPreferences.has(experience.category)` only ever ADDED score+a reason on top of
  // whatever a candidate already had; it never excluded anything. A member's own personal
  // TasteProfile (comedy affinity from THEIR OWN onboarding swipes, nothing to do with what
  // THIS Crew explicitly said it's about) was on its own enough to clear the confidence bar via
  // category_affinity/interest_match alone, for a category the Crew never asked for. Once a
  // Crew has explicitly said "we are specifically this", that IS the Crew's answer — a member's
  // own unrelated personal taste can still rank AMONG matching options (the scoring below is
  // unchanged for those), it can never again override the restriction itself. Empty preferences
  // (a Crew that hasn't said anything explicit) keeps the original, fully member-derived
  // behaviour — nothing to restrict to yet.
  // REAL, LIVE-REPORTED BUG this same filter went on to cause: a Crew picked a specific INTEREST
  // (not a whole category) — "we don't have any [interest] events near London that we can
  // honestly recommend yet" for a city with genuinely deep real inventory. Root cause:
  // `experienceInterestTags` only ever matches an interest by literally finding one of its
  // synonyms in an Experience's own subcategories/name/description text — real provider data
  // (Ticketmaster, Skiddle, PredictHQ) essentially never carries Plot's own taxonomy's specific
  // wording, so an interest-only preference could legitimately match zero real experiences even
  // in a city with hundreds of genuinely relevant ones. A Crew choosing a specific interest is
  // still choosing that interest's own parent categories (`TASTE_INTEREST_INDEX`'s own
  // `territory.categories` — e.g. picking a food interest under the "Food & Drink" territory is
  // still, at minimum, choosing RESTAURANT) — so those categories pass this hard gate too,
  // exactly as if the Crew had ticked the category box directly. This never widens what an
  // interest-only Crew can be sent beyond categories THEY THEMSELVES implied by their own pick —
  // still never comedy for a food-only Crew — it only stops a real category match from being
  // thrown out purely because live inventory doesn't happen to use Plot's own interest wording.
  // A literal interest-tag match still scores and reads as more specific below (`interest_match`/
  // `crew_interest_preference`) — this only affects which candidates reach scoring at all.
  // THIRD real, live-reported bug this same filter went on to cause: a Crew set its preferences
  // to street food / food festivals / wine bars — the very first thing Plot sent it was a grime
  // artist's tour date, categorized COMMUNITY. Root cause: COMMUNITY sits in the food territory's
  // own `categories` list, but every live provider adapter also uses COMMUNITY as its universal
  // fallback for anything it can't confidently classify at all (see @plot/shared's
  // CATCH_ALL_CATEGORIES for the full rationale and provider-by-provider evidence).
  // FOURTH real, live-reported bug (the SAME Crew, the SAME artist, reported again — the fix
  // above wasn't the whole story): this time the event was categorized CLUBBING. Root cause:
  // `wine_bars` lives under the `drinks_nightlife` territory, whose `categories` is
  // `['BAR', 'CLUBBING']` — a wine bar and a full nightclub night are genuinely different
  // things, and picking "wine bars" never said anything about wanting clubbing. CLUBBING is
  // claimed by TWO territories (`music` and `drinks_nightlife`), the exact ambiguity
  // @plot/shared's `UNAMBIGUOUS_CATEGORIES` exists to exclude — this file used to only exclude
  // `CATCH_ALL_CATEGORIES`, never the broader ambiguous-territory case, even though
  // services/tasteSignals.ts (Home/Explore's own equivalent widening) already had to learn this
  // exact lesson for DAY_ACTIVITY (Food + Outdoors). Now both files share the one definition —
  // see `UNAMBIGUOUS_CATEGORIES`'s own doc comment for why this can't be allowed to drift apart
  // between the two call sites again. A literal interest-tag match still lets ANY category
  // through on its own real merit (the `experienceInterestTags` check below applies regardless of
  // whether a category is ambiguous) — only the "same territory, no other evidence" shortcut is
  // restricted to categories no OTHER territory or provider-fallback pattern could also produce.
  // FOURTH real, live-reported bug: "I love drill" -> Sam Smith, captioned "because you're into
  // drill". `music` bundles ~30 genuinely distinct, often mutually-exclusive genres under
  // LIVE_MUSIC/FESTIVAL — bare category membership is never enough evidence on its own for a
  // territory this broad, so a Crew whose interest picks fall under `music`
  // (`TERRITORIES_REQUIRING_EXPLICIT_RELATION`) get NO blanket category grant here at all — only
  // an explicit, curated close relation (`RELATED_INTERESTS`), checked below against what the
  // candidate's own text actually, literally supports.
  const categoriesImpliedByInterests = new Set<string>();
  for (const interestId of crewInterestPreferences) {
    const territory = TASTE_INTEREST_INDEX.get(interestId)?.territory;
    if (!territory || TERRITORIES_REQUIRING_EXPLICIT_RELATION.has(territory.id)) continue;
    for (const category of territory.categories) {
      if (!UNAMBIGUOUS_CATEGORIES.has(category)) continue;
      categoriesImpliedByInterests.add(category);
    }
  }

  const crewHasExplicitPreference = crewCategoryPreferences.size > 0 || crewInterestPreferences.size > 0;
  const preferenceFilteredCandidates = !crewHasExplicitPreference
    ? candidates
    : candidates.filter((experience) => {
        if (crewCategoryPreferences.has(experience.category)) return true;
        if (categoriesImpliedByInterests.has(experience.category)) return true;
        const tags = experienceInterestTags(experience);
        if (tags.some((tag) => crewInterestPreferences.has(tag))) return true;
        // The explicit-relation fallback for territories requiring one (see this block's own
        // comment above) — a real, specific, curated sibling relationship (e.g. drill/grime),
        // never a fabricated match: still requires the candidate's own text to literally support
        // the related interest.
        for (const interestId of crewInterestPreferences) {
          const relatives = RELATED_INTERESTS[interestId] ?? [];
          if (relatives.some((rel) => tags.includes(rel))) return true;
        }
        return false;
      });

  // PART TWO of the "Caffè Nero in London" fix — the location gate above stops the WRONG PLACE;
  // this stops the RIGHT PLACE, WRONG REASON case: a genuinely in-radius, category-matching
  // candidate that is still not a reason a friend group makes a plan (a generic coffee chain, an
  // ordinary permanent venue with nothing specific going on). A HARD gate, not a scoring
  // penalty — "the recommendation itself should carry weight" only holds if Plot never has to
  // choose between a great match and a merely-adjacent one and can lose. Applies to every
  // Crew-facing flow that shares this scorer (the automatic sweep AND the manual "Find us
  // something"/"Suggest something" flows — all three are Plot placing a bet into this Crew's own
  // conversation, the same bar) — never Explore or Home, which stay deliberately broad (see
  // services/explore.ts / personalHome.ts, and opportunityIntent.ts's own header). See
  // docs/DECISIONS.md#crew-recommendation-architecture for the full reasoning and the exact
  // regression test this closes.
  const filteredCandidates = preferenceFilteredCandidates.filter((experience) => isPlanWorthyForCrew(experience));

  const scored: MatchOption[] = [];
  for (const experience of filteredCandidates) {
    const reasons: MatchReason[] = [];
    let score = 0;

    // Layer 2: preference scoring — category (0-30) then specific interest (0-30, see below).
    // Real learning applied here: `learningBias` nudges the effective affinity this Crew sees
    // for a category/interest based on how they've actually responded before (respondToRecommendation
    // -> crewRecommendations.ts), never permanently, never from a single response — see
    // `buildLearningBias`'s own comment for exactly which responses count and why.
    const affinities = tasteProfiles
      .map((tp) => (tp.categoryAffinity as Record<string, number>)[categoryToTasteKey(experience.category)])
      .filter((v): v is number => typeof v === 'number');
    const avgAffinity = affinities.length ? affinities.reduce((a, b) => a + b, 0) / affinities.length : 0;
    const categoryBias = learningBias.category.get(experience.category) ?? 0;
    const effectiveCategoryAffinity = avgAffinity + categoryBias;
    score += Math.max(0, effectiveCategoryAffinity) * 30;
    if (avgAffinity > 0.3) {
      reasons.push({ code: 'category_affinity', label: `${Math.round((affinities.filter((a) => a > 0).length / Math.max(1, affinities.length)) * members.length)}/${members.length} usually go for this` });
    }

    if (dnaTopCategories.has(experience.category)) {
      score += 15;
      reasons.push({ code: 'crew_dna_match', label: "Matches this Crew's usual taste" });
    }

    // A Crew's own explicit pick is already a hard gate on the candidate pool above (see
    // `filteredCandidates`) — reaching this line means either the Crew set no explicit
    // preference at all, or this experience already matches one. This still adds its own score
    // + reason on top of member-derived taste (the group deliberately saying "we're specifically
    // into this" counts as a taste signal in its own right — see hasTasteSignal in
    // crewRecommendations.ts) so a preference-matching candidate a member ALSO personally likes
    // still ranks above one that only just cleared the Crew's own bar.
    if (crewCategoryPreferences.has(experience.category)) {
      score += 20;
      reasons.push({ code: 'crew_preference', label: 'Your Crew set this as a preference' });
    }

    // THE PERSONALISATION-ENGINE LAYER — this is the actual fix for "someone saying 'I like
    // music' tells Plot almost nothing" (brief's own framing). Real provider data (Experience.
    // subcategories — Ticketmaster genres, Skiddle event codes, OSM cuisine tags) mapped onto
    // Plot's own interest taxonomy (@plot/shared/tasteTaxonomy.ts), matched against each
    // member's own TasteProfile.interestAffinity. Scored roughly level with category affinity,
    // not additively stacked on top of it without limit — a specific match is a stronger signal
    // than a broad one, but this is still one Crew's one Experience, not two independent votes.
    let interestScore = 0;
    let bestInterestId: string | null = null;
    let bestInterestMemberCount = 0;
    const tags = experienceInterestTags(experience);
    if (tags.length > 0 && tasteProfiles.length > 0) {
      for (const tag of tags) {
        const tagBias = learningBias.interest.get(tag) ?? 0;
        const perMember = tasteProfiles.map((tp) => ((tp.interestAffinity as Record<string, number> | undefined) ?? {})[tag] ?? 0);
        const positiveCount = perMember.filter((v) => v > 0).length;
        const avg = (perMember.length ? perMember.reduce((a, b) => a + b, 0) / perMember.length : 0) + tagBias;
        const contribution = Math.max(0, avg) * 30;
        if (contribution > interestScore) {
          interestScore = contribution;
          bestInterestId = tag;
          bestInterestMemberCount = positiveCount;
        }
      }
    }
    if (bestInterestId && interestScore > 6) {
      score += interestScore;
      reasons.push({
        code: 'interest_match',
        label:
          bestInterestMemberCount > 0
            ? `${bestInterestMemberCount}/${members.length} of you are into ${interestLabel(bestInterestId)}`
            : `Matches ${interestLabel(bestInterestId)}`,
      });
    }

    // Crew-level specific-interest picks — one level more precise than crewCategoryPreferences
    // ("we're specifically a UK garage crew", not just "a music crew").
    const matchedCrewInterest = tags.find((tag) => crewInterestPreferences.has(tag));
    if (matchedCrewInterest) {
      score += 18;
      reasons.push({ code: 'crew_interest_preference', label: `Your Crew set ${interestLabel(matchedCrewInterest)} as a preference` });
    } else if (categoriesImpliedByInterests.has(experience.category)) {
      // REAL, LIVE-REPORTED BUG this closes: "no boxing or mma or street food or food festivals
      // or wine bars events near Birmingham" for a Crew whose members had never set boxing/street
      // food events elsewhere — real Birmingham inventory (OSM bars/restaurants, mock restaurant
      // fixtures) WAS passing the hard filter above via `categoriesImpliedByInterests` (see its
      // own comment), but scored ZERO taste-signal reason: `matchedCrewInterest` only ever fires
      // on a LITERAL tag match, and every OTHER taste-signal reason in this function is either
      // the Crew's own explicit WHOLE-CATEGORY pick (`crew_preference`, above) or an individual
      // MEMBER's own unrelated personal taste (`category_affinity`/`interest_match`) — neither is
      // what actually let this candidate through the hard filter. With no real reason attached,
      // `hasTasteSignal` (crewRecommendations.ts) never counted it as taste-matched, so it could
      // pass the candidate pool and STILL never be delivered — passing the filter and being
      // eligible to send were never the same thing. Find which of the Crew's own interest picks
      // implied this category and credit it honestly (smaller than a literal match — this is a
      // territory-level inference, not "you asked for exactly this").
      //
      // FIFTH real, live-reported bug this closes — the SAME "because you're into drill" mistake
      // as the music fix, just for SPORT: this branch used to always name the FIRST qualifying
      // crew interest specifically ("Matches your Crew's Boxing preference") even when the
      // candidate had zero textual evidence of being that specific sport — a boxing label on a
      // rugby match is exactly as dishonest as a drill label on Sam Smith. Fixed the same way:
      // only name a specific interest when `tags` (the candidate's own real genre/subcategory
      // text) genuinely supports it — either the interest itself, or a real, curated sibling
      // (`RELATED_INTERESTS` — e.g. a Crew picked MMA, this is literally tagged Boxing, real fan
      // overlap, worth an honest cross-suggestion). With no textual evidence for anything specific,
      // fall back to a genuinely honest, non-specific territory-level label ("Matches your Crew's
      // Sport interests") — the eligibility (this candidate is shown at all) is unchanged, only
      // the CLAIM the caption makes is now never bigger than the real evidence backs.
      let impliedByCrewInterestId: string | null = null;
      let relatedSiblingId: string | null = null;
      let territoryLabelForGenericFallback: string | null = null;
      for (const interestId of crewInterestPreferences) {
        const territory = TASTE_INTEREST_INDEX.get(interestId)?.territory;
        if (!territory || TERRITORIES_REQUIRING_EXPLICIT_RELATION.has(territory.id) || !territory.categories.includes(experience.category)) continue;
        if (!territoryLabelForGenericFallback) territoryLabelForGenericFallback = territory.label;
        const sibling = (RELATED_INTERESTS[interestId] ?? []).find((rel) => tags.includes(rel));
        if (sibling) {
          impliedByCrewInterestId = interestId;
          relatedSiblingId = sibling;
          break;
        }
      }
      if (relatedSiblingId && impliedByCrewInterestId) {
        score += 16;
        reasons.push({ code: 'crew_interest_preference', label: `You said ${interestLabel(impliedByCrewInterestId)} — this is ${interestLabel(relatedSiblingId)}, closely related` });
      } else if (territoryLabelForGenericFallback) {
        score += 15;
        reasons.push({ code: 'crew_interest_preference', label: `Matches your Crew's ${territoryLabelForGenericFallback} interests` });
      }
    }

    // Free-text signals ("Fred again..") — matched LITERALLY against this Experience's own name/
    // description, quoted back verbatim in the reason, never dressed up as a taxonomy match. See
    // tasteSignals.ts#experienceMatchesFreeText's own comment on why that's more honest here.
    for (const tp of tasteProfiles) {
      const signals = (tp.freeTextSignals as unknown as FreeTextSignal[] | undefined) ?? [];
      const hit = signals.find((s) => experienceMatchesFreeText(experience, s.text));
      if (hit) {
        score += 22;
        reasons.push({ code: 'free_text_match', label: `You said "${hit.text}"` });
        break; // one quote is enough to explain it, not one per member who happened to type it
      }
    }

    // Layer 3: context — category-specific comfortable spend where a member has set one (brief's
    // "£15 on comedy, £100 on a concert"), falling back to their one global budget range.
    const effectiveBudget = medianOf(
      tasteProfiles.map((tp) => {
        const perCategory = (tp.categoryBudget as Record<string, { minMinor: number; maxMinor: number }> | undefined)?.[experience.category];
        return perCategory ? (perCategory.minMinor + perCategory.maxMinor) / 2 : (tp.budgetMinMinor + tp.budgetMaxMinor) / 2;
      }),
    );
    if (experience.priceMinMinor !== null && effectiveBudget > 0) {
      if (experience.priceMinMinor <= effectiveBudget) {
        score += 15;
        reasons.push({ code: 'under_budget', label: "Under your Crew's typical spend" });
      } else if (experience.priceMinMinor > effectiveBudget * 1.5) {
        score -= 10; // over budget is a soft penalty, not a hard filter — groups do splurge
      }
    }

    // Distance — the CLOSEST member's distance, not the group average. Real bug found running
    // this against actual Crews in production: a Crew whose members live in genuinely different
    // places (one in Birmingham, one in London — completely normal for a real friend group, not
    // an edge case) had `withinRadius` false for literally every candidate, forever, because the
    // *average* of two ~100-mile-apart homes to any real venue is never going to land inside any
    // sane travel radius, even for a venue sitting right next to one of them. Averaging silently
    // assumes a Crew clusters around one shared area; nearest-member distance instead asks "is
    // this reasonably close to at least one of us", which is what "worth travelling for" is
    // actually supposed to mean for a group that doesn't all live in the same postcode. Never
    // fabricated for members with no home location set. See docs/DECISIONS.md#crew-auto-
    // recommendations.
    //
    // The radius itself now stretches for a genuinely high-affinity match (brief's "worth
    // travelling for" vs "normal range") — a strong specific-interest or category match earns real
    // extra travel allowance; a mediocre match never does, so this never becomes a loophole that
    // quietly widens everyone's radius.
    const strongAffinity = interestScore >= 24 || Math.max(0, effectiveCategoryAffinity) >= 0.6;
    const effectiveRadiusMiles = strongAffinity ? radiusMiles * 1.6 : radiusMiles;
    let withinRadius: boolean | null = null;
    let distanceMiles: number | null = null;
    if (experience.venue && memberCoords.length > 0) {
      const distances = memberCoords.map((c) => haversineMiles(c.homeLat, c.homeLng, experience.venue!.latitude, experience.venue!.longitude));
      const nearestMiles = Math.min(...distances);
      distanceMiles = nearestMiles;
      withinRadius = nearestMiles <= effectiveRadiusMiles;
      if (nearestMiles <= effectiveRadiusMiles) {
        // Closer scores higher, capped at 15 — a tiebreaker among in-radius options, not a
        // dominant factor (a great match slightly further is still worth surfacing).
        score += Math.max(0, 15 - (nearestMiles / effectiveRadiusMiles) * 15);
        const roundedMiles = Math.round(nearestMiles);
        const nearbyLabel = roundedMiles <= 1 ? 'Under a mile from your area' : `${roundedMiles} miles from your area`;
        reasons.push({
          code: 'nearby',
          label: strongAffinity && nearestMiles > radiusMiles ? `${nearbyLabel} — worth the trip for this` : nearbyLabel,
        });
      } else if (nearestMiles <= effectiveRadiusMiles * 1.5) {
        score -= 5; // a bit over — still shown to a member browsing manually, soft penalty only
      } else {
        score -= 15;
      }
    }

    const availability = await getMemberAvailability(
      userIds,
      experience.startsAt,
      experience.endsAt ?? new Date(experience.startsAt.getTime() + 4 * 60 * 60 * 1000),
    );
    const availableCount = [...availability.values()].filter(Boolean).length;
    const availableFraction = userIds.length ? availableCount / userIds.length : 0;
    score += availableFraction * 20;
    if (availableFraction >= 0.8) {
      reasons.push({ code: 'high_availability', label: `${availableCount}/${userIds.length} are free` });
    }

    // Quality/freshness bonus, small — a tiebreaker, not a driver.
    score += experience.qualityScore * 0.1;

    // REAL, LIVE PRODUCT REQUIREMENT: "I need ticketed only events... don't think we need to
    // include or focus on unpaid, no ticket events. This kills the app a bit for me." A real
    // ticket is the strongest evidence a candidate is actually worth interrupting a Crew's chat
    // for — someone has to pay and show up, which a permanent place listing (Caffè Nero's own
    // failure mode) or an undated free listing can never demonstrate. A genuine preference, not
    // a hard exclusion: crewRecommendations.ts's own tiering (ticketed candidates considered
    // first, a non-ticketed one only ever chosen — and honestly prefaced — when literally
    // nothing ticketed clears every other gate) is what actually enforces "ticketed first,
    // never silently"; this score bump is what makes the SAME preference hold for the manual
    // "Find us something"/"Suggest something" flows' own top-3 ranking, so a real ticket wins
    // there too, not just in the automatic sweep's own separate tiering logic.
    if (isTicketedEvent(experience)) {
      score += 14;
      reasons.push({ code: 'ticketed_event', label: 'Real tickets available' });
    }

    scored.push({
      experience,
      matchScore: Math.max(0, Math.min(100, Math.round(score))),
      reasons,
      availableMemberCount: availableCount,
      totalMemberCount: userIds.length,
      withinRadius,
      distanceMiles,
    });
  }

  scored.sort((a, b) => b.matchScore - a.matchScore);
  // Near-duplicate suppression (see entityResolution.ts#dedupeNearDuplicates) — runs after
  // sorting so the kept representative of any cluster is the best-scoring one, not just
  // whichever happened to be fetched first.
  return dedupeNearDuplicates(scored, (option) => ({
    name: option.experience.name,
    category: option.experience.category,
    startsAt: option.experience.startsAt,
  }));
}

/**
 * Every Experience this Crew should never be shown as "new" again — anything ever recommended
 * to it before (any status; a dismissal is still a "don't show again", not a "try harder next
 * time"), and anything a member has already shared/found and sent to the Crew as a Plan. Shared
 * by BOTH the automatic sweep (crewRecommendations.ts#evaluateCrewEligibility) and the manual
 * "Find us something"/"Suggest something" flow (findUsSomething below) — one definition, not
 * two that can drift. Real, live-reported gap this closes: before this was shared, ONLY the
 * automatic sweep excluded a Crew's own past rejections — a member tapping "Find us something"
 * again could be handed back the exact same event the Crew had just said NOT_FOR_US to, which
 * reads as Plot having no memory at all, exactly the "freshness" failure mode the brief warns
 * against.
 */
export async function getCrewExcludedExperienceIds(crewId: string): Promise<Set<string>> {
  const [alreadyRecommended, alreadyShared] = await Promise.all([
    prisma.crewRecommendation.findMany({ where: { crewId }, select: { experienceId: true } }),
    prisma.plan.findMany({ where: { crewId, experienceId: { not: null } }, select: { experienceId: true } }),
  ]);
  return new Set([...alreadyRecommended.map((r) => r.experienceId), ...alreadyShared.map((p) => p.experienceId as string)]);
}

/**
 * The narrower sibling used by the MANUAL "Find us something" flow only — every Experience this
 * Crew has given a definitively negative response to (NOT_FOR_US, WRONG_VIBE, TOO_FAR,
 * TOO_EXPENSIVE), never re-surfaced. Deliberately NOT `getCrewExcludedExperienceIds`'s full set:
 * that also excludes anything still sitting as a pending, unresponded automatic recommendation
 * (status SENT) — correct for the automatic sweep (never send the SAME thing twice, delivered or
 * not), but wrong here, since a member manually asking "Find us something" while Plot's own
 * current best find is still sitting unanswered in the Crew's chat should still be able to see
 * that exact thing, not have it silently swapped for a weaker match. A response is a real signal
 * either way; still-pending is not a rejection at all.
 */
export async function getCrewRejectedExperienceIds(crewId: string): Promise<Set<string>> {
  const rejected = await prisma.crewRecommendation.findMany({
    where: { crewId, status: { in: ['NOT_FOR_US', 'WRONG_VIBE', 'TOO_FAR', 'TOO_EXPENSIVE'] } },
    select: { experienceId: true },
  });
  return new Set(rejected.map((r) => r.experienceId));
}

/**
 * The signature "Find us something" interaction — runs the shared scorer, persists the result
 * for explainability/audit (brief §13 Intent Graph), and returns the top 3.
 */
export async function findUsSomething(
  crewId: string,
  requestedByUserId: string,
): Promise<{ recommendationId: string; options: MatchOption[] }> {
  // "no events or things should be done on crew until preference set" — covers suggestToCrewChat
  // too, since it calls straight through this function. See crewPreferencesGate.ts's own comment.
  await assertCrewPreferencesSet(crewId);

  const city = await resolveCrewCity(crewId, requestedByUserId);
  // Self-heals an unseeded city on first use — see ensureInventory's own comment.
  await ensureInventory(city);

  const scored = await scoreExperiencesForCrew(crewId);
  // Never resurface something this Crew has explicitly rejected before — see
  // getCrewRejectedExperienceIds's own comment on why this is deliberately narrower than the
  // automatic sweep's exclusion set. Only falls back to the unfiltered list when filtering would
  // leave nothing at all to show a member who explicitly asked (same "never come up completely
  // empty" reasoning as guaranteeFirst in crewRecommendations.ts) — a manual ask standing
  // empty-handed is worse than one repeat.
  const rejected = await getCrewRejectedExperienceIds(crewId);
  const fresh = scored.filter((o) => !rejected.has(o.experience.id));
  const candidatePool = fresh.length > 0 ? fresh : scored;
  const reranked = await identityRanker.rerank(candidatePool.slice(0, 10), { crewId });
  const top = reranked.slice(0, RESULT_COUNT);

  const [memberCount, dna, tasteProfiles] = await Promise.all([
    prisma.crewMember.count({ where: { crewId, status: 'ACTIVE' } }),
    prisma.crewDNA.findUnique({ where: { crewId } }),
    prisma.tasteProfile.findMany({ where: { user: { crewMemberships: { some: { crewId, status: 'ACTIVE' } } } } }),
  ]);
  const medianBudget = medianOf(tasteProfiles.map((tp) => (tp.budgetMinMinor + tp.budgetMaxMinor) / 2));
  const windowStart = new Date();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + CANDIDATE_WINDOW_DAYS);
  // Real bug this closes, caught by test/personalHome.test.ts's own acceptance run: without
  // this, "the next 21 days" silently means "21 days from THIS EXACT TIMESTAMP", not 21 full
  // calendar days — an event pinned to 8pm on day 21 was excluded whenever this ran earlier in
  // the day than 8pm, purely because of what time the request happened to fire, never a fact
  // about the event itself. End-of-day makes the window mean what it says.
  windowEnd.setHours(23, 59, 59, 999);

  const recommendation = await prisma.planRecommendation.create({
    data: {
      crewId,
      requestedByUserId,
      inputSnapshot: {
        memberCount,
        medianBudgetMinor: medianBudget,
        dnaConfidence: dna?.confidence ?? 'LOW',
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      },
      options: {
        create: top.map((option, index) => ({
          experience: { connect: { id: option.experience.id } },
          matchScore: option.matchScore,
          reasons: option.reasons as unknown as Prisma.InputJsonValue,
          rank: index + 1,
        })),
      },
    },
    include: { options: true },
  });

  await track(
    'RecommendationShown',
    { crewId, planRecommendationId: recommendation.id, optionCount: top.length },
    { userId: requestedByUserId, crewId },
  );

  return { recommendationId: recommendation.id, options: top };
}

/**
 * The core loop, made literal: Plot's job is to put good options in front of the group, in the
 * group's own conversation — not to make someone go browse a separate results screen and act
 * as the group's single filter. Runs the same ranking as `findUsSomething`, then immediately
 * sends each top option to the Crew exactly as if a member had reviewed and tapped "Send to
 * Crew" on it themselves (`sendExperienceToCrew` — same Plan creation, same rich event card
 * posted into chat, same everything). The whole crew sees the suggestions land as messages
 * they can react to and vote on together, with zero intermediate screen.
 */
export async function suggestToCrewChat(crewId: string, requestedByUserId: string): Promise<Plan[]> {
  const { options } = await findUsSomething(crewId, requestedByUserId);
  const plans: Plan[] = [];
  for (const option of options) {
    plans.push(await sendExperienceToCrew(crewId, option.experience.id, requestedByUserId));
  }
  await track('SuggestionsSentToChat', { crewId, count: plans.length }, { userId: requestedByUserId, crewId });
  return plans;
}

interface LearningBias {
  category: Map<string, number>;
  interest: Map<string, number>;
}

/** THE LEARNING LOOP — turns this Crew's actual past responses to recommendations into a bias
 *  applied to future scoring for that same Crew. Deliberately distinguishes two different kinds
 *  of PASS (brief §"be careful — one PASS should not permanently blacklist an entire category"):
 *
 *   - NOT_FOR_US / WRONG_VIBE are genuine taste signal ("not our thing") — negative bias.
 *   - TOO_FAR / TOO_EXPENSIVE are situational (wrong date/price/distance, not wrong taste) —
 *     contribute NOTHING here; match.ts's own distance/budget scoring already handles those
 *     dimensions directly, so double-counting them as a taste penalty would be exactly the "one
 *     PASS blacklists a category" failure mode the brief warns against.
 *   - MORE_LIKE_THIS is the positive counterpart, reinforcing a category/interest that landed well.
 *
 *  Each occurrence nudges by a small, capped amount (never unbounded) — a Crew that's said
 *  NOT_FOR_US to comedy three times ends up meaningfully cooler on comedy, not permanently
 *  zeroed out, and one MORE_LIKE_THIS can still counteract it. Scoped to THIS Crew's own
 *  scoring pass only, never written back into an individual member's TasteProfile — a Crew's
 *  collective "not for us" isn't necessarily true of any one person in it. */
function buildLearningBias(
  pastResponses: { status: string; experience: { category: string; subcategories: unknown; name: string; description: string } | null }[],
): LearningBias {
  const category = new Map<string, number>();
  const interest = new Map<string, number>();
  for (const r of pastResponses) {
    if (!r.experience) continue;
    let delta = 0;
    if (r.status === 'NOT_FOR_US' || r.status === 'WRONG_VIBE') delta = -0.35;
    else if (r.status === 'MORE_LIKE_THIS') delta = 0.35;
    if (delta === 0) continue;
    category.set(r.experience.category, clamp(-1, 1, (category.get(r.experience.category) ?? 0) + delta));
    for (const tag of experienceInterestTags(r.experience)) {
      interest.set(tag, clamp(-1, 1, (interest.get(tag) ?? 0) + delta));
    }
  }
  return { category, interest };
}

function clamp(min: number, max: number, v: number): number {
  return Math.max(min, Math.min(max, v));
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// categoryToTasteKey moved to tasteSignals.ts (re-exported here for anything still importing it
// from this file) — see that file's own comment for why: personalHome.ts needed it too, and
// tasteSignals.ts is the one place with no reverse dependency on either scorer.
export { categoryToTasteKey };
