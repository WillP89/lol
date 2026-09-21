import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { track } from './analytics';
import { ensureInventory, enrichMissingImageForExperience } from './inventorySync';
import { scoreExperiencesForCrew, getCrewExcludedExperienceIds, DEFAULT_RADIUS_METERS, type MatchOption } from './match';
import { experienceInterestTagsFromSubcategories } from './tasteSignals';
import { createRecommendationPlanForCrew } from './plan';
import { sendSystemMessage } from './chat';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { interestLabel } from '@plot/shared';
import { derivePlanWorthiness, deriveBookingType, deriveSourceKind, isTicketedEvent } from './opportunityIntent';
import { MIN_RECOMMENDATION_SCORE, EXPLORATION_MIN_SCORE, deriveConfidence, confidenceLeadIn } from './recommendationConfidence';
import { RecommendationResponseError, type RecommendationResponseAction } from './recommendationLearning';
import { tryDeriveAndApplyCrewPreferences } from './crewTasteDerivation';
import { Prisma } from '@prisma/client';
import type { CrewRecommendation } from '@prisma/client';

// Re-exported for callers that still import these from this file (routes/crews.ts) — the real
// definitions moved to services/recommendationLearning.ts alongside the learning model they
// feed, so the response-recording logic and the bias it produces can't drift apart across two
// files. See that file's own header.
export { RecommendationResponseError as RecommendationError, type RecommendationResponseAction };

/**
 * Real gap this closes: every rejection path in `generateRecommendationForCrew` just returned
 * `null` with zero trace of *why* — during pilot, "no recommendation was sent" and "the whole
 * pipeline is silently broken" were indistinguishable from the outside. One structured log line
 * per Crew per sweep, always (a decision was made either way), naming the exact reason a Crew
 * got nothing — never message/experience content, just IDs and counts. Queryable in production
 * (pino emits JSON there) by filtering `event: "crew_recommendation_evaluated"`.
 */
type RecommendationOutcome =
  | 'disabled'
  | 'preferences_not_set'
  | 'location_not_set'
  | 'crew_inactive'
  | 'too_soon'
  | 'weekly_cap_reached'
  | 'too_few_members'
  | 'no_eligible_candidate'
  | 'delivered'
  | 'error';
function logRecommendationOutcome(crewId: string, outcome: RecommendationOutcome, extra: Record<string, unknown> = {}) {
  logger.info({ event: 'crew_recommendation_evaluated', crewId, outcome, ...extra }, `Crew recommendation sweep: ${outcome}`);
  // Real pilot-analytics gap this closes — see CrewRecommendationEvaluated's own comment in
  // packages/shared/src/analytics.ts: this used to be a pino-only log line, so every sweep
  // outcome other than an actual delivery (nine different suppression/failure reasons) was
  // invisible to any real analytics query — "insufficient-inventory rate" and "suppression rate
  // by reason" were simply not computable. Fire-and-forget (not awaited) — this function's whole
  // contract is synchronous-looking logging that must never slow down or fail the real sweep it's
  // reporting on; `track()` itself already never throws (see analytics.ts's own comment).
  void track('CrewRecommendationEvaluated', { crewId, outcome }, { crewId });
}

/**
 * THE MOST IMPORTANT NEW FEATURE (pilot brief): Plot proactively finding and delivering
 * genuinely relevant things into a Crew's conversation, unprompted — not a passive
 * recommendations carousel a member has to go looking at. This is the automatic delivery
 * mechanism; the scoring itself is `scoreExperiencesForCrew` (services/match.ts), the exact
 * same deterministic engine that powers the member-triggered "Find us something"/"Suggest
 * something" flows. No ML, no fabricated "insight" — a real, explainable ranking over real
 * signals (category affinity, distance, budget, availability, freshness), same as the rest of
 * Match. See docs/DECISIONS.md#crew-auto-recommendations for the full design rationale.
 */

// MIN_RECOMMENDATION_SCORE/EXPLORATION_MIN_SCORE moved to services/recommendationConfidence.ts —
// the confidence floor and the eligibility floor are the same number by definition, now defined
// once. Still a confidence floor, not a quota: most weeks most Crews will see nothing, because
// most weeks nothing clears this bar. Never "keep lowering the bar until something ships" logic.
const LOOKBACK_DAYS_FOR_WEEKLY_CAP = 7;
// Real pilot-readiness cadence requirement: "space recommendations across the week... do not
// dump three into chat together." A floor between any two automatic sends for the SAME Crew,
// regardless of the weekly cap — spreads "up to 3/week" across early/mid/late week rather than
// letting three consecutive 6-hourly sweep passes (RECOMMENDATION_SWEEP_DUE_INTERVAL_MS) fire
// one right after another the moment a Crew clears its confidence bar three times in a row.
const MIN_HOURS_BETWEEN_RECOMMENDATIONS = 36;
// Real, live-tested gap (Cycle 9's continuity walkthrough): every active member voting OUT on the
// current recommendation's Plan is an unambiguous "this one's dead" signal — stronger than mere
// silence, which the normal 36h floor above is calibrated for. A shorter, still-deliberate floor
// applies ONLY in that specific case (see `getCrewActivitySignals`'s own
// `lastRecommendationUnanimouslyDeclined`) — long enough that a replacement never reads as instant
// chat spam seconds after the rejection, short enough to feel like Plot actually listened rather
// than making the Crew sit out the same wait as if nobody had said anything. Chosen to comfortably
// exceed one periodic sweep interval (RECOMMENDATION_SWEEP_DUE_INTERVAL_MS, 6h) so it's not
// artificially pinned to exactly that number, while staying well under half of the normal floor.
const MIN_HOURS_AFTER_UNANIMOUS_DECLINE = 8;
// "Do not blindly send three recommendations every week to abandoned Crews" — real signals of a
// Crew still being a going concern: recent chat, a recent response to a past recommendation, or
// recent Plan activity. A brand-new Crew gets an onboarding grace period (this same window)
// regardless of activity, since it hasn't had time to generate any yet. Chosen to comfortably
// span a realistic "we're mid-planning, just went quiet for a bit" gap without becoming
// effectively unconditional — a real, documented judgement call, not derived from data this
// pilot doesn't have yet (see docs/DECISIONS.md#crew-recommendation-learning-engine).
const ACTIVE_CREW_WINDOW_DAYS = 21;
// Diversity/fatigue (product spec Part 3): the last N sends' categories get a tapering score
// penalty against a repeat of the SAME category, so a strong exceptional match still wins (never
// randomised — Part 3's own explicit "relevance + variety, not randomness"), but a near-tie
// between "more of the same" and "something different" resolves toward variety. Applied only to
// the automatic engine's own candidate pool (this file), never to match.ts's shared scorer — a
// member manually asking "Find us something" wants the single best match, not a diversity-
// optimised one.
const CATEGORY_FATIGUE_WINDOW = 3;
const CATEGORY_FATIGUE_PENALTY = [12, 7, 3]; // most-recent-category penalty first, tapering
// Controlled exploration (product spec Part 7: "MOST high-confidence... SOME exploratory...
// VERY LITTLE true wildcard" — "very little", not zero, and never at the cost of a real match).
// Only reachable when NOTHING clears the normal confidence bar at all (never displaces a real
// HIGH/MEDIUM pick — see `selectExploratoryCandidate`'s own comment), and rate-limited to at most
// one per Crew per week so "exploratory" stays genuinely occasional, not a second normal tier.
const MAX_EXPLORATORY_SENDS_PER_WEEK = 1;
// Real, live-reported product failure this closes: "Plot sent an ordinary Stafford restaurant
// instead of a genuinely strong food festival that might exist a bit further out" — location was
// acting as a hard rescue-or-reject filter with no attempt to look wider when nothing near enough
// cleared the bar.
//
// P0-FINAL re-audit ("do not assume multiplying radius is automatically correct"): a flat `3x`
// multiplier is fine for a small preferred radius (10mi -> 30mi is a reasonable stretch) but
// breaks down at the real range the Crew radius picker actually offers (apps/web's own
// RADIUS_CHIPS goes up to "Worth travelling" = ~99 miles) — `3x` on a 50-mile preference is a
// 150-mile recommendation, and nobody asked for that just because the multiplier said so. Three
// independent bounds, the SMALLEST of which always wins, so none of them alone has to be
// perfectly tuned:
//  1. RELATIVE cap — never more than `EXPANSION_RELATIVE_CAP` x the Crew's own preferred radius,
//     tiered by how much the specific candidate actually earns (see `isSignificantOpportunity`).
//  2. ADDITIVE cap — never more than a bounded number of EXTRA miles beyond the preferred radius,
//     also tiered by significance — this is what actually stops a big preferred radius from
//     blowing up multiplicatively (100mi extra on a 50mi base would still pass the relative cap
//     at 2x; the additive cap is what catches it).
//  3. ABSOLUTE ceiling — `HARD_MAXIMUM_RADIUS_MILES` — never exceeded regardless of preference or
//     significance. Set to the single widest radius the Crew's own picker can ever explicitly
//     choose ("Worth travelling", ~99mi) — Plot's own automatic reach never exceeds the most
//     generous distance a Crew could have picked for itself.
//
// SIGNIFICANCE — "a major concert/festival can justify more travel than a small comedy night" —
// is never assumed from distance or category label alone; it's read from the same real evidence
// this whole file already trusts everywhere else (see `isSignificantOpportunity`): a VERY_HIGH
// plan-worthiness occasion (FESTIVAL), a real ticket, or a CONFIRMED (subcategory-sourced, not
// loose text) match to one of the Crew's own specific interest picks. A candidate beyond the
// STANDARD additive/relative cap must earn one of these to use the wider SIGNIFICANT cap at all
// — this is the actual "opportunity significance should matter" gate, not a second unconditional
// multiplier. A weak, generic candidate that merely happens to sit within 3x radius no longer
// gets to use that allowance for free.
const EXPANSION_RELATIVE_CAP = { standard: 2, significant: 3 };
const EXPANSION_ADDITIVE_MILES = { standard: 15, significant: 35 };
const HARD_MAXIMUM_RADIUS_MILES = 100; // apps/web's own top RADIUS_CHIPS option ("Worth travelling", 160000m)

/** The real, bounded "how far is a sensible stretch" computation — see the constants' own
 *  comment for why this is three independent caps, smallest wins, rather than a bare multiplier. */
function computeSensibleExpansionMiles(baseMiles: number, tier: 'standard' | 'significant'): number {
  const relative = baseMiles * EXPANSION_RELATIVE_CAP[tier];
  const additive = baseMiles + EXPANSION_ADDITIVE_MILES[tier];
  return Math.max(baseMiles, Math.min(relative, additive, HARD_MAXIMUM_RADIUS_MILES));
}

// The real delivery cadence — shared by server.ts's own poll and the admin sweep endpoint's
// default (non-`force`) path, so there is exactly one place this number lives, not two that can
// drift apart. See runSweepIfDue's own comment for the full reasoning.
export const RECOMMENDATION_SWEEP_DUE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// The system author for every automatic recommendation — never a real person's identity, and
// deliberately never added as a CrewMember of anything, so it can't appear in member lists,
// vote pulses, or "who's in this Crew" anywhere in the product. Self-heals on first use, same
// pattern as ensureInventory's city seeding.
export const PLOT_SYSTEM_EMAIL = 'system+plot-recommendations@plot.internal';
// Process-lifetime cache — one upsert per process, not one per call, since this is looked up on
// every single recommendation delivery. Safe in real production use (nothing ever truncates a
// live database's users table out from under a running process), but a REAL test-isolation
// hazard found live while adding a new test to this exact file: a test file with multiple tests
// that each call resetDatabase() (truncates every table, including this cached user's own row)
// and ALSO exercise real message delivery in more than one of those tests hits a stale id — the
// row the cache still points to no longer exists, so every FK referencing it (IntentSignal,
// CrewMessage) fails, and the recommendation silently fails to deliver (caught, logged, not
// crashed) with no visible reason from the test's own assertions alone. `__resetSystemUserCacheForTests`
// exists so the test helper (resetDb.ts) can clear this alongside the tables it truncates.
let cachedSystemUserId: string | null = null;
export async function getPlotSystemUserId(): Promise<string> {
  if (cachedSystemUserId) return cachedSystemUserId;
  const user = await prisma.user.upsert({
    where: { email: PLOT_SYSTEM_EMAIL },
    update: {},
    create: { email: PLOT_SYSTEM_EMAIL, displayName: 'Plot', status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  cachedSystemUserId = user.id;
  return user.id;
}
/** Test-only: see the cache's own comment above for why this needs to exist at all. */
export function __resetSystemUserCacheForTests(): void {
  cachedSystemUserId = null;
}

export interface RecommendationSettingsDTO {
  enabled: boolean;
  maxPerWeek: number;
  travelRadiusMeters: number | null;
  // The Crew's own explicit picks — see the schema field's own comment (CrewRecommendationSettings
  // .categoryPreferences) for why this blends with, rather than replaces, member-derived taste.
  categoryPreferences: string[];
  // One level more specific — taxonomy interest ids, see .interestPreferences's own schema comment.
  interestPreferences: string[];
  // Null = the Crew's creator hasn't set the Crew's own preferences yet — see
  // .preferencesSetAt's own schema comment. This is the absolute gate checked first in
  // evaluateCrewEligibility and by services/crewPreferencesGate.ts for the manual flows.
  preferencesSetAt: Date | null;
  // 'EXPLICIT' | 'DERIVED' | null — see .preferencesSource's own schema comment. Never settable
  // directly by a client; updateSettings always writes 'EXPLICIT' (every call site is a human
  // decision), tryDeriveAndApplyCrewPreferences below is the only writer of 'DERIVED'.
  preferencesSource: string | null;
}

/** Self-heals a settings row on first read — every Crew gets sane defaults (on, 2/week,
 * radius derived from members) without a separate "set up recommendations" step.
 *
 * Real bug found operating this in production for the first time: `upsert` is NOT safe against
 * two truly concurrent callers racing to create the SAME never-before-touched crew's settings
 * row — both see "doesn't exist yet", both attempt CREATE, whichever loses the race gets a raw
 * P2002 unique-constraint error instead of the row it asked for. This isn't hypothetical: the
 * in-process sweep poll and an admin/debug read can genuinely land in the same instant on a
 * brand-new Crew. The fix is the standard "insert, and if you lost the race just re-read"
 * pattern — catch exactly P2002 on `crewId` and fall through to `findUniqueOrThrow`, which by
 * definition succeeds once ANY caller's create has landed. */
export async function getOrCreateSettings(crewId: string): Promise<RecommendationSettingsDTO> {
  let settings;
  try {
    settings = await prisma.crewRecommendationSettings.upsert({
      where: { crewId },
      update: {},
      create: { crewId },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      settings = await prisma.crewRecommendationSettings.findUniqueOrThrow({ where: { crewId } });
    } else {
      throw err;
    }
  }
  return {
    enabled: settings.enabled,
    maxPerWeek: settings.maxPerWeek,
    travelRadiusMeters: settings.travelRadiusMeters,
    categoryPreferences: settings.categoryPreferences,
    interestPreferences: settings.interestPreferences,
    preferencesSetAt: settings.preferencesSetAt,
    // A row written before preferencesSource existed but with preferencesSetAt already set could
    // only have gotten there the one way that existed back then — a person explicitly completing
    // the taste step — so it's treated as EXPLICIT, never mistaken for a safely-overwritable
    // DERIVED row by tryDeriveAndApplyCrewPreferences below.
    preferencesSource: settings.preferencesSource ?? (settings.preferencesSetAt ? 'EXPLICIT' : null),
  };
}

/**
 * Real, live product requirement: "one person must fill out the crew's specific preferences...
 * this then defines the group's preferences... no events or things should be done on crew until
 * preference set... yes you can tailor it after and change" — so `preferencesSetAt` is stamped
 * automatically, exactly once, the moment either preference array first goes from empty to
 * non-empty, and never touched again after that (a later edit that empties both arrays back out,
 * however unlikely, still doesn't un-stamp it — re-tuning is explicitly allowed to stay
 * unblocked). The moment it gets stamped is also this Crew's real "first event" moment — the
 * same guarantee that used to fire on the 1->2-member join now fires here instead, since
 * preferences (not membership) are the actual gate on Plot doing anything at all.
 */
export async function updateSettings(
  crewId: string,
  patch: Partial<RecommendationSettingsDTO>,
): Promise<RecommendationSettingsDTO> {
  const current = await getOrCreateSettings(crewId); // ensure the row exists, and read prior state for the auto-stamp below

  // Only a patch that actually names categoryPreferences/interestPreferences is a real taste
  // decision — a PATCH that only touches `enabled`/`maxPerWeek` must never flip a safely-DERIVED
  // row to EXPLICIT (or re-fire the guarantee below) as a side effect of an unrelated edit.
  const patchTouchesTaste = patch.categoryPreferences !== undefined || patch.interestPreferences !== undefined;
  const nextCategoryPreferences = patch.categoryPreferences ?? current.categoryPreferences;
  const nextInterestPreferences = patch.interestPreferences ?? current.interestPreferences;
  const hasPreferencesNow = nextCategoryPreferences.length > 0 || nextInterestPreferences.length > 0;
  // Fires whenever a human makes a real, explicit taste decision for the first time — whether
  // this Crew never had any preference at all, or only ever had a safely DERIVED guess (services/
  // crewTasteDerivation.ts). A DERIVED guess is real value, but it isn't a considered human
  // choice; the moment someone actually decides deserves the same "never come up empty" guarantee
  // an explicit first-set always got, even if it completely changes the Crew's candidate pool
  // (DERIVED rock/live-music -> EXPLICIT food/restaurants, say) — "explicit current Crew intent
  // wins quickly" is the whole point. Never re-fires once this Crew's preferences are already
  // EXPLICIT — re-tuning stays unblocked but doesn't re-trigger the guarantee, as before.
  const justSetPreferencesForFirstTime = patchTouchesTaste && current.preferencesSource !== 'EXPLICIT' && hasPreferencesNow;

  const settings = await prisma.crewRecommendationSettings.update({
    where: { crewId },
    data: {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.maxPerWeek !== undefined ? { maxPerWeek: patch.maxPerWeek } : {}),
      ...(patch.travelRadiusMeters !== undefined ? { travelRadiusMeters: patch.travelRadiusMeters } : {}),
      ...(patch.categoryPreferences !== undefined ? { categoryPreferences: patch.categoryPreferences } : {}),
      ...(patch.interestPreferences !== undefined ? { interestPreferences: patch.interestPreferences } : {}),
      ...(justSetPreferencesForFirstTime ? { preferencesSetAt: new Date() } : {}),
      // Every call site of updateSettings is a real human decision (the recommendation-settings
      // PATCH route, the AI free-text taste setup) — so any edit that actually names a taste
      // array and leaves the Crew with at least one real pick always marks it EXPLICIT,
      // overwriting a prior 'DERIVED' guess and permanently taking it out of
      // tryDeriveAndApplyCrewPreferences's reach (see that function's own comment — an explicit
      // human decision always wins and is never silently replaced again).
      ...(patchTouchesTaste && hasPreferencesNow ? { preferencesSource: 'EXPLICIT' } : {}),
    },
  });

  if (justSetPreferencesForFirstTime) {
    // guaranteeFirst: true — see generateRecommendationForCrew's own comment on what this
    // relaxes (never the candidate pool itself). Fired here, not awaited — scoring does real
    // work (provider inventory sync, distance/taste scoring) that shouldn't hold up the settings
    // response the crew creator is waiting on.
    generateRecommendationForCrew(crewId, { guaranteeFirst: true }).catch((err) => {
      logger.error({ err, crewId }, 'Guaranteed first recommendation failed right after crew preferences were first set');
    });
    void track(
      'CrewPreferencesSet',
      { crewId, source: 'EXPLICIT', categoryPreferences: settings.categoryPreferences, interestPreferences: settings.interestPreferences },
      { crewId },
    );
  }

  return {
    enabled: settings.enabled,
    maxPerWeek: settings.maxPerWeek,
    travelRadiusMeters: settings.travelRadiusMeters,
    categoryPreferences: settings.categoryPreferences,
    interestPreferences: settings.interestPreferences,
    preferencesSetAt: settings.preferencesSetAt,
    preferencesSource: settings.preferencesSource,
  };
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// Real, live product requirement, stated plainly: "if there's no ticketed events within the
// distance... in-line with the preference, then send one as local as possible (closest match)
// and preface it with 'there's not much in your area right now, so how about this' ... It needs
// to show effort to match the users requirements first, if not, preface whichever event it sends
// through." One shared string — the chat announcement (createRecommendationPlanForCrew) and the
// stored `reasonText` (below) both use it, so the honest caveat shows up wherever a member might
// see why this was sent, not just in the chat line.
export const TICKETED_FALLBACK_PREFACE = "There's not much in your area right now, so how about this";

// Real, live-reported product requirement: when Plot deliberately searches beyond a Crew's own
// radius (see computeSensibleExpansionMiles's own comment) and that's what actually found the
// pick, the delivery copy must say so — "Plot must NEVER pretend the expanded-distance result is
// local." Computed from the real distance, never a fabricated or rounded-away number.
function radiusExpansionPreface(extraMiles: number): string {
  const rounded = Math.max(1, Math.round(extraMiles));
  return `Not much matching your Crew nearby — this looked worth the extra ${rounded} mile${rounded === 1 ? '' : 's'}`;
}

/** A real, specific, multi-clause explanation — never the raw score, never a fabricated
 * "insight", every clause traceable to a reason the scorer actually produced (brief §"Why This")
 * example: not "Because your Crew likes music" (tells you nothing) but "2/3 of you are into UK
 * garage, and it's 8 miles from your area" — a claim specific enough that the honest reaction is
 * "yeah, that actually is us." Picks the single strongest, most specific signal available as the
 * lead clause (a literal free-text match beats a specific-interest match beats a bare category
 * match — more specific claims are more trustworthy), then one supporting context clause. Never
 * asserts a code that isn't actually in `option.reasons`. `isTicketedFallback` prepends the same
 * honest caveat `createRecommendationPlanForCrew`'s chat message uses — see
 * `TICKETED_FALLBACK_PREFACE`'s own comment. `radiusExpansionExtraMiles` does the same for a
 * deliberately-widened-radius pick — see `radiusExpansionPreface`'s own comment; takes priority
 * over the ticketed-fallback caveat when both apply (see this function's own caller). */
function explanationFor(option: MatchOption, opts: { isTicketedFallback?: boolean; radiusExpansionExtraMiles?: number | null } = {}): string {
  const byCode = new Map(option.reasons.map((r) => [r.code, r]));
  const categoryLabel = option.experience.category.replace(/_/g, ' ').toLowerCase();

  let primary: string | null = null;
  if (byCode.has('free_text_match')) {
    primary = byCode.get('free_text_match')!.label; // already `You said "X"` — exact and specific
  } else if (byCode.has('interest_match')) {
    primary = byCode.get('interest_match')!.label; // already `N/M of you are into <interest>`
  } else if (byCode.has('crew_interest_preference')) {
    primary = byCode.get('crew_interest_preference')!.label;
  } else if (byCode.has('crew_preference')) {
    primary = `Your Crew set ${categoryLabel} as a preference`;
  } else if (byCode.has('crew_dna_match') || byCode.has('category_affinity')) {
    primary = `Your Crew likes ${categoryLabel}`;
  } else {
    primary = `Matched to your Crew's taste`;
  }

  let secondary: string | null = null;
  if (byCode.has('nearby')) {
    secondary = `it's ${lowerFirst(byCode.get('nearby')!.label)}`;
  } else if (byCode.has('under_budget')) {
    secondary = `it's under your Crew's typical spend`;
  } else if (byCode.has('high_availability')) {
    secondary = `${byCode.get('high_availability')!.label.toLowerCase()} that night`;
  }

  const explanation = secondary ? `${primary}, and ${secondary}.` : `${primary}.`;
  if (opts.radiusExpansionExtraMiles !== null && opts.radiusExpansionExtraMiles !== undefined && opts.radiusExpansionExtraMiles > 0) {
    return `${radiusExpansionPreface(opts.radiusExpansionExtraMiles)} — ${lowerFirst(explanation)}`;
  }
  return opts.isTicketedFallback ? `${TICKETED_FALLBACK_PREFACE} — ${lowerFirst(explanation)}` : explanation;
}

interface CrewActivitySignals {
  isActive: boolean;
  reason: 'onboarding_grace_period' | 'recent_message' | 'recent_response' | 'recent_plan_activity' | 'inactive';
  lastRecommendationAt: Date | null;
  // See MIN_HOURS_AFTER_UNANIMOUS_DECLINE's own comment. True only when the Crew's most recent
  // recommendation's Plan is still in the voting loop (never for a LOCKED/BOOKED one — the Crew
  // clearly did want it) AND every currently active member has voted, and 100% of those votes
  // are OUT — not merely "more OUT than IN", and not true while any active member has yet to
  // respond (silence isn't rejection; the normal 36h floor already covers that case correctly).
  lastRecommendationUnanimouslyDeclined: boolean;
}

/** "Do not blindly send three recommendations every week to abandoned Crews" — a real, documented
 *  definition of an active Crew (see ACTIVE_CREW_WINDOW_DAYS's own comment for the window and
 *  reasoning): recent chat, a recent response to a past recommendation, recent Plan activity, or
 *  still within a brand-new Crew's own onboarding grace period. Any ONE of these is enough — this
 *  is "still a going concern", not "highly engaged". Also returns `lastRecommendationAt` (used
 *  for the cadence-spacing check right after this function's own caller) since both checks need
 *  the same real activity window and there's no reason to query it twice. */
async function getCrewActivitySignals(crewId: string): Promise<CrewActivitySignals> {
  const since = new Date(Date.now() - ACTIVE_CREW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [crew, recentMessage, recentResponse, recentPlanActivity, lastRecommendation, activeMemberCount] = await Promise.all([
    prisma.crew.findUnique({ where: { id: crewId }, select: { createdAt: true } }),
    prisma.crewMessage.findFirst({ where: { crewId, createdAt: { gte: since } }, select: { id: true } }),
    prisma.recommendationResponse.findFirst({ where: { crewRecommendation: { crewId }, createdAt: { gte: since } }, select: { id: true } }),
    prisma.plan.findFirst({ where: { crewId, updatedAt: { gte: since } }, select: { id: true } }),
    prisma.crewRecommendation.findFirst({
      where: { crewId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, plan: { select: { status: true, votes: { select: { vote: true } } } } },
    }),
    prisma.crewMember.count({ where: { crewId, status: 'ACTIVE' } }),
  ]);
  const lastRecommendationAt = lastRecommendation?.createdAt ?? null;
  const votingPlan = lastRecommendation?.plan;
  const lastRecommendationUnanimouslyDeclined = Boolean(
    votingPlan &&
      !['LOCKED', 'BOOKED', 'COMPLETED', 'CANCELLED'].includes(votingPlan.status) &&
      activeMemberCount > 0 &&
      votingPlan.votes.length === activeMemberCount &&
      votingPlan.votes.every((v) => v.vote === 'OUT'),
  );
  if (crew && crew.createdAt >= since) return { isActive: true, reason: 'onboarding_grace_period', lastRecommendationAt, lastRecommendationUnanimouslyDeclined };
  if (recentMessage) return { isActive: true, reason: 'recent_message', lastRecommendationAt, lastRecommendationUnanimouslyDeclined };
  if (recentResponse) return { isActive: true, reason: 'recent_response', lastRecommendationAt, lastRecommendationUnanimouslyDeclined };
  if (recentPlanActivity) return { isActive: true, reason: 'recent_plan_activity', lastRecommendationAt, lastRecommendationUnanimouslyDeclined };
  return { isActive: false, reason: 'inactive', lastRecommendationAt, lastRecommendationUnanimouslyDeclined };
}

/** Diversity/fatigue (see CATEGORY_FATIGUE_WINDOW/PENALTY's own comment) — a real, bounded,
 *  score-space penalty for repeating one of the last few sent categories, never a hard exclusion
 *  and never randomised. Returns a NEW array (never mutates `pool`) with adjusted `matchScore`s,
 *  re-sorted — callers that need score-ordering (pickBest, the debugger's own top-10) both
 *  already re-sort their own input, so this doesn't need to guarantee order beyond "adjusted". */
async function applyCategoryFatigue(crewId: string, pool: MatchOption[]): Promise<MatchOption[]> {
  if (pool.length === 0) return pool;
  const recent = await prisma.crewRecommendation.findMany({
    where: { crewId },
    orderBy: { createdAt: 'desc' },
    take: CATEGORY_FATIGUE_WINDOW,
    select: { experience: { select: { category: true } } },
  });
  const recentCategories = recent.map((r) => r.experience.category);
  if (recentCategories.length === 0) return pool;
  return pool.map((o) => {
    const idx = recentCategories.indexOf(o.experience.category);
    if (idx === -1) return o;
    const penalty = CATEGORY_FATIGUE_PENALTY[idx] ?? 0;
    if (penalty === 0) return o;
    return { ...o, matchScore: Math.max(0, o.matchScore - penalty) };
  });
}

/** Controlled exploration — see MAX_EXPLORATORY_SENDS_PER_WEEK's own comment for the "very
 *  little, never at the cost of a real match" framing. Only ever called when `eligible` (the
 *  normal HIGH/MEDIUM pool) is EMPTY — this can never displace a real match, only fill a genuine
 *  gap that would otherwise be silence. A candidate qualifies only with real, checkable evidence
 *  it's worth the risk: ticketed (a real ticket, not a permanent place listing — see
 *  opportunityIntent.ts), positively within radius (never a distance-stretched "worth the trip"
 *  candidate), and scoring in the real exploratory band (EXPLORATION_MIN_SCORE..
 *  MIN_RECOMMENDATION_SCORE — still has at least one real taste signal, from `withTaste`'s own
 *  filter, just not enough of one to clear the normal bar). Rate-limited by counting this Crew's
 *  own EXPLORATORY-confidence sends in the last 7 days. */
async function selectExploratoryCandidate(crewId: string, withTaste: MatchOption[]): Promise<MatchOption | null> {
  const candidates = withTaste.filter(
    (o) => o.matchScore >= EXPLORATION_MIN_SCORE && o.matchScore < MIN_RECOMMENDATION_SCORE && o.withinRadius === true && isTicketedEvent(o.experience),
  );
  if (candidates.length === 0) return null;
  const recentExploratoryCount = await prisma.crewRecommendation.count({
    where: { crewId, confidence: 'EXPLORATORY', createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
  });
  if (recentExploratoryCount >= MAX_EXPLORATORY_SENDS_PER_WEEK) return null;
  return [...candidates].sort((a, b) => b.matchScore - a.matchScore)[0];
}

async function resolveCrewCityForSweep(crewId: string): Promise<string> {
  const crew = await prisma.crew.findUnique({
    where: { id: crewId },
    select: {
      defaultCity: true,
      members: { where: { status: 'ACTIVE' }, take: 1, select: { user: { select: { profile: { select: { homeCity: true } } } } } },
    },
  });
  return crew?.defaultCity ?? crew?.members[0]?.user.profile?.homeCity ?? UK_FALLBACK_CENTER.name;
}

/**
 * The full eligibility computation, extracted as its own read-only step — never persists
 * anything, safe to call as often as you like. Real gap this closes: before this existed, the
 * only way to answer "why hasn't my Crew gotten a recommendation in two days" was to grep
 * server logs for `crew_recommendation_evaluated` and hope you had access to them. Now the
 * exact same reasoning `generateRecommendationForCrew` uses is directly queryable — see
 * `GET /admin/crews/:id/explain-recommendation`.
 */
export interface CrewEligibilityResult {
  outcome: RecommendationOutcome | 'eligible';
  details: Record<string, unknown>;
  best?: MatchOption;
  // True when `best` is NOT a real ticketed event and a real ticketed one genuinely wasn't
  // available among this Crew's own eligible candidates — never true just because a ticketed
  // one scored slightly lower. See generateRecommendationForCrew's own use of this: the honest
  // "there's not much in your area right now" preface only appears when this is true, never
  // fabricated, never omitted when it should show. See this file's own `pickBest` comment.
  usedTicketedFallback?: boolean;
  // True only for a genuine controlled-exploration send (see selectExploratoryCandidate's own
  // comment) — tells generateRecommendationForCrew to label this EXPLORATORY rather than let
  // deriveConfidence infer a level from score alone (an exploratory pick's score is, by
  // definition, below the normal MEDIUM floor — inferring from score would just read as LOW,
  // not the deliberate, evidence-backed exploration this actually is).
  forceExploratoryConfidence?: boolean;
  // True only when `best` was found by deliberately searching wider than this Crew's own radius
  // (see computeSensibleExpansionMiles's own comment) — never true just because `best` happens to
  // sit near the edge of the Crew's normal radius. Tells generateRecommendationForCrewNow to
  // honestly acknowledge the extra distance in the delivery copy, never present an expanded-
  // radius pick as if it were local.
  usedRadiusExpansion?: boolean;
  // The Crew's own real base radius in miles (before expansion) — the reference point the
  // delivery copy's "worth the extra N miles" framing is computed against.
  radiusExpansionBaseMiles?: number;
}

/** THE TIERING RULE this whole rebuild exists to enforce: "I need ticketed only events... don't
 *  think we need to focus on unpaid, no ticket events" — a real ticket first, always, and a
 *  non-ticketed fallback only when genuinely nothing ticketed clears the Crew's own eligibility
 *  bar. Never a hard exclusion (the product spec explicitly wants an honest fallback, not
 *  silence) — this picks the highest-scoring TICKETED candidate from `pool` when one exists,
 *  and only falls back to the highest-scoring candidate overall (ticketed or not) when it
 *  doesn't, flagging that fallback so the caller can preface the message honestly. Sorts its own
 *  copy of `pool` — never assumes the caller already sorted it. */
/** The actual "opportunity significance should matter" gate (see EXPANSION_ADDITIVE_MILES's own
 *  comment) — real, checkable evidence only, never inferred from distance or category label.
 *  Any ONE of: a VERY_HIGH plan-worthiness occasion (FESTIVAL — see opportunityIntent.ts's own
 *  CATEGORY_BASELINE), a real ticket, or CONFIRMED (subcategory-sourced, never the loose text-
 *  scan `experienceInterestTags` also does — see match.ts#contradictsCrewInterestPreference's own
 *  comment on why that distinction matters) evidence of one of the Crew's own specific interest
 *  picks — "relevance", not just "this happens to be popular". A candidate with none of these is
 *  an ordinary match that merely sits within the STANDARD sensible-expansion band; asking it to
 *  also justify the wider SIGNIFICANT band is exactly the "not a dumb multiplier" requirement. */
function isSignificantOpportunity(option: MatchOption, crewInterestPreferences: Set<string>): boolean {
  if (derivePlanWorthiness(option.experience).level === 'VERY_HIGH') return true;
  if (isTicketedEvent(option.experience)) return true;
  if (crewInterestPreferences.size > 0) {
    const strongTags = experienceInterestTagsFromSubcategories(option.experience);
    if (strongTags.some((tag) => crewInterestPreferences.has(tag))) return true;
  }
  return false;
}

// `usedTicketedFallback` is kept (always `false` now) purely so downstream callers/tests don't
// need a second return shape — every candidate reaching this function already passed
// `isProactivelyEligible` (see computePoolsAtRadius's own comment), which requires a real ticket.
// There is no non-ticketed candidate left to ever fall back to; this is no longer a preference
// with an escape hatch, it's a closed pool. `pool` is still sorted defensively (never assume the
// caller already did) rather than trusting every call site to pre-sort.
function pickBest(pool: MatchOption[]): { best: MatchOption | undefined; usedTicketedFallback: boolean } {
  const sorted = [...pool].sort((a, b) => b.matchScore - a.matchScore);
  return { best: sorted[0], usedTicketedFallback: false };
}
async function evaluateCrewEligibility(crewId: string, opts: { guaranteeFirst?: boolean } = {}): Promise<CrewEligibilityResult> {
  const settings = await getOrCreateSettings(crewId);
  if (!settings.enabled) {
    return { outcome: 'disabled', details: {} };
  }
  if (!settings.preferencesSetAt) {
    // The absolute gate — see .preferencesSetAt's own schema comment and updateSettings's. Checked
    // before the weekly cap and member count deliberately: "no events or things should be done on
    // crew until preference set" is unconditional, not just a floor on top of the other checks.
    return { outcome: 'preferences_not_set', details: {} };
  }

  // A SECOND absolute gate, same status as preferences: "Crew location + travel radius are
  // known" before Plot does anything automatic — this is the product model, not an optional
  // nicety. Diagnostic-only fetch, mirrors what scoreExperiencesForCrew computes internally for
  // the actual radius calculation (services/match.ts) — real gap found investigating "afterRadius:
  // 0 for every candidate, on every multi-member Crew" in production: this is the one piece of
  // context that number alone can't show (a member's real home city vs. coordinates), so it's
  // surfaced directly rather than requiring a second round of guessing.
  const [crewLocation, memberLocations] = await Promise.all([
    prisma.crew.findUnique({ where: { id: crewId }, select: { latitude: true, longitude: true } }),
    prisma.crewMember.findMany({
      where: { crewId, status: 'ACTIVE' },
      select: { user: { select: { email: true, profile: { select: { homeCity: true, homeLat: true, homeLng: true } } } } },
    }),
  ]);
  const locationSummary = memberLocations.map((m) => ({
    email: m.user.email,
    homeCity: m.user.profile?.homeCity ?? null,
    hasCoordinates: m.user.profile?.homeLat !== null && m.user.profile?.homeLat !== undefined,
  }));
  const crewHasExplicitLocation = crewLocation !== null && crewLocation.latitude !== null && crewLocation.longitude !== null;
  const anyMemberHasHomeLocation = locationSummary.some((m) => m.hasCoordinates);
  // REAL, LIVE-REPORTED BUG this closes ("Crew: STAFFORD, 25-mile radius... Plot sent CAFFÈ NERO
  // IN LONDON"): when NO location signal existed at all (this Crew's own explicit location not
  // yet set at the moment scoring ran, AND no member had a home location either),
  // services/match.ts#scoreExperiencesForCrew could compute `withinRadius: null` for every
  // single candidate — genuinely unknown, not "near" — and the OLD filter here
  // (`!== false`) treated that null exactly like "in radius", so the entire candidate pool
  // (quality-ordered, with zero geographic relevance at all) was eligible. Rather than patch the
  // symptom, this refuses to even attempt an automatic recommendation until a real location
  // anchor exists — "no ranking weight capable of overcoming" an unknown location is enforced by
  // never scoring against one in the first place. See match.ts's own `withinRadius` comment for
  // the second half of this fix (Crew's own explicit location becomes the SOLE anchor, never
  // blended with a member's personal home, once it's set).
  if (!crewHasExplicitLocation && !anyMemberHasHomeLocation) {
    return { outcome: 'location_not_set', details: { memberLocations: locationSummary, crewHasExplicitLocation } };
  }

  // "Do not blindly send three recommendations every week to abandoned Crews" — see
  // ACTIVE_CREW_WINDOW_DAYS's own comment for the exact signals and the grace-period reasoning.
  const activity = await getCrewActivitySignals(crewId);
  if (!activity.isActive) {
    return { outcome: 'crew_inactive', details: { ...activity } };
  }
  // Real cadence spacing — see MIN_HOURS_BETWEEN_RECOMMENDATIONS's own comment. Naturally a
  // no-op for a Crew's true first recommendation (nothing to space against yet), so this never
  // blocks `guaranteeFirst`'s own "never come up empty on day one" guarantee. The shorter
  // MIN_HOURS_AFTER_UNANIMOUS_DECLINE floor applies instead when every active member has already
  // voted OUT on the current recommendation — see that constant's own comment and
  // `lastRecommendationUnanimouslyDeclined`'s.
  if (activity.lastRecommendationAt) {
    const minHoursBetween = activity.lastRecommendationUnanimouslyDeclined ? MIN_HOURS_AFTER_UNANIMOUS_DECLINE : MIN_HOURS_BETWEEN_RECOMMENDATIONS;
    const hoursSinceLast = (Date.now() - activity.lastRecommendationAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLast < minHoursBetween) {
      return { outcome: 'too_soon', details: { lastRecommendationAt: activity.lastRecommendationAt, hoursSinceLast: Math.round(hoursSinceLast * 10) / 10, minHoursBetween, unanimousDeclineOverride: activity.lastRecommendationUnanimouslyDeclined } };
    }
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS_FOR_WEEKLY_CAP * 24 * 60 * 60 * 1000);
  const [recentCount, memberCount] = await Promise.all([
    prisma.crewRecommendation.count({ where: { crewId, createdAt: { gte: since } } }),
    prisma.crewMember.count({ where: { crewId, status: 'ACTIVE' } }),
  ]);
  if (recentCount >= settings.maxPerWeek) {
    return { outcome: 'weekly_cap_reached', details: { recentCount, maxPerWeek: settings.maxPerWeek } };
  }
  if (memberCount < 2) {
    // a solo "Crew" has no one to recommend anything to yet
    return { outcome: 'too_few_members', details: { memberCount } };
  }

  const city = await resolveCrewCityForSweep(crewId);
  await ensureInventory(city);

  // Never repeat: anything ever recommended to this Crew before (any status — a dismissal is
  // still a "don't show again", not a "try harder next time"), and anything a member has
  // already shared/found themselves — recommending something the Crew is already looking at
  // would read as Plot not paying attention. Shared with the manual "Find us something" flow —
  // see getCrewExcludedExperienceIds's own comment (match.ts).
  const excluded = await getCrewExcludedExperienceIds(crewId);

  // A real taste signal is required, not just "it's close, cheap and everyone's free" — those
  // three alone can clear MIN_RECOMMENDATION_SCORE for literally any category (a real gap
  // this pass found via testing: a Crew with zero comedy affinity still scored a comedy-blind
  // sport event 57/100 on budget+distance+availability alone). A member actively browsing
  // "Find us something" can reasonably be shown that; Plot pushing it unprompted, captioned
  // "Because your Crew likes X", cannot — the explanation would be a lie. See docs/DECISIONS.md
  // #crew-auto-recommendations.
  // Real, specific-interest signals (interest_match, free_text_match, crew_interest_preference)
  // count here too, alongside the original category-level ones — the personalisation-engine
  // pass's whole point is that these are, if anything, MORE trustworthy grounds to proactively
  // recommend than a bare category match, not less.
  const hasTasteSignal = (o: MatchOption) =>
    o.reasons.some((r) =>
      ['category_affinity', 'crew_dna_match', 'crew_preference', 'interest_match', 'free_text_match', 'crew_interest_preference'].includes(r.code),
    );

  // Radius-expansion tiering (see computeSensibleExpansionMiles's own comment) — the scoring +
  // fatigue + exclusion + radius/taste-signal pipeline, parametrised on the radius override so it
  // can be re-run at progressively wider radii without duplicating the pipeline itself. THE CORE
  // FIX for "Caffè Nero in London sent to a 25-mile Stafford Crew" lives inside here unchanged:
  // `withinRadius` is `boolean | null` — `null` means genuinely unknown (no venue coordinates, or
  // no location anchor could be established), never "near"; a candidate must be POSITIVELY
  // CONFIRMED within THIS tier's radius to count, fail closed, never fail open.
  // ABSOLUTE PILOT ELIGIBILITY INVARIANT (live product directive, verbatim: "PROACTIVE PLOT FOUND
  // THIS MUST BE TICKETED... NO TICKET = NO PROACTIVE RECOMMENDATION... FILTER THEM OUT BEFORE
  // RANKING... do not allow any fallback mechanism to resurrect them"). Real, live-reported
  // failure this closes: "Copper Kettle" — an ordinary, unticketed restaurant whose only action
  // path was a Google Maps link — was proactively sent to a Crew. Root cause: `pickBest` (below)
  // treated a real ticket as a PREFERENCE with a fallback to the best-scoring candidate overall
  // when nothing ticketed cleared the bar — exactly the "ambiguity" this directive explicitly asks
  // to remove for the pilot. Applied HERE, at the single point every downstream pool (`inRadius`/
  // `withTaste`/`eligible`) and every caller of `computePoolsAtRadius` (tier0, the widened-radius
  // search, `guaranteeFirst`'s own relaxed fallback, `selectExploratoryCandidate`) derives from —
  // never a second, separately-maintained copy of this rule that could drift. An unticketed
  // candidate simply never enters any pool past this line; `pickBest` below no longer has an
  // unticketed candidate to fall back to even in principle. `pools.scored` (used only by
  // `buildDetails`'s debug trail below) stays the full, unfiltered list so a real candidate like
  // Copper Kettle is still visible in the explain trail with an honest `UNTICKETED` rejection
  // reason — filtered out, never silently vanished.
  //
  // SAME LINE also excludes a `genre_contradiction`-flagged candidate outright (see match.ts
  // #contradictsCrewInterestPreference and #lacksRequiredNarrowingEvidence) — the second urgent
  // fix from the same live test round: score-capping alone (the previous design) still left a
  // contradicting/too-broad candidate reachable through `guaranteeFirst`'s own relaxed `inRadius`
  // fallback (used when nothing in radius has ANY taste signal at all — a contradicting candidate
  // fails `hasTasteSignal` too, so it was never excluded from `inRadius` itself, only outscored
  // within `eligible`/`withTaste`, which that relaxed fallback deliberately bypasses). Hard-
  // excluding it here, at the same single point as the ticket gate, closes that bypass structurally
  // rather than patching each caller individually.
  function isProactivelyEligible(o: MatchOption): boolean {
    return isTicketedEvent(o.experience) && !o.reasons.some((r) => r.code === 'genre_contradiction');
  }

  async function computePoolsAtRadius(radiusMetersOverride: number | null) {
    const scoredBeforeFatigue = await scoreExperiencesForCrew(crewId, { radiusMetersOverride });
    // Diversity/fatigue penalty (see CATEGORY_FATIGUE_WINDOW/PENALTY's own comment) — applied
    // here, to the automatic engine's own pool specifically, never inside match.ts's shared
    // scorer (a member manually asking "Find us something" wants the single best match, not a
    // diversity-optimised one). Re-sorted so every downstream consumer (debugger, tiering) sees
    // the fatigue-adjusted order, not the pre-penalty one.
    const scored = (await applyCategoryFatigue(crewId, scoredBeforeFatigue)).sort((a, b) => b.matchScore - a.matchScore);
    const notExcluded = scored.filter((o) => !excluded.has(o.experience.id));
    const proactiveEligiblePool = notExcluded.filter(isProactivelyEligible);
    const inRadius = proactiveEligiblePool.filter((o) => o.withinRadius === true);
    const withTaste = inRadius.filter(hasTasteSignal);
    const eligible = withTaste.filter((o) => o.matchScore >= MIN_RECOMMENDATION_SCORE);
    return { scored, notExcluded, inRadius, withTaste, eligible };
  }

  // The recommendation debugger (product spec: "for each candidate show TITLE/DISTANCE/PLAN-
  // WORTHINESS/BOOKABILITY/ELIGIBILITY/REJECTION REASON/FINAL RANKING SCORE") — real evidence
  // for "why did #1 beat #2", not just whether #1 passed. Bounded to the top 10 BY SCORE across
  // the whole (pre-radius-gate) scored pool, so a rejected-for-distance candidate like Caffè Nero
  // still shows up in this trail with its real rejection reason, exactly the debugging case the
  // spec calls for — never silently absent from the trail just because it was excluded from
  // consideration. See routes/admin.ts's explain-recommendation endpoint, the only consumer.
  function buildDetails(
    pools: Awaited<ReturnType<typeof computePoolsAtRadius>>,
    radiusMetersUsed: number | null,
    // Set only when `pools` was scored against the widened (beyond-preferred-radius) tier — lets
    // the debug trail name the SPECIFIC reason a real, in-radius-at-this-tier candidate still
    // isn't eligible: it's further than the Crew's own sensible-expansion band and never earned
    // the wider allowance (see `isSignificantOpportunity`'s own comment). Omitted for tier0 (the
    // Crew's own preferred radius — this gate never applies there at all).
    significanceContext?: { standardMiles: number; crewInterestPreferences: Set<string> },
  ) {
    const debugCandidates = [...pools.scored]
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 10)
      .map((o) => {
        const worthiness = derivePlanWorthiness(o.experience);
        const rejectionReasons: string[] = [];
        if (excluded.has(o.experience.id)) rejectionReasons.push('ALREADY_RECOMMENDED_OR_SHARED');
        // Absolute pilot invariant (see isProactivelyEligible's own comment) — checked here too,
        // independent of whichever derived pool actually excluded this candidate, so the debug
        // trail always names the real reason a genuine ticketed alternative should be preferred,
        // never just a generic "no taste signal"/"below threshold" catch-all.
        if (!isTicketedEvent(o.experience)) rejectionReasons.push('UNTICKETED');
        if (o.withinRadius !== true) rejectionReasons.push(o.withinRadius === false ? 'OUTSIDE_CREW_RADIUS' : 'DISTANCE_UNKNOWN');
        if (
          significanceContext &&
          o.withinRadius === true &&
          o.distanceMiles !== null &&
          o.distanceMiles > significanceContext.standardMiles &&
          !isSignificantOpportunity(o, significanceContext.crewInterestPreferences)
        ) {
          rejectionReasons.push('BEYOND_SENSIBLE_EXPANSION_WITHOUT_SIGNIFICANCE');
        }
        // See match.ts#contradictsCrewInterestPreference's own comment — the P0 fix for "Live
        // gigs + Rock recommended K-pop". Checked before the generic NO_TASTE_SIGNAL below so the
        // debug trail names the SPECIFIC reason (confirmed evidence of a different, non-matching
        // genre/cuisine/discipline within the same territory the Crew picked), not just "no
        // signal at all".
        if (o.reasons.some((r) => r.code === 'genre_contradiction')) rejectionReasons.push('GENRE_MISMATCH');
        if (!hasTasteSignal(o)) rejectionReasons.push('NO_TASTE_SIGNAL');
        if (o.matchScore < MIN_RECOMMENDATION_SCORE) rejectionReasons.push('BELOW_CONFIDENCE_THRESHOLD');
        return {
          experienceId: o.experience.id,
          title: o.experience.name,
          category: o.experience.category,
          distanceMiles: o.distanceMiles !== null ? Math.round(o.distanceMiles * 10) / 10 : null,
          startsAt: o.experience.startsAt.toISOString(),
          priceMinMinor: o.experience.priceMinMinor,
          sourceKind: deriveSourceKind(o.experience),
          planWorthiness: worthiness.level,
          planWorthinessReasons: worthiness.reasons,
          bookingType: deriveBookingType(o.experience),
          matchScore: o.matchScore,
          reasons: o.reasons,
          eligible: rejectionReasons.length === 0,
          rejectionReasons,
        };
      });
    return {
      city,
      memberLocations: locationSummary,
      travelRadiusMetersOverride: radiusMetersUsed, // null = falls back to taste-profile median or a default, see match.ts
      totalScored: pools.scored.length,
      afterDedup: pools.notExcluded.length,
      afterRadius: pools.inRadius.length,
      afterTasteSignal: pools.withTaste.length,
      bestScoreSeen: pools.withTaste.length > 0 ? Math.max(...pools.withTaste.map((o) => o.matchScore)) : null,
      scoreThreshold: MIN_RECOMMENDATION_SCORE,
      topCandidates: debugCandidates,
    };
  }

  const tier0 = await computePoolsAtRadius(settings.travelRadiusMeters);
  const details = buildDetails(tier0, settings.travelRadiusMeters);
  const { eligible } = tier0;

  // RADIUS EXPANSION — real, live-reported failure this closes: "Plot sent an ordinary Stafford
  // restaurant instead of a genuinely strong food festival that might exist a bit further out."
  // Location was acting as a hard rescue-or-reject filter with zero attempt to look wider, EVEN
  // when what qualified locally was only a weak, marginal match. "QUALITY MUST BEAT PROXIMITY" —
  // this is a genuine HEAD-TO-HEAD, not just a last-resort fallback for when local comes up
  // completely empty: the widest SENSIBLE search (see `computeSensibleExpansionMiles`'s own
  // comment — never a bare `Nx` multiplier once the Crew's own preferred radius gets large) is
  // always tried too, and whichever candidate actually scores higher wins, wherever it is. Every
  // tier re-runs the EXACT same quality/taste-signal bar (MIN_RECOMMENDATION_SCORE,
  // hasTasteSignal, plan-worthiness, chain exclusion — nothing here is ever relaxed to make a
  // tier "succeed"), only the geographic net widens — and even that widened net only admits a
  // candidate beyond the STANDARD band when it earns the wider SIGNIFICANT one (see
  // `isSignificantOpportunity`).
  //
  // Computed BEFORE the guaranteeFirst branch below (not after) — real gap this closes: a Crew's
  // very first-ever recommendation is exactly the moment being wrong matters most, and it used to
  // bypass this entirely, sourcing only from the unexpanded tier-0 pool. A brand-new Crew's first
  // impression deserves the same "quality beats proximity" guarantee as every later sweep.
  const baseRadiusMeters = settings.travelRadiusMeters ?? DEFAULT_RADIUS_METERS;
  const baseRadiusMiles = Math.round((baseRadiusMeters / 1609.34) * 10) / 10;
  const crewInterestPreferences = new Set(settings.interestPreferences);
  const standardMiles = computeSensibleExpansionMiles(baseRadiusMiles, 'standard');
  const significantMiles = computeSensibleExpansionMiles(baseRadiusMiles, 'significant');
  const widestRadiusMeters = Math.round(significantMiles * 1609.34);
  const widePoolsRaw = await computePoolsAtRadius(widestRadiusMeters);
  // The actual "opportunity significance should matter" gate, applied once here rather than
  // scattered across every consumer below: a candidate within the STANDARD band needs nothing
  // extra (an ordinary sensible stretch); beyond it, only a genuinely significant one survives.
  // `inRadius` is rebuilt first (the source of truth), `withTaste`/`eligible` re-derived from it
  // so the subset invariant `eligible ⊆ withTaste ⊆ inRadius` computePoolsAtRadius relies on
  // elsewhere stays true here too.
  const gatedInRadius = widePoolsRaw.inRadius.filter(
    (o) => o.distanceMiles === null || o.distanceMiles <= standardMiles || isSignificantOpportunity(o, crewInterestPreferences),
  );
  const gatedWithTaste = gatedInRadius.filter(hasTasteSignal);
  const gatedEligible = gatedWithTaste.filter((o) => o.matchScore >= MIN_RECOMMENDATION_SCORE);
  const widePools = { ...widePoolsRaw, inRadius: gatedInRadius, withTaste: gatedWithTaste, eligible: gatedEligible };

  let winnerPools = tier0;
  let winnerRadiusMeters: number | null = settings.travelRadiusMeters;
  let usedRadiusExpansion = false;

  const tier0Best = eligible.length > 0 ? pickBest(eligible).best : undefined;
  const wideBest = widePools.eligible.length > 0 ? pickBest(widePools.eligible).best : undefined;
  // Strictly greater, never a tie-break toward distance — a wider search only wins when it is
  // ACTUALLY better, per this same trusted scoring function everything else here already relies
  // on (taste match, ticketed-ness, plan-worthiness, and yes distance too, all baked in already
  // — this is not a second, competing notion of quality, just the same one applied wider).
  if (wideBest && (!tier0Best || wideBest.matchScore > tier0Best.matchScore)) {
    winnerPools = widePools;
    winnerRadiusMeters = widestRadiusMeters;
    usedRadiusExpansion = wideBest.distanceMiles !== null && wideBest.distanceMiles > baseRadiusMiles;
  }
  // Nothing else to try beyond this — `widePools` already IS the widest sensible search
  // (`computeSensibleExpansionMiles`'s own significant tier), gated by real evidence. There is no
  // "try 2x, then 3x" ladder left to walk: a candidate that didn't clear the gate at the
  // significant tier was never going to clear it at a narrower one either, and one that did was
  // already scored and considered above. If nothing here is eligible, nothing genuinely qualifies
  // — see this function's own `no_eligible_candidate` return below ("SEND NOTHING" is the correct,
  // honest outcome, never a manufactured one).

  const { withTaste } = winnerPools;

  if (opts.guaranteeFirst && winnerPools.eligible.length === 0 && (tier0.inRadius.length > 0 || widePools.inRadius.length > 0)) {
    // Real, live product requirement: a brand-new Crew's very first moment must not come up
    // empty — "it should immediately hit them with at LEAST 1 event line with the preferences"
    // — even when nothing yet clears the periodic sweep's deliberately conservative confidence
    // bar (a fresh Crew's members often haven't swiped enough for real affinity/DNA signal).
    // The candidate pool itself is never relaxed — still real, in-radius, quality-checked, not
    // already shown/recommended — only the confidence bar is skipped for this one moment.
    //
    // REAL, LIVE-REPORTED BUG this fixes ("I did not select comedy as a preference, AT ALL...
    // this is not tailored... you have ONE shot to make a good impression"): this used to sort
    // from `inRadius` — EVERY in-radius candidate, not `withTaste` — meaning the doc comment
    // above ("taste signal, if any, still sorts first") was aspirational, not what the code
    // actually did. A comedy event with ZERO taste signal (no crew_preference, no affinity, no
    // DNA match — nothing the Crew ever indicated wanting) can easily out-score a real
    // taste-matched candidate on budget+distance+freshness alone (exactly the same "close, cheap
    // and everyone's free beats real taste" gap the withTaste/eligible filters above exist to
    // close for the periodic sweep) — and this guarantee path was bypassing that protection
    // completely for precisely the ONE recommendation where being wrong matters most: the
    // Crew's first-ever impression of Plot. Sourcing from `withTaste` instead means a taste-
    // matched candidate — even one that doesn't clear the normal confidence threshold — always
    // wins over a taste-blind one. Only when NOTHING in radius has any taste signal at all (the
    // Crew's stated preferences genuinely have zero matching inventory right now) does this fall
    // back to `inRadius`, an honest last resort rather than the default behaviour.
    //
    // SECOND real, live-reported bug this same guarantee later still let through ("I set the
    // Crew's preferences to ONLY food... the first event Plot sent was comedy"): even with the
    // fix above, `inRadius`/`withTaste`/`scored` themselves used to still contain EVERY category
    // — a Crew's own explicit categoryPreferences/interestPreferences only ever added bonus
    // score, never excluded anything, so a member's own unrelated personal comedy affinity could
    // clear `hasTasteSignal` on its own for a category the Crew never asked for. Fixed at the
    // source (services/match.ts#scoreExperiencesForCrew now hard-filters the candidate pool to
    // the Crew's own explicit preference before any of the pools below are even built) — every
    // pool this function sees is already correctly scoped, so `inRadius` is now a safe last
    // resort here too, not a second place the same bug could sneak back in.
    //
    // THIRD real, live-reported bug this closes: everything above (`winnerPools`/`inRadius`/
    // `withTaste`) is the result of the head-to-head at the `eligible` (score >= 55) threshold —
    // when NEITHER tier0 nor the widened search has anything scoring that high (exactly the
    // situation a brand-new Crew is in most often — nobody's swiped enough yet for a big score),
    // that head-to-head never runs at all, and this guarantee fell all the way back to tier0's
    // own local pool only, even when a genuinely stronger, more specific match existed a
    // reasonable stretch further out ("Alt Rock Showcase 20 miles away" losing to "Generic Live
    // Music Night 5 miles away" on a brand-new Crew's very first recommendation — the exact
    // "quality beats proximity" case this whole mechanism exists for, just below the normal
    // confidence floor instead of above it). Fixed by running the SAME head-to-head one level
    // down: compare tier0's own best taste-matched candidate against the widened search's best
    // taste-matched candidate (never `eligible`-gated here — neither pool would have one), and
    // let the genuinely higher-scoring one win, wherever it is — identical principle to the
    // `eligible`-level head-to-head above, just applied to the guarantee's own relaxed pool.
    const tier0TasteMatchedPool = tier0.withTaste.length > 0 ? tier0.withTaste : tier0.inRadius;
    const wideTasteMatchedPool = widePools.withTaste.length > 0 ? widePools.withTaste : widePools.inRadius;
    const tier0GuaranteedBest = tier0TasteMatchedPool.length > 0 ? pickBest(tier0TasteMatchedPool).best : undefined;
    const wideGuaranteedBest = wideTasteMatchedPool.length > 0 ? pickBest(wideTasteMatchedPool).best : undefined;

    let guaranteedPools = tier0;
    let guaranteedRadiusMeters: number | null = settings.travelRadiusMeters;
    let guaranteedUsedExpansion = false;
    if (wideGuaranteedBest && (!tier0GuaranteedBest || wideGuaranteedBest.matchScore > tier0GuaranteedBest.matchScore)) {
      guaranteedPools = widePools;
      guaranteedRadiusMeters = widestRadiusMeters;
      guaranteedUsedExpansion = wideGuaranteedBest.distanceMiles !== null && wideGuaranteedBest.distanceMiles > baseRadiusMiles;
    }

    const guaranteedInRadius = guaranteedPools.inRadius;
    const guaranteedWithTaste = guaranteedPools.withTaste;
    const tasteMatchedPool = guaranteedWithTaste.length > 0 ? guaranteedWithTaste : guaranteedInRadius;
    const { best: bestAvailable, usedTicketedFallback } = pickBest(tasteMatchedPool);
    const guaranteedFirstExpansionMiles = Boolean(
      guaranteedUsedExpansion && bestAvailable?.distanceMiles !== null && bestAvailable !== undefined && bestAvailable.distanceMiles! > baseRadiusMiles,
    );
    return {
      outcome: 'eligible',
      details: {
        ...(guaranteedUsedExpansion ? buildDetails(guaranteedPools, guaranteedRadiusMeters, { standardMiles, crewInterestPreferences }) : details),
        guaranteedFirst: true,
        guaranteedFirstHadTasteSignal: guaranteedWithTaste.length > 0,
      },
      best: bestAvailable,
      usedTicketedFallback,
      usedRadiusExpansion: guaranteedFirstExpansionMiles,
      radiusExpansionBaseMiles: guaranteedFirstExpansionMiles ? baseRadiusMiles : undefined,
    };
  }

  if (winnerPools.eligible.length === 0) {
    // Controlled exploration (see selectExploratoryCandidate's own comment) — tried only once
    // the normal HIGH/MEDIUM pool has genuinely come up empty EVEN AFTER radius expansion, so
    // this can never displace a real match, only fill a gap that would otherwise be silence.
    // Deliberately still sourced from the ORIGINAL, unexpanded `withTaste` — see that function's
    // own comment on why an exploratory pick must stay close to home, never a distance-stretched
    // "worth the trip" candidate on top of being a confidence stretch too.
    const exploratory = await selectExploratoryCandidate(crewId, withTaste);
    if (exploratory) {
      return { outcome: 'eligible', details: { ...details, exploratory: true }, best: exploratory, usedTicketedFallback: false, forceExploratoryConfidence: true };
    }
    // Which filter actually killed it — "no strong match" covers a lot of genuinely different
    // situations, and during pilot "the whole pipeline is broken" vs "this Crew's taste is just
    // narrow this week" need to be tellable apart from the logs alone.
    return { outcome: 'no_eligible_candidate', details };
  }

  const { best, usedTicketedFallback } = pickBest(winnerPools.eligible);
  return {
    outcome: 'eligible',
    details: usedRadiusExpansion
      ? { ...buildDetails(winnerPools, winnerRadiusMeters, { standardMiles, crewInterestPreferences }), radiusExpansionMiles: baseRadiusMiles }
      : details,
    best,
    usedTicketedFallback,
    usedRadiusExpansion,
    radiusExpansionBaseMiles: usedRadiusExpansion ? baseRadiusMiles : undefined,
  };
}

/**
 * Generates and delivers (at most) one automatic recommendation for a single Crew, if — and
 * only if — every real gate passes: recommendations enabled, under the weekly cap, a
 * not-previously-recommended experience clears the confidence floor, and (unlike the manual
 * "Find us something" flow) actually within the Crew's travel radius. Returns null whenever
 * nothing was sent, which is the expected common case, not an error.
 *
 * `guaranteeFirst` is for exactly one caller — the immediate 1->2-member join trigger
 * (routes/crews.ts) — never the periodic sweep, which stays deliberately conservative. See
 * evaluateCrewEligibility's own comment on what it relaxes and what it never does.
 */
// Per-crew in-process serialization — real concurrency bug found operating this: two independent
// call sites can both fire `generateRecommendationForCrew(crewId, { guaranteeFirst: true })` for
// the SAME brand-new Crew within milliseconds of each other (updateSettings's own first-
// preferences-set trigger and routes/crews.ts's 1->2-member join trigger — see each one's own
// comment on why both exist). Both used to run fully concurrently: each independently read
// `excluded`/`alreadySpoken` before either had written anything, so both could pass every check
// and both proceed — one delivering a real recommendation, the other (finding nothing "yet"
// excluded from ITS OWN read) sending the honest "we don't have anything yet" fallback message
// milliseconds apart, so a Crew could see BOTH in the same breath. Made measurably easier to hit
// by this phase's own added checks (getCrewActivitySignals, cadence spacing) — more awaited work
// between "read" and "write" widens the exact window this race lives in. Fixed by chaining every
// call for the same crewId onto the previous one's completion — the standard, cheap fix for this
// shape of bug in a single-process deployment (see runSweepIfDue's own comment on this app's real
// deployment target); a call that arrives while another is still running now genuinely waits for
// it, so the second evaluation always sees the first one's effects, never a stale, pre-write view.
const inFlightGenerations = new Map<string, Promise<CrewRecommendation | null>>();

export function generateRecommendationForCrew(crewId: string, opts: { guaranteeFirst?: boolean } = {}): Promise<CrewRecommendation | null> {
  const prior = inFlightGenerations.get(crewId) ?? Promise.resolve(null);
  const chained = prior.catch(() => null).then(() => generateRecommendationForCrewNow(crewId, opts));
  inFlightGenerations.set(crewId, chained);
  // A no-op `.catch` off the SAME promise the caller gets back — cleanup must observe a rejection
  // too (or this dangling branch becomes an unhandled rejection), but must never swallow it for
  // the caller, who still awaits/catches `chained` itself, unaffected by this branch.
  chained.catch(() => {}).finally(() => {
    if (inFlightGenerations.get(crewId) === chained) inFlightGenerations.delete(crewId);
  });
  return chained;
}

async function generateRecommendationForCrewNow(crewId: string, opts: { guaranteeFirst?: boolean } = {}): Promise<CrewRecommendation | null> {
  // Self-healing safety net — see tryDeriveAndApplyCrewPreferences's own comment. Never mutates
  // `opts` itself (the caller's object may be reused/logged elsewhere); `effectiveOpts` is a
  // local, this-pass-only upgrade so a Crew whose preferences just got safely derived for the
  // first time gets the same "never come up empty" guarantee an explicit first-set already gets,
  // even when this pass was only ever a routine, non-guaranteed sweep.
  const justDerivedFirstTime = await tryDeriveAndApplyCrewPreferences(crewId);
  const effectiveOpts = justDerivedFirstTime ? { ...opts, guaranteeFirst: true } : opts;

  const evaluation = await evaluateCrewEligibility(crewId, effectiveOpts);
  if (evaluation.outcome !== 'eligible' || !evaluation.best) {
    logRecommendationOutcome(crewId, evaluation.outcome as RecommendationOutcome, evaluation.details);
    // Real, live-reported gap this closes: this guarantee's whole point (see
    // evaluateCrewEligibility's own comment) is that a brand-new Crew's first moment with Plot
    // must never come up empty — but "empty" used to mean total silence whenever the Crew's own
    // explicit category/interest preference (now a HARD filter, services/match.ts) genuinely
    // matches zero live inventory near them right now — a real, likely scenario for a narrow
    // preference in a smaller city, and the exact live-reported symptom: "I made a new crew...
    // nothing has been sent to the crew yet". Silence reads as the product being broken, not as
    // an honest "nothing yet" — so this is the one moment `no_eligible_candidate` still owes the
    // Crew a reply, even though it can't honestly send an experience. Scoped tightly to
    // `guaranteeFirst` (never the periodic sweep, which is deliberately, silently conservative —
    // see this function's own doc comment) and to genuinely finding nothing at all, never a
    // near-miss that just didn't clear the confidence bar (that's exactly what the guarantee
    // above already relaxes; reaching `no_eligible_candidate` here means there was nothing in
    // radius matching the Crew's own preference, full stop). Guarded by checking for a prior Plot
    // message first — this is a single-shot trigger in practice (see routes/crews.ts and
    // updateSettings's own comments on why only one of the two call sites ever reaches a real,
    // 2+-member evaluation) but a concurrent double-fire should still never double up the
    // message a Crew sees.
    if (effectiveOpts.guaranteeFirst && evaluation.outcome === 'no_eligible_candidate') {
      const systemUserId = await getPlotSystemUserId();
      const alreadySpoken = await prisma.crewMessage.findFirst({ where: { crewId, authorId: systemUserId }, select: { id: true } });
      if (!alreadySpoken) {
        const settings = await getOrCreateSettings(crewId);
        const city = typeof evaluation.details.city === 'string' ? evaluation.details.city : null;
        // Real, live-reported bug this fixes: an interest-only Crew (no categoryPreferences set
        // at all) got "We don't have any what you told us you're into events near London" — a
        // placeholder phrase substituted directly into the sentence instead of the Crew's actual
        // interest(s). `interestLabel` (the same taxonomy lookup match.ts's own scoring reasons
        // use) turns an id like 'sushi' into its real display label, so this always names what
        // the Crew actually picked, category or interest, never a generic stand-in.
        const preferenceLabel = [
          ...settings.categoryPreferences.map((c) => c.replace(/_/g, ' ').toLowerCase()),
          ...settings.interestPreferences.map((id) => interestLabel(id).toLowerCase()),
        ].join(' or ') || null;
        const near = city ? ` near ${city}` : '';
        const body = preferenceLabel
          ? `We don't have any ${preferenceLabel} events${near} that we can honestly recommend yet — we're still looking, and we'll message the moment something turns up.`
          : `We don't have anything${near} that we can honestly recommend yet — we're still looking, and we'll message the moment something turns up.`;
        await sendSystemMessage(crewId, systemUserId, body);
      }
    }
    return null;
  }

  const best = evaluation.best;

  // Real, live-reported bug this fixes: "I just created a crew... the first event plot sent...
  // STOCK IMAGES" — a fresh Experience can sit with `imageUrl: null` for up to 6 hours (see
  // inventorySync.ts's own MISSING_IMAGE_BACKFILL_DUE_INTERVAL_MS) before the periodic sweep
  // ever reaches it, during which every card for it renders the generic v2Art fallback graphic
  // instead of a real photo. That's an acceptable wait for routine inventory sitting unseen in
  // Explore; it is NOT acceptable for the single most scrutinised card in the whole product — a
  // Crew's own Plot recommendation, "one shot to make a good impression" already established for
  // taste-matching (see evaluateCrewEligibility's own guaranteeFirst comment) and no less true
  // for imagery. Best-effort and synchronous, right before delivery: if the chosen experience
  // has no image yet, run the exact same enrichment chain the scheduled backfill uses, right now,
  // so the card this Crew is about to see gets whatever real photo is genuinely findable at send
  // time rather than waiting on a sweep that might not run for hours. A miss here (nothing found,
  // or the source is briefly down) is never fatal — the row simply stays null and the next
  // scheduled sweep still picks it up, same as any other unfilled row.
  if (!best.experience.imageUrl) {
    await enrichMissingImageForExperience({ id: best.experience.id, name: best.experience.name, category: best.experience.category, subcategories: best.experience.subcategories });
  }

  // Real, evidence-derived confidence (services/recommendationConfidence.ts) — decides the
  // message's own lead-in copy AND is stored on the row for pilot analytics/the card's own
  // display. An exploratory send is always labelled EXPLORATORY explicitly (see
  // CrewEligibilityResult.forceExploratoryConfidence's own comment), never inferred from score.
  const confidence = deriveConfidence(best, { forceExploratory: evaluation.forceExploratoryConfidence }).level;
  // Real, live-found bug this closes: `usedTicketedFallback` is a SUPPLY-TYPE signal ("the pick
  // isn't itself a ticketed/dated event"), not a QUALITY signal — but it used to unconditionally
  // override confidence-based copy, so a genuinely excellent, high-confidence match that simply
  // happened to be a restaurant/bar/market (real FHRS/OSM/Google Places/Foursquare inventory —
  // most of what those sources ARE is inherently non-ticketed) got the SAME hedging "there's not
  // much in your area right now" preface as a genuine last-resort compromise pick. Confirmed via
  // a controlled 5-Crew baseline test: an 85-scoring, individually-taste-matched pick got framed
  // identically to a bare 60-scoring one. Only hedge when the pick genuinely ISN'T a confident
  // match either — a HIGH-confidence non-ticketed pick is not a compromise, it's exactly what
  // Plot was asked to find, and the copy must say so.
  const isGenuineCompromise = evaluation.usedTicketedFallback && confidence !== 'HIGH';
  // Radius expansion has its own, distance-specific honest preface — takes priority over the
  // ticketed-fallback one when both are true (a pick can be both non-ticketed AND found only by
  // searching wider; the DISTANCE is the more specific, more useful thing to tell the Crew about
  // right now). Real distance only — never sent if `distanceMiles` genuinely couldn't be computed.
  const expansionExtraMiles =
    evaluation.usedRadiusExpansion && best.distanceMiles !== null && evaluation.radiusExpansionBaseMiles !== undefined
      ? best.distanceMiles - evaluation.radiusExpansionBaseMiles
      : null;
  const leadIn =
    expansionExtraMiles !== null && expansionExtraMiles > 0
      ? radiusExpansionPreface(expansionExtraMiles)
      : isGenuineCompromise
        ? TICKETED_FALLBACK_PREFACE
        : confidenceLeadIn(confidence);

  const systemUserId = await getPlotSystemUserId();
  const { plan, messageId } = await createRecommendationPlanForCrew(crewId, best.experience.id, systemUserId, { preface: leadIn });

  const recommendation = await prisma.crewRecommendation.create({
    data: {
      crewId,
      experienceId: best.experience.id,
      score: best.matchScore,
      reasonText: explanationFor(best, { isTicketedFallback: isGenuineCompromise, radiusExpansionExtraMiles: expansionExtraMiles }),
      status: 'SENT',
      confidence,
      planId: plan.id,
    },
  });

  const ticketed = isTicketedEvent(best.experience);
  await track(
    'CrewRecommendationDelivered',
    { crewId, experienceId: best.experience.id, score: best.matchScore, confidence, category: best.experience.category, ticketed, usedTicketedFallback: Boolean(evaluation.usedTicketedFallback) },
    { crewId, planId: plan.id },
  );
  logRecommendationOutcome(crewId, 'delivered', {
    experienceId: best.experience.id,
    score: best.matchScore,
    planId: plan.id,
    confidence,
    category: best.experience.category,
    isTicketedEvent: ticketed,
    usedTicketedFallback: Boolean(evaluation.usedTicketedFallback),
  });
  void messageId; // kept on the created CrewMessage itself; not stored redundantly here

  return recommendation;
}

/**
 * Read-only diagnostic wrapper around `evaluateCrewEligibility` for `GET /admin/crews/:id/
 * explain-recommendation` — the exact same reasoning `generateRecommendationForCrew` would use
 * right now, without sending anything, so "why hasn't this Crew gotten a recommendation" has a
 * real, specific answer instead of a guess.
 */
export async function explainCrewRecommendation(crewId: string) {
  const evaluation = await evaluateCrewEligibility(crewId);
  return {
    crewId,
    outcome: evaluation.outcome,
    ...evaluation.details,
    usedTicketedFallback: Boolean(evaluation.usedTicketedFallback),
    usedRadiusExpansion: Boolean(evaluation.usedRadiusExpansion),
    radiusExpansionBaseMiles: evaluation.radiusExpansionBaseMiles ?? null,
    bestCandidate: evaluation.best
      ? {
          experienceId: evaluation.best.experience.id,
          experienceName: evaluation.best.experience.name,
          category: evaluation.best.experience.category,
          score: evaluation.best.matchScore,
        }
      : null,
  };
}

// respondToRecommendation moved to services/recommendationLearning.ts#recordRecommendationResponse
// — the response-recording write path now lives alongside the learning model it feeds (per-
// member RecommendationResponse rows, real reason codes, the "Got it — ..." acknowledgment),
// rather than a second file that would have to stay in sync with it. RecommendationError/
// RecommendationResponseAction are re-exported above for existing importers.

/**
 * The periodic delivery job (brief's "a scheduling/delivery mechanism... periodic job
 * evaluating active Crews"). Runs `generateRecommendationForCrew` across every Crew, isolating
 * failures per-Crew so one bad Crew (a provider outage while scoring its city, say) never
 * blocks the rest of the sweep. Wired to a periodic timer in server.ts for real operation, and
 * exposed via `POST /admin/recommendations/sweep` for on-demand runs (ops, and pilot testing —
 * see docs/DECISIONS.md#crew-auto-recommendations).
 */
export async function runRecommendationSweep(): Promise<{ crewsEvaluated: number; delivered: number; errors: number }> {
  const crews = await prisma.crew.findMany({ where: { archivedAt: null }, select: { id: true } });
  let delivered = 0;
  let errors = 0;
  for (const crew of crews) {
    try {
      const result = await generateRecommendationForCrew(crew.id);
      if (result) delivered += 1;
    } catch (err) {
      errors += 1; // one Crew's failure (e.g. no reachable provider for its city) never halts the sweep
      logRecommendationOutcome(crew.id, 'error', { err: err instanceof Error ? err.message : String(err) });
    }
  }
  return { crewsEvaluated: crews.length, delivered, errors };
}

// Exported (not just a local const) so a read-only status endpoint (see app.ts's `/health/
// scheduler`) can look up the exact same SchedulerState row this module writes, instead of a
// second hardcoded copy of the job name drifting out of sync with this one.
export const SWEEP_JOB_NAME = 'crew_recommendation_sweep';

/**
 * The restart/sleep-tolerant replacement for trusting a single process's own in-memory
 * `setInterval` state. Real gap this closes: this app's documented deployment targets (Railway/
 * Render/Fly — see docs/DEPLOYMENT.md) are typically ONE long-running container, but hobby-tier
 * hosting on that shape commonly (a) puts an idle free-tier service to sleep for hours at a
 * time (Render's free tier does this — the process, and every in-memory timer in it, simply
 * stops running until the next inbound request wakes it), (b) restarts the process on every
 * deploy, and (c) can briefly run an old+new instance pair during a rolling deploy. A bare
 * `setInterval`'s schedule lives only in that one process's memory — it has no idea whether a
 * sweep is actually overdue, only how long ITSELF has been alive, and two processes racing each
 * other have no way to coordinate at all.
 *
 * This asks a different, correct question — "per the DATABASE, not per this process's own
 * uptime, is a sweep actually overdue right now?" — and answers it with a single atomic
 * conditional UPDATE (`WHERE lastClaimedAt IS NULL OR < cutoff`), not a read-then-write: two
 * processes calling this at the same instant can't both see "unclaimed" and both proceed: only
 * whichever UPDATE actually changed a row (`count === 1`) wins the claim, Postgres's own
 * row-level locking serializes the race. Cheap and safe to call often (server.ts calls this on
 * every boot AND on a short in-process poll) — a call that finds nothing overdue is one indexed
 * UPDATE that touches zero rows, not a full sweep.
 */
async function claimSweepIfDue(dueIntervalMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - dueIntervalMs);
  const now = new Date();

  await prisma.schedulerState.upsert({
    where: { jobName: SWEEP_JOB_NAME },
    update: {},
    create: { jobName: SWEEP_JOB_NAME },
  });

  const claim = await prisma.schedulerState.updateMany({
    where: { jobName: SWEEP_JOB_NAME, OR: [{ lastClaimedAt: null }, { lastClaimedAt: { lt: cutoff } }] },
    data: { lastClaimedAt: now },
  });

  return claim.count === 1;
}

/**
 * The one function server.ts (and, in principle, an external cron hitting
 * `POST /admin/recommendations/sweep`) should ever call — "run a sweep if the database says one
 * is actually due", never "run a sweep because my own timer just fired". See `claimSweepIfDue`
 * above for why that distinction is the actual production-correctness fix, not just the boot-
 * timing fix from the previous pass.
 */
export async function runSweepIfDue(
  dueIntervalMs: number,
): Promise<{ ran: boolean; result?: { crewsEvaluated: number; delivered: number; errors: number } }> {
  const claimed = await claimSweepIfDue(dueIntervalMs);
  if (!claimed) {
    return { ran: false };
  }
  const result = await runRecommendationSweep();
  await prisma.schedulerState.update({
    where: { jobName: SWEEP_JOB_NAME },
    data: { lastRunAt: new Date(), lastResult: result as unknown as Prisma.InputJsonValue },
  });
  logger.info({ event: 'crew_recommendation_sweep_ran', ...result }, 'Recommendation sweep: ran (database confirmed it was due)');
  return { ran: true, result };
}
