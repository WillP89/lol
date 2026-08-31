import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { MIN_PUBLISHABLE_QUALITY_SCORE } from './qualityScoring';
import { getMemberAvailability } from './availability';
import { ensureInventory } from './inventorySync';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { track } from './analytics';
import { sendExperienceToCrew } from './plan';
import type { Experience, TasteProfile, Plan } from '@prisma/client';

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
  // null = distance couldn't be computed (no venue coords, or no member has a home location
  // set) — genuinely unknown, never treated as "near" or "far". Used by the automatic
  // recommendation engine (services/crewRecommendations.ts) to hard-filter on travel radius;
  // the manual "Find us something"/"Suggest something" flows only use it as a soft scoring
  // input, since a member actively browsing should still be able to see something further out.
  withinRadius: boolean | null;
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

const CANDIDATE_WINDOW_DAYS = 21;
const RESULT_COUNT = 3;
// The onboarding default (see onboarding/page.tsx) — used whenever we need a radius and no
// member has a real TasteProfile.travelRadiusMeters yet, so a brand-new Crew still gets a
// sane "worth travelling for" distance rather than an unbounded or zero radius.
const DEFAULT_RADIUS_METERS = 24000;

/** Great-circle distance in miles — UK convention (brief: "miles not raw coordinates"). */
function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
 *
 * Every option keeps its `reasons[]` so the API response is explainable, not a black box
 * score — see brief §46. Does not persist anything; callers that need an audit trail (
 * `findUsSomething`) do that themselves.
 */
export async function scoreExperiencesForCrew(
  crewId: string,
  opts: { radiusMetersOverride?: number | null } = {},
): Promise<MatchOption[]> {
  const [members, dna] = await Promise.all([
    prisma.crewMember.findMany({
      where: { crewId, status: 'ACTIVE' },
      include: { user: { include: { tasteProfile: true, profile: true } } },
    }),
    prisma.crewDNA.findUnique({ where: { crewId } }),
  ]);

  const userIds = members.map((m) => m.userId);
  const tasteProfiles = members
    .map((m) => m.user.tasteProfile)
    .filter((tp): tp is TasteProfile => Boolean(tp));
  // Never expose a member's precise home coordinates to the Crew (see docs/DECISIONS.md#uk-
  // wide-location) — this stays server-side, used only to compute a distance, never returned.
  const memberCoords: { homeLat: number; homeLng: number }[] = [];
  for (const m of members) {
    const p = m.user.profile;
    if (p && p.homeLat !== null && p.homeLng !== null) {
      memberCoords.push({ homeLat: p.homeLat, homeLng: p.homeLng });
    }
  }

  const windowStart = new Date();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + CANDIDATE_WINDOW_DAYS);

  // Layer 1: hard constraints, expressed directly as a WHERE clause rather than filtered in
  // application code — no reason to pull rows across the wire just to discard them.
  const candidates = await prisma.experience.findMany({
    where: {
      qualityScore: { gte: MIN_PUBLISHABLE_QUALITY_SCORE },
      bookingStatus: { not: 'SOLD_OUT' },
      startsAt: { gte: windowStart, lte: windowEnd },
    },
    include: { venue: true },
    take: 50,
  });

  const medianBudget = medianOf(tasteProfiles.map((tp) => (tp.budgetMinMinor + tp.budgetMaxMinor) / 2));
  const dnaTopCategories = new Set((dna?.topCategories as string[] | undefined) ?? []);
  const radiusMeters = opts.radiusMetersOverride
    ?? (medianOf(tasteProfiles.map((tp) => tp.travelRadiusMeters).filter((r) => r > 0)) || DEFAULT_RADIUS_METERS);
  const radiusMiles = radiusMeters / 1609.34;

  const scored: MatchOption[] = [];
  for (const experience of candidates) {
    const reasons: MatchReason[] = [];
    let score = 0;

    // Layer 2: preference scoring (0-50)
    const affinities = tasteProfiles
      .map((tp) => (tp.categoryAffinity as Record<string, number>)[categoryToTasteKey(experience.category)])
      .filter((v): v is number => typeof v === 'number');
    const avgAffinity = affinities.length ? affinities.reduce((a, b) => a + b, 0) / affinities.length : 0;
    score += Math.max(0, avgAffinity) * 35;
    if (avgAffinity > 0.3) {
      reasons.push({ code: 'category_affinity', label: `${Math.round((affinities.filter((a) => a > 0).length / Math.max(1, affinities.length)) * members.length)}/${members.length} usually go for this` });
    }

    if (dnaTopCategories.has(experience.category)) {
      score += 15;
      reasons.push({ code: 'crew_dna_match', label: "Matches this Crew's usual taste" });
    }

    // Layer 3: context (0-35)
    if (experience.priceMinMinor !== null && medianBudget > 0) {
      if (experience.priceMinMinor <= medianBudget) {
        score += 15;
        reasons.push({ code: 'under_budget', label: "Under your Crew's typical spend" });
      } else if (experience.priceMinMinor > medianBudget * 1.5) {
        score -= 10; // over budget is a soft penalty, not a hard filter — groups do splurge
      }
    }

    // Distance — averaged across whichever members have a home location set (never fabricated
    // for the rest); scored here as a soft input, hard-filtered separately by the automatic
    // recommendation engine via `withinRadius`. See docs/DECISIONS.md#crew-auto-recommendations.
    let withinRadius: boolean | null = null;
    if (experience.venue && memberCoords.length > 0) {
      const distances = memberCoords.map((c) => haversineMiles(c.homeLat, c.homeLng, experience.venue!.latitude, experience.venue!.longitude));
      const avgMiles = distances.reduce((a, b) => a + b, 0) / distances.length;
      withinRadius = avgMiles <= radiusMiles;
      if (avgMiles <= radiusMiles) {
        // Closer scores higher, capped at 15 — a tiebreaker among in-radius options, not a
        // dominant factor (a great match slightly further is still worth surfacing).
        score += Math.max(0, 15 - (avgMiles / radiusMiles) * 15);
        const roundedMiles = Math.round(avgMiles);
        reasons.push({ code: 'nearby', label: roundedMiles <= 1 ? 'Under a mile from your area' : `${roundedMiles} miles from your area` });
      } else if (avgMiles <= radiusMiles * 1.5) {
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

    scored.push({
      experience,
      matchScore: Math.max(0, Math.min(100, Math.round(score))),
      reasons,
      availableMemberCount: availableCount,
      totalMemberCount: userIds.length,
      withinRadius,
    });
  }

  scored.sort((a, b) => b.matchScore - a.matchScore);
  return scored;
}

/**
 * The signature "Find us something" interaction — runs the shared scorer, persists the result
 * for explainability/audit (brief §13 Intent Graph), and returns the top 3.
 */
export async function findUsSomething(
  crewId: string,
  requestedByUserId: string,
): Promise<{ recommendationId: string; options: MatchOption[] }> {
  const city = await resolveCrewCity(crewId, requestedByUserId);
  // Self-heals an unseeded city on first use — see ensureInventory's own comment.
  await ensureInventory(city);

  const scored = await scoreExperiencesForCrew(crewId);
  const reranked = await identityRanker.rerank(scored.slice(0, 10), { crewId });
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

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** TasteProfile.categoryAffinity keys are the free-text onboarding swipe categories (e.g.
 *  "clubbing", "live music"), which don't line up 1:1 with the Experience.category enum — this
 *  maps enum values to the closest onboarding key. A real mapping table grows with the taxonomy;
 *  this is deliberately a small, visible function rather than buried inline. */
export function categoryToTasteKey(category: string): string {
  const map: Record<string, string> = {
    LIVE_MUSIC: 'live_music',
    CLUBBING: 'clubbing',
    RESTAURANT: 'restaurant',
    BAR: 'bar',
    COMEDY: 'comedy',
    THEATRE: 'theatre',
    CINEMA: 'cinema',
    ART_CULTURE: 'art_culture',
    SPORT: 'sport',
    FITNESS: 'fitness',
    FESTIVAL: 'festival',
    DAY_ACTIVITY: 'day_activity',
    COMMUNITY: 'community',
  };
  return map[category] ?? category.toLowerCase();
}
