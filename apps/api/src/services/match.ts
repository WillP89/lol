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
import { experienceInterestTags, experienceInterestTagsFromSubcategories, experienceMatchesFreeText, categoryToTasteKey, type FreeTextSignal } from './tasteSignals';
import { assertCrewPreferencesSet } from './crewPreferencesGate';
import { interestLabel, TASTE_INTEREST_INDEX, UNAMBIGUOUS_CATEGORIES, TERRITORIES_REQUIRING_EXPLICIT_RELATION, RELATED_INTERESTS } from '@plot/shared';
import { isPlanWorthyForCrew, isTicketedEvent } from './opportunityIntent';
import { computeCrewLearningBias } from './recommendationLearning';
import { deriveConfidence, type RecommendationConfidenceLevel } from './recommendationConfidence';
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
  // Real, evidence-derived confidence (services/recommendationConfidence.ts) — computed for
  // every scored option, not just ones the automatic engine ends up sending, so the manual
  // "Find us something" flow's own cards can show the same honest framing. Never a raw score or
  // percentage — see that file's own header.
  confidence: RecommendationConfidenceLevel;
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
// P0-FINAL — "QUALITY MUST BEAT PROXIMITY": the maximum the in-radius distance bonus can ever
// add to a candidate's score (see its own use below). Deliberately smaller than every real
// specificity/evidence-strength gap this file scores (e.g. a confirmed-subcategory
// `crew_interest_preference` match vs a text-only one) — distance is only ever supposed to
// decide a genuine near-tie between two comparably good options, per the product's own ranking
// order (intent match and specificity rank above location/travel). Used to be 15, close enough
// to that 9-point specificity gap that a closer-but-weaker candidate could out-score a
// materially stronger, more specific one purely on being a few miles nearer — proximity quietly
// acting as a quality override. See this constant's own use for the real, live-reported failure
// this fixes.
const NEARBY_BONUS_CAP = 8;
// The onboarding default (see onboarding/page.tsx) — used whenever we need a radius and no
// member has a real TasteProfile.travelRadiusMeters yet, so a brand-new Crew still gets a
// sane "worth travelling for" distance rather than an unbounded or zero radius. Exported so
// crewRecommendations.ts's radius-expansion tiering has the same concrete baseline to multiply
// from when a Crew has no explicit travelRadiusMeters of its own set either.
export const DEFAULT_RADIUS_METERS = 24000;

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
  const [members, dna, recommendationSettings, learningBias, crewLocation] = await Promise.all([
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
    // THE LEARNING LOOP (brief §"PASS teaches Plot nothing" — this is the fix), and its own
    // pilot-readiness rebuild (docs/DECISIONS.md#crew-recommendation-learning-engine): every real
    // signal this Crew has ever given Plot — per-member recommendation responses, real IN/MAYBE/
    // OUT votes, real Locked plans — weighted by how many DISTINCT people actually said it (never
    // one person's tap reading as the whole Crew's verdict) and decayed over time (preferences
    // change; nothing here is a permanent ban). See services/recommendationLearning.ts's own
    // header for the full model — this used to be a bare `buildLearningBias` reading only
    // CrewRecommendation.status, with neither of those two properties.
    computeCrewLearningBias(crewId),
    // The Crew's own explicit location (Crew.latitude/.longitude — see that field's own schema
    // comment) — read here alongside everything else this function already fetches once, rather
    // than requiring a second round trip.
    prisma.crew.findUnique({ where: { id: crewId }, select: { latitude: true, longitude: true } }),
  ]);
  const crewCategoryPreferences = new Set(recommendationSettings?.categoryPreferences ?? []);
  const crewInterestPreferences = new Set(recommendationSettings?.interestPreferences ?? []);

  // Layer 1b: the Crew's OWN explicit category/interest picks, when set, are a HARD FILTER on
  // the candidate pool — never just a scoring bonus blended in with individual member taste.
  // Computed here, BEFORE the proximity query below runs, rather than after it (where this used
  // to live) — see this whole block's history of real bugs, and `passesPreferenceGate`'s own
  // final comment on why moving it up here is itself the fix for the newest one.
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

  // REAL, LIVE-REPORTED BUG this closes ("0 scored / 0 in radius" for a Crew whose own explicit
  // interests — e.g. House/Techno/Disco, or Football/Boxing/MMA — had real, current matching
  // inventory genuinely within its own travel radius the whole time): the proximity query below
  // used to select the 50 NEAREST rows across EVERY category first, and only filtered down to
  // the Crew's own category/interest preference AFTER that cut. A city with a dense, hyper-local
  // cluster in one category (Stafford's ~130 FHRS restaurant/bar rows, every one within ~0-2km
  // of the town centre — the FHRS feed is a food-hygiene register, not an events source, so this
  // is entirely ordinary) completely fills that top-50 slice before a genuinely relevant but
  // farther-out SPORT/LIVE_MUSIC/CLUBBING row (a stadium or arena 20-40km out, still well inside
  // a 25-mile Crew radius) ever gets the chance to be one of the 50 candidates considered — the
  // category filter then had nothing of the right category left to keep, however deep the real
  // inventory actually was. Applying the SAME preference gate the post-hydration filter already
  // used (`preferenceFilteredCandidates` below) here too, before the nearest-50 cut, means a
  // Crew with an explicit preference only ever competes for its 50 slots against candidates that
  // could actually be sent to it — never crowded out by an unrelated category's own local
  // density. A Crew with NO explicit preference is completely unaffected (this gate is `true` for
  // everything when `crewHasExplicitPreference` is false, identical to today's behaviour).
  function passesPreferenceGate(experience: { category: string; subcategories: unknown; name: string; description: string }): boolean {
    if (!crewHasExplicitPreference) return true;
    if (crewCategoryPreferences.has(experience.category)) return true;
    if (categoriesImpliedByInterests.has(experience.category)) return true;
    const tags = experienceInterestTags(experience);
    if (tags.some((tag) => crewInterestPreferences.has(tag))) return true;
    for (const interestId of crewInterestPreferences) {
      const relatives = RELATED_INTERESTS[interestId] ?? [];
      if (relatives.some((rel) => tags.includes(rel))) return true;
    }
    return false;
  }

  // THE P0 FIX for "a Crew that picked LIVE GIGS + ROCK got recommended a K-pop show" — a real,
  // live-reported architectural failure, not a K-pop-specific one. Root cause: every one of a
  // Crew's own interestPreferences was treated as an independent, additive OR condition
  // throughout this whole file — `passesPreferenceGate` above admits a candidate the moment ANY
  // one pick matches (including a broad, context-setting pick like "Live gigs", which a K-pop
  // show genuinely, honestly satisfies), and the scoring loop below only ever ADDS bonus for a
  // literal match, never asks whether the candidate's own confirmed genre data actually
  // CONTRADICTS a different, more specific pick the same Crew also made. "Live gigs" + "Rock"
  // was never composed into "live ROCK gigs" anywhere — it was always "live gigs OR rock",
  // independently satisfiable by two completely unrelated pieces of evidence.
  //
  // This is the fix: a candidate CONTRADICTS a Crew's own taste the moment it carries CONFIRMED
  // evidence (subcategory-sourced — `experienceInterestTagsFromSubcategories`, never the loose
  // name/description keyword scan `experienceInterestTags` also does, which is exactly the weak
  // evidence that let "Live gigs" match a K-pop show's marketing copy in the first place) of a
  // DIFFERENT `narrows: true` interest in the SAME taxonomy territory as one the Crew explicitly
  // picked — and neither literally matches it nor is a curated `RELATED_INTERESTS` sibling. Only
  // interests marked `narrows: true` (a genre, a cuisine, a sport discipline — see that field's
  // own doc comment) can ever trigger this: a Crew that picked ONLY "Live gigs" (broad/context,
  // `narrows: false`) has made no genre claim at all, so nothing can contradict it — matches the
  // brief's own worked example verbatim ("If the Crew preference had ONLY been LIVE GIGS then a
  // local Stafford K-pop show could actually be a reasonable recommendation"). A candidate with
  // NO confirmed narrowing evidence at all (a genuinely untagged "Live Music Night") is never a
  // contradiction either — Plot doesn't know enough to call it wrong, and must still be able to
  // explore broadly (brief: "do not accidentally make the system so strict that a broad-interest
  // user receives nothing"). This only catches real, positive evidence of the WRONG specific
  // thing — never an absence of evidence.
  //
  // Deliberately NOT a hard exclusion from the candidate pool (unlike `passesPreferenceGate`
  // above) — a binary gate would make a contradicting candidate invisible to the recommendation-
  // debugger's own "what did Plot consider and why did it lose" trail (routes/admin.ts's
  // `explain-recommendation`), which the brief explicitly wants ("WHAT PLOT CONSIDERED, WHAT IT
  // REJECTED, WHY"). Instead this is consulted by the scoring loop below to cap a contradicting
  // candidate's score far under MIN_RECOMMENDATION_SCORE and strip any reason that would make it
  // read as a genuine taste match (see that loop's own comment) — visible in the debug trail with
  // an honest, specific rejection reason, never silently vanished, but never winning either.
  // URGENT LIVE-PRODUCT FIX (five fresh real Crews, tested by hand against the actual deployed
  // product, three of five failed): a Rock + Alternative Rock Crew's FIRST recommendation was a
  // hip-hop/rap event, captioned "2/2 of you are into hip hop and rap". Root cause, traced from
  // this exact function: it only ever checked `experienceInterestTagsFromSubcategories` (STRONG,
  // provider-subcategory-confirmed evidence) and bailed out entirely — `contradicts: false` — the
  // moment that set was empty. Real Ticketmaster/Skiddle rows routinely carry NO subcategory
  // genre data at all, so this check was silently inert for exactly the rows most likely to need
  // it. Meanwhile `interest_match` (this file, `tags`/`experienceInterestTags` — the WEAK,
  // name/description keyword scan) has no such requirement and confidently generated "N/M of you
  // are into hip hop" from that same weak text evidence. The asymmetry was the bug: evidence weak
  // enough to be excluded from contradiction-checking was simultaneously strong enough to drive a
  // confident personalisation claim. Fixed by checking weak tags too, whenever the picked
  // interest itself has no supporting evidence (strong or weak) of its own — never overridden by
  // genuine strong support for the actual pick, so a real subcategory-confirmed match still wins
  // outright as before.
  function contradictsCrewInterestPreference(experience: { category: string; subcategories: unknown; name: string; description: string }): { contradicts: boolean; pickedInterestId: string | null; conflictingTag: string | null } {
    if (crewInterestPreferences.size === 0) return { contradicts: false, pickedInterestId: null, conflictingTag: null };
    const strongTags = experienceInterestTagsFromSubcategories(experience);
    const weakTags = experienceInterestTags(experience); // superset: subcategories + name/description keyword hits
    for (const pickedId of crewInterestPreferences) {
      const entry = TASTE_INTEREST_INDEX.get(pickedId);
      if (!entry || !entry.interest.narrows) continue; // only a genuine narrowing pick can ever be contradicted
      const territory = entry.territory;
      if (!territory.categories.includes(experience.category as (typeof territory.categories)[number])) continue;
      const related = new Set(RELATED_INTERESTS[pickedId] ?? []);
      const isRealContradiction = (tag: string) => {
        // A tag that matches THIS pick, a curated close relation of it, or ANY OTHER narrowing
        // interest the Crew ALSO explicitly picked is never a contradiction — real bug this
        // exact check fixes: a Crew that picked both `electronic` and `uk_garage` (two genuinely
        // different, both genuinely wanted, narrowing picks in the same territory) had a
        // confirmed UK-garage-tagged event flagged as "contradicting" the `electronic` pick,
        // purely because it wasn't a literal match or curated relation of THAT ONE pick — even
        // though it was a direct, literal match of the Crew's OTHER pick. A Crew is always
        // allowed to want more than one specific thing in the same territory.
        if (tag === pickedId || related.has(tag) || crewInterestPreferences.has(tag)) return false;
        const tagEntry = TASTE_INTEREST_INDEX.get(tag);
        return Boolean(tagEntry?.interest.narrows && tagEntry.territory.id === territory.id);
      };
      const strongConflict = strongTags.find(isRealContradiction);
      if (strongConflict) return { contradicts: true, pickedInterestId: pickedId, conflictingTag: strongConflict };
      // No STRONG contradiction for this pick. If the candidate also carries no STRONG support
      // for the pick itself (or a sibling) — i.e. a real provider genre tag never actually
      // confirmed this pick either way — a WEAK (text-only) hit for a DIFFERENT narrowing
      // interest in the same territory is still real, checkable, positive evidence something
      // else is going on. This is deliberately the exact same evidence `interest_match` above
      // already treats as strong enough to generate a confident "you're into X" claim — it must
      // be treated as strong enough to also block a contradicting claim.
      const hasStrongSupportForThisPick = strongTags.includes(pickedId) || [...related].some((r) => strongTags.includes(r));
      if (hasStrongSupportForThisPick) continue;
      const weakConflict = weakTags.find(isRealContradiction);
      if (weakConflict) return { contradicts: true, pickedInterestId: pickedId, conflictingTag: weakConflict };
    }
    return { contradicts: false, pickedInterestId: null, conflictingTag: null };
  }

  // SECOND urgent live-product fix, same test round: a Nightlife + House + UK Garage Crew's
  // first recommendation was a generic Amy Winehouse tribute night — no genre tag evidence at
  // all, strong or weak, for ANYTHING (real provider rows for tribute/covers acts routinely carry
  // none). `contradictsCrewInterestPreference` above correctly found nothing to contradict — but
  // "found nothing to contradict" and "genuinely matches what this Crew asked for" are not the
  // same claim, and the candidate still won on the strength of a bare, unconfirmed category-level
  // admission. THE RULE (live product directive, verbatim): "a candidate that only satisfies the
  // broad parent should not automatically remain eligible" when the Crew also made a specific,
  // narrowing pick in that same territory. Deliberately NOT applied when the candidate has an
  // INDEPENDENT, non-narrowing reason to be in the pool at all (an explicit whole-category pick,
  // or a different, non-narrowing interest the candidate's own text genuinely supports) — composed
  // intents are not all equally strict (live directive's own worked example: "FOOD FESTIVALS +
  // STREET FOOD + ITALIAN means food/street-food event discovery, WITH ITALIAN AS A TASTE SIGNAL",
  // not a hard requirement every candidate must independently confirm). Only fires when the
  // narrowing-pick territory is the CANDIDATE'S ONLY reason to be here at all — exactly the
  // Amy-Winehouse-under-a-broad-Nightlife-admission shape, never a genuine street-food festival
  // that just doesn't happen to confirm a cuisine on top.
  function lacksRequiredNarrowingEvidence(experience: { category: string; subcategories: unknown; name: string; description: string }): { tooBroad: boolean; pickedInterestId: string | null; territoryLabel: string | null } {
    if (crewInterestPreferences.size === 0) return { tooBroad: false, pickedInterestId: null, territoryLabel: null };
    const narrowingPicks = [...crewInterestPreferences].filter((id) => TASTE_INTEREST_INDEX.get(id)?.interest.narrows);
    if (narrowingPicks.length === 0) return { tooBroad: false, pickedInterestId: null, territoryLabel: null };
    if (crewCategoryPreferences.has(experience.category)) return { tooBroad: false, pickedInterestId: null, territoryLabel: null };
    const tags = experienceInterestTags(experience);
    const nonNarrowingPicks = [...crewInterestPreferences].filter((id) => !narrowingPicks.includes(id));
    for (const id of nonNarrowingPicks) {
      if (tags.includes(id)) return { tooBroad: false, pickedInterestId: null, territoryLabel: null };
      const territory = TASTE_INTEREST_INDEX.get(id)?.territory;
      if (territory && !TERRITORIES_REQUIRING_EXPLICIT_RELATION.has(territory.id) && territory.categories.includes(experience.category as (typeof territory.categories)[number])) {
        return { tooBroad: false, pickedInterestId: null, territoryLabel: null };
      }
    }
    // Two passes, deliberately — same "a Crew is always allowed to want more than one specific
    // thing in the same territory" principle contradictsCrewInterestPreference's own comment
    // establishes. Real bug an early single-pass version of this had: a Crew that picked BOTH
    // `electronic` and `uk_garage` had a genuinely, strongly UK-garage-confirmed candidate marked
    // "too broad" purely because it happened to check `electronic` first and find no evidence for
    // THAT ONE pick — never noticing the candidate already satisfied the Crew's OTHER pick. First
    // pass: does ANY relevant narrowing pick have positive evidence anywhere? If so, this
    // candidate is fine, full stop — never flagged just for failing to ALSO confirm a different
    // pick nothing else requires it to confirm.
    let firstRelevant: { pickedId: string; territoryLabel: string } | null = null;
    for (const pickedId of narrowingPicks) {
      const entry = TASTE_INTEREST_INDEX.get(pickedId)!;
      const territory = entry.territory;
      if (!territory.categories.includes(experience.category as (typeof territory.categories)[number])) continue;
      const related = new Set(RELATED_INTERESTS[pickedId] ?? []);
      if (tags.includes(pickedId) || [...related].some((r) => tags.includes(r))) return { tooBroad: false, pickedInterestId: null, territoryLabel: null };
      if (!firstRelevant) firstRelevant = { pickedId, territoryLabel: territory.label };
    }
    // Second pass reached: no relevant narrowing pick has any positive evidence at all, and no
    // independent (non-narrowing) admission route exists either — genuinely too broad.
    if (firstRelevant) return { tooBroad: true, pickedInterestId: firstRelevant.pickedId, territoryLabel: firstRelevant.territoryLabel };
    return { tooBroad: false, pickedInterestId: null, territoryLabel: null };
  }
  // Comfortably under MIN_RECOMMENDATION_SCORE (55, crewRecommendations.ts) even after every
  // other bonus (distance/availability/quality/ticketed) stacks on top of it — a contradicting
  // candidate must never clear the normal delivery bar through sheer unrelated score volume.
  const MAX_SCORE_FOR_CONTRADICTING_CANDIDATE = 20;
  // Reason codes crewRecommendations.ts#hasTasteSignal treats as genuine taste evidence — stripped
  // from a contradicting candidate's own reasons so it can never read as a taste-matched pick
  // (free_text_match deliberately excluded: a literal, deliberate mention of an artist/event name
  // is always real, first-person evidence and must never be overridden by a taxonomy inference).
  const TASTE_SIGNAL_CODES_OVERRIDABLE_BY_CONTRADICTION = new Set(['category_affinity', 'crew_dna_match', 'crew_preference', 'interest_match', 'crew_interest_preference']);

  // SAME bug shape as passesPreferenceGate above, found in the follow-up gate audit that
  // shipped alongside the "Caffè Nero in London" plan-worthiness fix: isPlanWorthyForCrew used
  // to run only AFTER the nearest-50-by-distance cut below (see `filteredCandidates`, further
  // down this function) — meaning a chain-saturated town centre (McDonald's/KFC/Subway/Greggs/
  // Starbucks, all force-floored to VERY_LOW by isGenericChainName) could fill the nearest-50
  // slice before a genuine, non-chain venue sitting at position 51+ by pure distance ever got
  // the chance to be considered, even when it's well inside the Crew's own travel radius. Gating
  // BEFORE the cut, identical in spirit to passesPreferenceGate's own fix, means a Crew's 50
  // candidate slots are only ever spent on venues that could actually be recommended.
  function passesEarlyPlanWorthinessGate(experience: { category: string; subcategories: unknown; name: string; description: string; tags: unknown }): boolean {
    return isPlanWorthyForCrew(experience as Parameters<typeof isPlanWorthyForCrew>[0]);
  }

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
      // category/subcategories/name/description/tags added alongside the original id+coordinates
      // projection specifically so `passesPreferenceGate` AND `passesEarlyPlanWorthinessGate` can
      // both run at THIS stage, before the nearest-50 cut below — see each function's own
      // comment for the real bug this closes.
      select: { id: true, category: true, subcategories: true, name: true, description: true, tags: true, venue: { select: { latitude: true, longitude: true } } },
      take: 5000,
    });
    const preferenceGatedRows = proximityRows.filter((row) => passesPreferenceGate(row) && passesEarlyPlanWorthinessGate(row));
    const nearestDistanceMiles = (row: (typeof proximityRows)[number]): number =>
      row.venue
        ? Math.min(...memberCoords.map((c) => haversineMiles(c.homeLat, c.homeLng, row.venue!.latitude, row.venue!.longitude)))
        : Number.POSITIVE_INFINITY; // no venue = distance genuinely unknown, sorts last, never excluded
    const nearestIds = preferenceGatedRows
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
  // the candidate pool — never just a scoring bonus blended in with individual member taste. The
  // actual gate (`passesPreferenceGate`, with its own full history of the real bugs that shaped
  // it — a food-only Crew sent comedy, a specific-interest Crew starved by real inventory not
  // using Plot's own wording, COMMUNITY/CLUBBING's provider-fallback ambiguity, "I love drill"
  // -> Sam Smith) now lives above, computed BEFORE the proximity query runs, so it can gate the
  // nearest-N cut itself too — see that function's own comment for why. Re-applied here as a
  // pure no-op safety net for the `else` branch above (no member/Crew location at all — the
  // proximity query never runs, so this is the first and only time the gate applies).
  const preferenceFilteredCandidates = candidates.filter((experience) => passesPreferenceGate(experience));

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
  // regression test this closes. Re-applied here as a pure no-op safety net for the `else`
  // branch above (no member/Crew location at all) — everyone else already had this gate applied
  // at the proximity-query stage via `passesEarlyPlanWorthinessGate`, before the nearest-50 cut
  // itself, for the exact same "don't let the cut spend its 50 slots on things that would be
  // filtered out anyway" reason `passesPreferenceGate` was moved earlier for.
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
    // Real gap this closes, found running a controlled specificity test: an untagged, generic
    // "Live Music Night" scored IDENTICALLY to a genuinely genre-tagged rock gig, because `tags`
    // above blends real provider genre data with a loose name/description keyword scan into one
    // undifferentiated set — see `experienceInterestTagsFromSubcategories`'s own comment. Used
    // below to scale both taste-signal bonuses by evidence strength: a real subcategory tag is
    // confirmed, specific evidence; a bare keyword hit in a title is much weaker and must never
    // score as if it were the same claim.
    const strongTags = experienceInterestTagsFromSubcategories(experience);
    if (tags.length > 0 && tasteProfiles.length > 0) {
      for (const tag of tags) {
        const tagBias = learningBias.interest.get(tag) ?? 0;
        const perMember = tasteProfiles.map((tp) => ((tp.interestAffinity as Record<string, number> | undefined) ?? {})[tag] ?? 0);
        const positiveCount = perMember.filter((v) => v > 0).length;
        const avg = (perMember.length ? perMember.reduce((a, b) => a + b, 0) / perMember.length : 0) + tagBias;
        const evidenceMultiplier = strongTags.includes(tag) ? 1 : 0.5;
        const contribution = Math.max(0, avg) * 30 * evidenceMultiplier;
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
    // ("we're specifically a UK garage crew", not just "a music crew"). Prefer a strong
    // (subcategory-confirmed) match over a weak (text-only) one when both exist, and score a
    // confirmed match higher — the same evidence-strength distinction as interest_match above.
    const matchedCrewInterest = strongTags.find((tag) => crewInterestPreferences.has(tag)) ?? tags.find((tag) => crewInterestPreferences.has(tag));
    if (matchedCrewInterest) {
      const isStrongMatch = strongTags.includes(matchedCrewInterest);
      score += isStrongMatch ? 18 : 9;
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
        // Closer scores higher, capped at NEARBY_BONUS_CAP — a genuine tiebreaker among in-radius
        // options, never big enough to outrank real specificity. THE ACTUAL "QUALITY MUST BEAT
        // PROXIMITY" FIX (P0-FINAL, CASE B — "a strong alternative-rock gig 25 miles away beats a
        // generic untagged live-music night 5 miles away"): this used to be capped at 15, close
        // enough to the confirmed-subcategory-vs-text-only specificity gap (isStrongMatch ? 18 : 9
        // below — a 9-point gap) that a merely-closer, weakly-evidenced candidate could out-score a
        // clearly stronger, more specific one purely on a few miles' difference — proximity acting
        // as a QUALITY OVERRIDE, exactly what the product spec's own ranking order (intent/
        // specificity/quality ABOVE location) forbids. NEARBY_BONUS_CAP is deliberately smaller
        // than every real specificity/evidence-strength gap this file scores (crew_interest_
        // preference's own 9-point strong-vs-weak gap included) so distance can decide a genuine
        // near-tie between two comparably good options, but can never rescue a weaker one.
        score += Math.max(0, NEARBY_BONUS_CAP - (nearestMiles / effectiveRadiusMiles) * NEARBY_BONUS_CAP);
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

    // See `contradictsCrewInterestPreference`'s own comment — the P0 fix for a Crew's specific
    // pick (Rock) being silently overridable by its own broader pick (Live gigs) matching
    // something else entirely (K-pop). Applied last, after every other bonus, so it can never be
    // outrun by unrelated score volume (distance/availability/quality/ticketed all still apply
    // above, on purpose — this caps the TOTAL, not just the taste-signal component).
    const contradiction = contradictsCrewInterestPreference(experience);
    if (contradiction.contradicts) {
      score = Math.min(score, MAX_SCORE_FOR_CONTRADICTING_CANDIDATE);
      const survivingReasons = reasons.filter((r) => !TASTE_SIGNAL_CODES_OVERRIDABLE_BY_CONTRADICTION.has(r.code));
      reasons.length = 0;
      reasons.push(
        {
          code: 'genre_contradiction',
          label: `You said ${interestLabel(contradiction.pickedInterestId!)} — this is ${interestLabel(contradiction.conflictingTag!)}, not a match`,
        },
        ...survivingReasons,
      );
    } else {
      const broad = lacksRequiredNarrowingEvidence(experience);
      if (broad.tooBroad) {
        score = Math.min(score, MAX_SCORE_FOR_CONTRADICTING_CANDIDATE);
        const survivingReasons = reasons.filter((r) => !TASTE_SIGNAL_CODES_OVERRIDABLE_BY_CONTRADICTION.has(r.code));
        reasons.length = 0;
        reasons.push(
          {
            code: 'genre_contradiction',
            label: `You picked ${interestLabel(broad.pickedInterestId!)} — nothing here actually confirms that, only a broader ${broad.territoryLabel} match`,
          },
          ...survivingReasons,
        );
      }
    }

    const matchScore = Math.max(0, Math.min(100, Math.round(score)));
    scored.push({
      experience,
      matchScore,
      reasons,
      availableMemberCount: availableCount,
      totalMemberCount: userIds.length,
      withinRadius,
      distanceMiles,
      confidence: deriveConfidence({ matchScore, reasons, experience }).level,
    });
  }

  scored.sort((a, b) => b.matchScore - a.matchScore);
  // Near-duplicate suppression (see entityResolution.ts#dedupeNearDuplicates) — runs after
  // sorting so the kept representative of any cluster is the best-scoring one, not just
  // whichever happened to be fetched first.
  return dedupeNearDuplicates(scored, (option) => {
    // `option.experience` is structurally `Experience & { venue: Venue | null }` at runtime
    // (every candidate here was hydrated with `include: { venue: true }` above) even though
    // MatchOption's own declared type only promises the bare `Experience` shape — see
    // entityResolution.ts's own comment for why real coordinates matter here (never merging two
    // different real venues that happen to share a common name).
    const withVenue = option.experience as Experience & { venue: Venue | null };
    return {
      name: withVenue.name,
      category: withVenue.category,
      startsAt: withVenue.startsAt,
      latitude: withVenue.venue?.latitude ?? null,
      longitude: withVenue.venue?.longitude ?? null,
    };
  });
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

// THE LEARNING LOOP itself moved to services/recommendationLearning.ts#computeCrewLearningBias
// — a real, weighted, decayed, positive-AND-negative model (docs/DECISIONS.md#crew-
// recommendation-learning-engine), replacing this file's old `buildLearningBias` (which only
// ever read one un-attributed status field per recommendation, with no notion of individual vs
// Crew signal or decay). See that file's own header for the full model.

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
