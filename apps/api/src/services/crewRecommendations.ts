import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { track } from './analytics';
import { ensureInventory } from './inventorySync';
import { scoreExperiencesForCrew, type MatchOption } from './match';
import { createRecommendationPlanForCrew } from './plan';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import type { CrewRecommendation, CrewRecommendationStatus, Prisma } from '@prisma/client';

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
const PLOT_SYSTEM_EMAIL = 'system+plot-recommendations@plot.internal';
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
}

/** Self-heals a settings row on first read — every Crew gets sane defaults (on, 2/week,
 * radius derived from members) without a separate "set up recommendations" step. */
export async function getOrCreateSettings(crewId: string): Promise<RecommendationSettingsDTO> {
  const settings = await prisma.crewRecommendationSettings.upsert({
    where: { crewId },
    update: {},
    create: { crewId },
  });
  return { enabled: settings.enabled, maxPerWeek: settings.maxPerWeek, travelRadiusMeters: settings.travelRadiusMeters };
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
    },
  });
  return { enabled: settings.enabled, maxPerWeek: settings.maxPerWeek, travelRadiusMeters: settings.travelRadiusMeters };
}

/** A short, human explanation — never the raw score, never a fabricated "insight". Picks the
 * single most relevant real reason the scorer already produced, in a fixed priority order
 * (taste match first — the brief's own example is "Because your Crew likes comedy"). */
function explanationFor(option: MatchOption): string {
  const byCode = new Map(option.reasons.map((r) => [r.code, r]));
  const categoryLabel = option.experience.category.replace(/_/g, ' ').toLowerCase();
  if (byCode.has('crew_dna_match') || byCode.has('category_affinity')) {
    return `Because your Crew likes ${categoryLabel}`;
  }
  if (byCode.has('nearby')) {
    return `It's close to your area`;
  }
  if (byCode.has('under_budget')) {
    return `Fits your Crew's usual budget`;
  }
  if (byCode.has('high_availability')) {
    return `Most of your Crew are free that night`;
  }
  return `Matched to your Crew's taste`;
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
 * Generates and delivers (at most) one automatic recommendation for a single Crew, if — and
 * only if — every real gate passes: recommendations enabled, under the weekly cap, a
 * not-previously-recommended experience clears the confidence floor, and (unlike the manual
 * "Find us something" flow) actually within the Crew's travel radius. Returns null whenever
 * nothing was sent, which is the expected common case, not an error.
 */
export async function generateRecommendationForCrew(crewId: string): Promise<CrewRecommendation | null> {
  const settings = await getOrCreateSettings(crewId);
  if (!settings.enabled) {
    logRecommendationOutcome(crewId, 'disabled');
    return null;
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS_FOR_WEEKLY_CAP * 24 * 60 * 60 * 1000);
  const [recentCount, memberCount] = await Promise.all([
    prisma.crewRecommendation.count({ where: { crewId, createdAt: { gte: since } } }),
    prisma.crewMember.count({ where: { crewId, status: 'ACTIVE' } }),
  ]);
  if (recentCount >= settings.maxPerWeek) {
    logRecommendationOutcome(crewId, 'weekly_cap_reached', { recentCount, maxPerWeek: settings.maxPerWeek });
    return null;
  }
  if (memberCount < 2) {
    // a solo "Crew" has no one to recommend anything to yet
    logRecommendationOutcome(crewId, 'too_few_members', { memberCount });
    return null;
  }

  const city = await resolveCrewCityForSweep(crewId);
  await ensureInventory(city);

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
  const hasTasteSignal = (o: MatchOption) => o.reasons.some((r) => r.code === 'category_affinity' || r.code === 'crew_dna_match');
  const notExcluded = scored.filter((o) => !excluded.has(o.experience.id));
  const inRadius = notExcluded.filter((o) => o.withinRadius !== false);
  const withTaste = inRadius.filter(hasTasteSignal);
  const eligible = withTaste.filter((o) => o.matchScore >= MIN_RECOMMENDATION_SCORE);
  if (eligible.length === 0) {
    // Which filter actually killed it — "no strong match" covers a lot of genuinely different
    // situations, and during pilot "the whole pipeline is broken" vs "this Crew's taste is just
    // narrow this week" need to be tellable apart from the logs alone.
    logRecommendationOutcome(crewId, 'no_eligible_candidate', {
      totalScored: scored.length,
      afterDedup: notExcluded.length,
      afterRadius: inRadius.length,
      afterTasteSignal: withTaste.length,
      bestScoreSeen: withTaste.length > 0 ? Math.max(...withTaste.map((o) => o.matchScore)) : null,
      scoreThreshold: MIN_RECOMMENDATION_SCORE,
    });
    return null;
  }

  const best = eligible[0];
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
