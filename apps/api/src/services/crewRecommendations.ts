import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { track } from './analytics';
import { ensureInventory } from './inventorySync';
import { scoreExperiencesForCrew, type MatchOption } from './match';
import { createRecommendationPlanForCrew } from './plan';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { Prisma } from '@prisma/client';
import type { CrewRecommendation, CrewRecommendationStatus } from '@prisma/client';

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

// A confidence floor, not a quota — most weeks most Crews will see nothing, because most weeks
// nothing clears this bar. Never "keep lowering the bar until something ships" logic.
const MIN_RECOMMENDATION_SCORE = 55;
const LOOKBACK_DAYS_FOR_WEEKLY_CAP = 7;

// The real delivery cadence — shared by server.ts's own poll and the admin sweep endpoint's
// default (non-`force`) path, so there is exactly one place this number lives, not two that can
// drift apart. See runSweepIfDue's own comment for the full reasoning.
export const RECOMMENDATION_SWEEP_DUE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// The system author for every automatic recommendation — never a real person's identity, and
// deliberately never added as a CrewMember of anything, so it can't appear in member lists,
// vote pulses, or "who's in this Crew" anywhere in the product. Self-heals on first use, same
// pattern as ensureInventory's city seeding.
export const PLOT_SYSTEM_EMAIL = 'system+plot-recommendations@plot.internal';
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

export interface RecommendationSettingsDTO {
  enabled: boolean;
  maxPerWeek: number;
  travelRadiusMeters: number | null;
  // The Crew's own explicit picks — see the schema field's own comment (CrewRecommendationSettings
  // .categoryPreferences) for why this blends with, rather than replaces, member-derived taste.
  categoryPreferences: string[];
  // One level more specific — taxonomy interest ids, see .interestPreferences's own schema comment.
  interestPreferences: string[];
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
  };
}

export async function updateSettings(
  crewId: string,
  patch: Partial<RecommendationSettingsDTO>,
): Promise<RecommendationSettingsDTO> {
  await getOrCreateSettings(crewId); // ensure the row exists before the update
  const settings = await prisma.crewRecommendationSettings.update({
    where: { crewId },
    data: {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.maxPerWeek !== undefined ? { maxPerWeek: patch.maxPerWeek } : {}),
      ...(patch.travelRadiusMeters !== undefined ? { travelRadiusMeters: patch.travelRadiusMeters } : {}),
      ...(patch.categoryPreferences !== undefined ? { categoryPreferences: patch.categoryPreferences } : {}),
      ...(patch.interestPreferences !== undefined ? { interestPreferences: patch.interestPreferences } : {}),
    },
  });
  return {
    enabled: settings.enabled,
    maxPerWeek: settings.maxPerWeek,
    travelRadiusMeters: settings.travelRadiusMeters,
    categoryPreferences: settings.categoryPreferences,
    interestPreferences: settings.interestPreferences,
  };
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** A real, specific, multi-clause explanation — never the raw score, never a fabricated
 * "insight", every clause traceable to a reason the scorer actually produced (brief §"Why This")
 * example: not "Because your Crew likes music" (tells you nothing) but "2/3 of you are into UK
 * garage, and it's 8 miles from your area" — a claim specific enough that the honest reaction is
 * "yeah, that actually is us." Picks the single strongest, most specific signal available as the
 * lead clause (a literal free-text match beats a specific-interest match beats a bare category
 * match — more specific claims are more trustworthy), then one supporting context clause. Never
 * asserts a code that isn't actually in `option.reasons`. */
function explanationFor(option: MatchOption): string {
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

  return secondary ? `${primary}, and ${secondary}.` : `${primary}.`;
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
}
async function evaluateCrewEligibility(crewId: string, opts: { guaranteeFirst?: boolean } = {}): Promise<CrewEligibilityResult> {
  const settings = await getOrCreateSettings(crewId);
  if (!settings.enabled) {
    return { outcome: 'disabled', details: {} };
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

  // Diagnostic-only, mirrors what scoreExperiencesForCrew computes internally for the actual
  // radius filter (services/match.ts) — real gap found investigating "afterRadius: 0 for every
  // candidate, on every multi-member Crew" in production: this is the one piece of context that
  // number alone can't show (a member's real home city vs. coordinates, and the effective radius
  // being applied), so it's surfaced directly rather than requiring a second round of guessing.
  const memberLocations = await prisma.crewMember.findMany({
    where: { crewId, status: 'ACTIVE' },
    select: { user: { select: { email: true, profile: { select: { homeCity: true, homeLat: true, homeLng: true } } } } },
  });
  const locationSummary = memberLocations.map((m) => ({
    email: m.user.email,
    homeCity: m.user.profile?.homeCity ?? null,
    hasCoordinates: m.user.profile?.homeLat !== null && m.user.profile?.homeLat !== undefined,
  }));

  const scored = await scoreExperiencesForCrew(crewId, { radiusMetersOverride: settings.travelRadiusMeters });

  // Never repeat: anything ever recommended to this Crew before (any status — a dismissal is
  // still a "don't show again", not a "try harder next time"), and anything a member has
  // already shared/found themselves — recommending something the Crew is already looking at
  // would read as Plot not paying attention.
  const [alreadyRecommended, alreadyShared] = await Promise.all([
    prisma.crewRecommendation.findMany({ where: { crewId }, select: { experienceId: true } }),
    prisma.plan.findMany({ where: { crewId, experienceId: { not: null } }, select: { experienceId: true } }),
  ]);
  const excluded = new Set([...alreadyRecommended.map((r) => r.experienceId), ...alreadyShared.map((p) => p.experienceId as string)]);

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
  const inRadius = notExcluded.filter((o) => o.withinRadius !== false);
  const withTaste = inRadius.filter(hasTasteSignal);
  const eligible = withTaste.filter((o) => o.matchScore >= MIN_RECOMMENDATION_SCORE);
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
  };
  if (opts.guaranteeFirst && eligible.length === 0 && inRadius.length > 0) {
    // Real, live product requirement: a brand-new Crew's very first moment must not come up
    // empty — "it should immediately hit them with at LEAST 1 event line with the preferences"
    // — even when nothing yet clears the periodic sweep's deliberately conservative confidence
    // bar (a fresh Crew's members often haven't swiped enough for real affinity/DNA signal, and
    // may not have set a crew_preference yet either). The candidate pool itself is never
    // relaxed — still real, in-radius, quality-checked, not already shown/recommended — only
    // the confidence bar is skipped for this one moment, ranked by whatever score IS there
    // (taste signal, if any, still sorts first via match.ts's own scoring).
    const bestAvailable = [...inRadius].sort((a, b) => b.matchScore - a.matchScore)[0];
    return { outcome: 'eligible', details: { ...details, guaranteedFirst: true }, best: bestAvailable };
  }

  if (eligible.length === 0) {
    // Which filter actually killed it — "no strong match" covers a lot of genuinely different
    // situations, and during pilot "the whole pipeline is broken" vs "this Crew's taste is just
    // narrow this week" need to be tellable apart from the logs alone.
    return { outcome: 'no_eligible_candidate', details };
  }

  return { outcome: 'eligible', details, best: eligible[0] };
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
export async function generateRecommendationForCrew(crewId: string, opts: { guaranteeFirst?: boolean } = {}): Promise<CrewRecommendation | null> {
  const evaluation = await evaluateCrewEligibility(crewId, opts);
  if (evaluation.outcome !== 'eligible' || !evaluation.best) {
    logRecommendationOutcome(crewId, evaluation.outcome as RecommendationOutcome, evaluation.details);
    return null;
  }

  const best = evaluation.best;
  const systemUserId = await getPlotSystemUserId();
  const { plan, messageId } = await createRecommendationPlanForCrew(crewId, best.experience.id, systemUserId);

  const recommendation = await prisma.crewRecommendation.create({
    data: {
      crewId,
      experienceId: best.experience.id,
      score: best.matchScore,
      reasonText: explanationFor(best),
      status: 'SENT',
      planId: plan.id,
    },
  });

  await track(
    'CrewRecommendationDelivered',
    { crewId, experienceId: best.experience.id, score: best.matchScore },
    { crewId, planId: plan.id },
  );
  logRecommendationOutcome(crewId, 'delivered', { experienceId: best.experience.id, score: best.matchScore, planId: plan.id });
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

export type RecommendationResponseAction = 'more_like_this' | 'not_for_us' | 'too_far' | 'too_expensive' | 'wrong_vibe';

const RESPONSE_STATUS: Record<RecommendationResponseAction, CrewRecommendationStatus> = {
  more_like_this: 'MORE_LIKE_THIS',
  not_for_us: 'NOT_FOR_US',
  too_far: 'TOO_FAR',
  too_expensive: 'TOO_EXPENSIVE',
  wrong_vibe: 'WRONG_VIBE',
};

export class RecommendationError extends Error {
  constructor(message: string, public code: 'not_found' | 'invalid_action') {
    super(message);
  }
}

/** Lightweight per-recommendation feedback — "More like this" / "Not for us" / "Too far" /
 * "Too expensive" / "Wrong vibe". Every action marks the recommendation responded-to (so it's
 * never re-surfaced as "new"); the experience itself is already permanently excluded from
 * future scoring for this Crew regardless of which button was tapped — see
 * `generateRecommendationForCrew`'s `excluded` set above. */
export async function respondToRecommendation(
  crewId: string,
  recommendationId: string,
  userId: string,
  action: RecommendationResponseAction,
): Promise<CrewRecommendation> {
  const status = RESPONSE_STATUS[action];
  if (!status) throw new RecommendationError('Not a recognised response.', 'invalid_action');

  const existing = await prisma.crewRecommendation.findUnique({ where: { id: recommendationId } });
  if (!existing || existing.crewId !== crewId) {
    throw new RecommendationError('Recommendation not found for this Crew.', 'not_found');
  }

  const updated = await prisma.crewRecommendation.update({
    where: { id: recommendationId },
    data: { status, respondedAt: new Date() },
  });

  await track('CrewRecommendationResponded', { crewId, recommendationId, action, userId }, { crewId, userId });

  return updated;
}

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
