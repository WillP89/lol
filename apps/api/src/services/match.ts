import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { MIN_PUBLISHABLE_QUALITY_SCORE } from './qualityScoring';
import { getMemberAvailability } from './availability';
import { track } from './analytics';
import type { Experience, TasteProfile } from '@prisma/client';

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

/**
 * The signature "Find us something" interaction. Layered, in order:
 *
 *  1. Hard constraints — publishable quality, not sold out, starts within the candidate
 *     window. Anything failing this never reaches scoring; it's a filter, not a penalty.
 *  2. Preference scoring — category affinity averaged across the crew's TasteProfiles,
 *     boosted by CrewDNA top categories when confidence is MEDIUM/HIGH.
 *  3. Context — under/over the crew's median comfortable spend, and how many members are
 *     free that evening (real AvailabilityWindow data, not simulated).
 *  4. Learned re-rank hook — currently a no-op; see LearnedRanker above.
 *
 * Every option keeps its `reasons[]` so the API response is explainable, not a black box
 * score — see brief §46.
 */
export async function findUsSomething(
  crewId: string,
  requestedByUserId: string,
): Promise<{ recommendationId: string; options: MatchOption[] }> {
  const [members, dna] = await Promise.all([
    prisma.crewMember.findMany({
      where: { crewId, status: 'ACTIVE' },
      include: { user: { include: { tasteProfile: true } } },
    }),
    prisma.crewDNA.findUnique({ where: { crewId } }),
  ]);

  const userIds = members.map((m) => m.userId);
  const tasteProfiles = members
    .map((m) => m.user.tasteProfile)
    .filter((tp): tp is TasteProfile => Boolean(tp));

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
    });
  }

  scored.sort((a, b) => b.matchScore - a.matchScore);
  const reranked = await identityRanker.rerank(scored.slice(0, 10), { crewId });
  const top = reranked.slice(0, RESULT_COUNT);

  const recommendation = await prisma.planRecommendation.create({
    data: {
      crewId,
      requestedByUserId,
      inputSnapshot: {
        memberCount: userIds.length,
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
function categoryToTasteKey(category: string): string {
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
