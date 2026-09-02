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
import { experienceInterestTags, experienceMatchesFreeText, type FreeTextSignal } from './tasteSignals';
import { interestLabel } from '@plot/shared';
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
  const [members, dna, recommendationSettings, pastResponses] = await Promise.all([
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
    prisma.crewRecommendationSettings.findUnique({ where: { crewId }, select: { categoryPreferences: true, interestPreferences: true } }),
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

  const dnaTopCategories = new Set((dna?.topCategories as string[] | undefined) ?? []);
  const radiusMeters = opts.radiusMetersOverride
    ?? (medianOf(tasteProfiles.map((tp) => tp.travelRadiusMeters).filter((r) => r > 0)) || DEFAULT_RADIUS_METERS);
  const radiusMiles = radiusMeters / 1609.34;

  const scored: MatchOption[] = [];
  for (const experience of candidates) {
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

    // A Crew's own explicit pick blends WITH (never replaces) member-derived taste — the two
    // reasons above already reflect who's actually in the Crew; this is the group deliberately
    // saying "we're specifically into this", which counts as a taste signal in its own right
    // (see hasTasteSignal in crewRecommendations.ts) even for a Crew whose members haven't swiped
    // enough yet to generate real affinity/DNA signal on their own.
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
    if (experience.venue && memberCoords.length > 0) {
      const distances = memberCoords.map((c) => haversineMiles(c.homeLat, c.homeLng, experience.venue!.latitude, experience.venue!.longitude));
      const nearestMiles = Math.min(...distances);
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
