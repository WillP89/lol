import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { track } from './analytics';
import { ensureInventory, enrichMissingImageForExperience } from './inventorySync';
import { scoreExperiencesForCrew, getCrewExcludedExperienceIds, type MatchOption } from './match';
import { createRecommendationPlanForCrew } from './plan';
import { sendSystemMessage } from './chat';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { interestLabel } from '@plot/shared';
import { derivePlanWorthiness, deriveBookingType, deriveSourceKind, isTicketedEvent } from './opportunityIntent';
import { MIN_RECOMMENDATION_SCORE, EXPLORATION_MIN_SCORE, deriveConfidence, confidenceLeadIn } from './recommendationConfidence';
import { RecommendationResponseError, type RecommendationResponseAction } from './recommendationLearning';
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

  const nextCategoryPreferences = patch.categoryPreferences ?? current.categoryPreferences;
  const nextInterestPreferences = patch.interestPreferences ?? current.interestPreferences;
  const hadNoPreferencesYet = current.categoryPreferences.length === 0 && current.interestPreferences.length === 0;
  const hasPreferencesNow = nextCategoryPreferences.length > 0 || nextInterestPreferences.length > 0;
  const justSetPreferencesForFirstTime = current.preferencesSetAt === null && hadNoPreferencesYet && hasPreferencesNow;

  const settings = await prisma.crewRecommendationSettings.update({
    where: { crewId },
    data: {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.maxPerWeek !== undefined ? { maxPerWeek: patch.maxPerWeek } : {}),
      ...(patch.travelRadiusMeters !== undefined ? { travelRadiusMeters: patch.travelRadiusMeters } : {}),
      ...(patch.categoryPreferences !== undefined ? { categoryPreferences: patch.categoryPreferences } : {}),
      ...(patch.interestPreferences !== undefined ? { interestPreferences: patch.interestPreferences } : {}),
      ...(justSetPreferencesForFirstTime ? { preferencesSetAt: new Date() } : {}),
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
  }

  return {
    enabled: settings.enabled,
    maxPerWeek: settings.maxPerWeek,
    travelRadiusMeters: settings.travelRadiusMeters,
    categoryPreferences: settings.categoryPreferences,
    interestPreferences: settings.interestPreferences,
    preferencesSetAt: settings.preferencesSetAt,
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

/** A real, specific, multi-clause explanation — never the raw score, never a fabricated
 * "insight", every clause traceable to a reason the scorer actually produced (brief §"Why This")
 * example: not "Because your Crew likes music" (tells you nothing) but "2/3 of you are into UK
 * garage, and it's 8 miles from your area" — a claim specific enough that the honest reaction is
 * "yeah, that actually is us." Picks the single strongest, most specific signal available as the
 * lead clause (a literal free-text match beats a specific-interest match beats a bare category
 * match — more specific claims are more trustworthy), then one supporting context clause. Never
 * asserts a code that isn't actually in `option.reasons`. `isTicketedFallback` prepends the same
 * honest caveat `createRecommendationPlanForCrew`'s chat message uses — see
 * `TICKETED_FALLBACK_PREFACE`'s own comment. */
function explanationFor(option: MatchOption, opts: { isTicketedFallback?: boolean } = {}): string {
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
  return opts.isTicketedFallback ? `${TICKETED_FALLBACK_PREFACE} — ${lowerFirst(explanation)}` : explanation;
}

interface CrewActivitySignals {
  isActive: boolean;
  reason: 'onboarding_grace_period' | 'recent_message' | 'recent_response' | 'recent_plan_activity' | 'inactive';
  lastRecommendationAt: Date | null;
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
  const [crew, recentMessage, recentResponse, recentPlanActivity, lastRecommendation] = await Promise.all([
    prisma.crew.findUnique({ where: { id: crewId }, select: { createdAt: true } }),
    prisma.crewMessage.findFirst({ where: { crewId, createdAt: { gte: since } }, select: { id: true } }),
    prisma.recommendationResponse.findFirst({ where: { crewRecommendation: { crewId }, createdAt: { gte: since } }, select: { id: true } }),
    prisma.plan.findFirst({ where: { crewId, updatedAt: { gte: since } }, select: { id: true } }),
    prisma.crewRecommendation.findFirst({ where: { crewId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  const lastRecommendationAt = lastRecommendation?.createdAt ?? null;
  if (crew && crew.createdAt >= since) return { isActive: true, reason: 'onboarding_grace_period', lastRecommendationAt };
  if (recentMessage) return { isActive: true, reason: 'recent_message', lastRecommendationAt };
  if (recentResponse) return { isActive: true, reason: 'recent_response', lastRecommendationAt };
  if (recentPlanActivity) return { isActive: true, reason: 'recent_plan_activity', lastRecommendationAt };
  return { isActive: false, reason: 'inactive', lastRecommendationAt };
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
}

/** THE TIERING RULE this whole rebuild exists to enforce: "I need ticketed only events... don't
 *  think we need to focus on unpaid, no ticket events" — a real ticket first, always, and a
 *  non-ticketed fallback only when genuinely nothing ticketed clears the Crew's own eligibility
 *  bar. Never a hard exclusion (the product spec explicitly wants an honest fallback, not
 *  silence) — this picks the highest-scoring TICKETED candidate from `pool` when one exists,
 *  and only falls back to the highest-scoring candidate overall (ticketed or not) when it
 *  doesn't, flagging that fallback so the caller can preface the message honestly. Sorts its own
 *  copy of `pool` — never assumes the caller already sorted it. */
function pickBest(pool: MatchOption[]): { best: MatchOption | undefined; usedTicketedFallback: boolean } {
  const sorted = [...pool].sort((a, b) => b.matchScore - a.matchScore);
  const ticketed = sorted.find((o) => isTicketedEvent(o.experience));
  if (ticketed) return { best: ticketed, usedTicketedFallback: false };
  return { best: sorted[0], usedTicketedFallback: sorted.length > 0 };
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
  // blocks `guaranteeFirst`'s own "never come up empty on day one" guarantee.
  if (activity.lastRecommendationAt) {
    const hoursSinceLast = (Date.now() - activity.lastRecommendationAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLast < MIN_HOURS_BETWEEN_RECOMMENDATIONS) {
      return { outcome: 'too_soon', details: { lastRecommendationAt: activity.lastRecommendationAt, hoursSinceLast: Math.round(hoursSinceLast * 10) / 10, minHoursBetween: MIN_HOURS_BETWEEN_RECOMMENDATIONS } };
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

  const scoredBeforeFatigue = await scoreExperiencesForCrew(crewId, { radiusMetersOverride: settings.travelRadiusMeters });
  // Diversity/fatigue penalty (see CATEGORY_FATIGUE_WINDOW/PENALTY's own comment) — applied here,
  // to the automatic engine's own pool specifically, never inside match.ts's shared scorer (a
  // member manually asking "Find us something" wants the single best match, not a diversity-
  // optimised one). Re-sorted so every downstream consumer (debugger, tiering) sees the
  // fatigue-adjusted order, not the pre-penalty one.
  const scored = (await applyCategoryFatigue(crewId, scoredBeforeFatigue)).sort((a, b) => b.matchScore - a.matchScore);

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
  const notExcluded = scored.filter((o) => !excluded.has(o.experience.id));
  // THE CORE FIX for "Caffè Nero in London sent to a 25-mile Stafford Crew": `withinRadius` is
  // `boolean | null` — `null` means genuinely unknown (no venue coordinates, or no location
  // anchor could be established), never "near". The OLD filter here (`!== false`) treated null
  // exactly like true — an unknown distance silently passed the radius gate. Now requires
  // `=== true`: a candidate must be POSITIVELY CONFIRMED within radius to reach the automatic
  // engine at all — fail closed, never fail open, on a hard eligibility gate. See match.ts's own
  // `withinRadius` comment for the other half of this fix (the Crew's own explicit location, once
  // set, is the sole distance anchor — never blended with an individual member's personal home).
  const inRadius = notExcluded.filter((o) => o.withinRadius === true);
  const withTaste = inRadius.filter(hasTasteSignal);
  const eligible = withTaste.filter((o) => o.matchScore >= MIN_RECOMMENDATION_SCORE);
  // The recommendation debugger (product spec: "for each candidate show TITLE/DISTANCE/PLAN-
  // WORTHINESS/BOOKABILITY/ELIGIBILITY/REJECTION REASON/FINAL RANKING SCORE") — real evidence
  // for "why did #1 beat #2", not just whether #1 passed. Bounded to the top 10 BY SCORE across
  // the whole (pre-radius-gate) scored pool, so a rejected-for-distance candidate like Caffè Nero
  // still shows up in this trail with its real rejection reason, exactly the debugging case the
  // spec calls for — never silently absent from the trail just because it was excluded from
  // consideration. See routes/admin.ts's explain-recommendation endpoint, the only consumer.
  const debugCandidates = [...scored]
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 10)
    .map((o) => {
      const worthiness = derivePlanWorthiness(o.experience);
      const rejectionReasons: string[] = [];
      if (excluded.has(o.experience.id)) rejectionReasons.push('ALREADY_RECOMMENDED_OR_SHARED');
      if (o.withinRadius !== true) rejectionReasons.push(o.withinRadius === false ? 'OUTSIDE_CREW_RADIUS' : 'DISTANCE_UNKNOWN');
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
  const details = {
    city,
    memberLocations: locationSummary,
    travelRadiusMetersOverride: settings.travelRadiusMeters, // null = falls back to taste-profile median or a default, see match.ts
    totalScored: scored.length,
    afterDedup: notExcluded.length,
    afterRadius: inRadius.length,
    afterTasteSignal: withTaste.length,
    bestScoreSeen: withTaste.length > 0 ? Math.max(...withTaste.map((o) => o.matchScore)) : null,
    scoreThreshold: MIN_RECOMMENDATION_SCORE,
    topCandidates: debugCandidates,
  };
  if (opts.guaranteeFirst && eligible.length === 0 && inRadius.length > 0) {
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
    const tasteMatchedPool = withTaste.length > 0 ? withTaste : inRadius;
    const { best: bestAvailable, usedTicketedFallback } = pickBest(tasteMatchedPool);
    return {
      outcome: 'eligible',
      details: { ...details, guaranteedFirst: true, guaranteedFirstHadTasteSignal: withTaste.length > 0 },
      best: bestAvailable,
      usedTicketedFallback,
    };
  }

  if (eligible.length === 0) {
    // Controlled exploration (see selectExploratoryCandidate's own comment) — tried only once
    // the normal HIGH/MEDIUM pool has genuinely come up empty, so this can never displace a real
    // match, only fill a gap that would otherwise be silence.
    const exploratory = await selectExploratoryCandidate(crewId, withTaste);
    if (exploratory) {
      return { outcome: 'eligible', details: { ...details, exploratory: true }, best: exploratory, usedTicketedFallback: false, forceExploratoryConfidence: true };
    }
    // Which filter actually killed it — "no strong match" covers a lot of genuinely different
    // situations, and during pilot "the whole pipeline is broken" vs "this Crew's taste is just
    // narrow this week" need to be tellable apart from the logs alone.
    return { outcome: 'no_eligible_candidate', details };
  }

  const { best, usedTicketedFallback } = pickBest(eligible);
  return { outcome: 'eligible', details, best, usedTicketedFallback };
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
  const evaluation = await evaluateCrewEligibility(crewId, opts);
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
    if (opts.guaranteeFirst && evaluation.outcome === 'no_eligible_candidate') {
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
    await enrichMissingImageForExperience({ id: best.experience.id, name: best.experience.name, category: best.experience.category });
  }

  // Real, evidence-derived confidence (services/recommendationConfidence.ts) — decides the
  // message's own lead-in copy AND is stored on the row for pilot analytics/the card's own
  // display. Ticketed-fallback takes priority over confidence framing when both could apply (a
  // more specific honesty signal — "we tried to find a ticket" — than a generic confidence
  // level); an exploratory send is always labelled EXPLORATORY explicitly (see
  // CrewEligibilityResult.forceExploratoryConfidence's own comment), never inferred from score.
  const confidence = deriveConfidence(best, { forceExploratory: evaluation.forceExploratoryConfidence }).level;
  const leadIn = evaluation.usedTicketedFallback ? TICKETED_FALLBACK_PREFACE : confidenceLeadIn(confidence);

  const systemUserId = await getPlotSystemUserId();
  const { plan, messageId } = await createRecommendationPlanForCrew(crewId, best.experience.id, systemUserId, { preface: leadIn });

  const recommendation = await prisma.crewRecommendation.create({
    data: {
      crewId,
      experienceId: best.experience.id,
      score: best.matchScore,
      reasonText: explanationFor(best, { isTicketedFallback: evaluation.usedTicketedFallback }),
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
