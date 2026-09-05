import { prisma } from '../lib/prisma';
import { MIN_PUBLISHABLE_QUALITY_SCORE } from './qualityScoring';
import { ensureInventory } from './inventorySync';
import { evaluateTasteRelevance, experienceInterestTags, categoryToTasteKey, type FreeTextSignal, type TasteRelevance } from './tasteSignals';
import { dedupeNearDuplicates } from './entityResolution';
import { haversineMiles } from '../lib/geo';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { interestLabel } from '@plot/shared';
import type { Experience, Venue } from '@prisma/client';

/**
 * HOME = ME. The individual-facing counterpart to services/match.ts (which is CREW = US —
 * see that file's own header). Two deliberately separate scorers, not one generalised function,
 * because "what should I do" and "what should this specific group of people agree to do" are
 * different questions with different inputs (no crew-member availability check here; no crew
 * preferences/DNA; a Crew's collective learning bias never leaks into one member's own Home) —
 * see docs/DECISIONS.md#personal-home.
 *
 * Two-stage model, not one scoring pass that hopes relevant things float upward:
 *   STAGE A — eligibility (services/tasteSignals.ts#evaluateTasteRelevance, shared with Explore's
 *   own filter so "relevant" means one thing everywhere, not two definitions drifting apart). An
 *   Experience that fails this is not merely ranked low — it is REMOVED from every personalised
 *   section. Only `exploration` (below) is ever allowed to contain a non-eligible item, and only
 *   in a small, separately-labelled way.
 *   STAGE B — ranking within the eligible set: matched-interest strength, category affinity,
 *   free-text match, budget fit, distance, quality/freshness tiebreaker. Every contributing
 *   signal is recorded as a real, explainable `reason` — never a fabricated "popular with people
 *   like you" (see this file's own scoreForIndividual, and docs/DECISIONS.md#personal-home).
 *
 * A brand-new account with no taste signal at all gets `personalized: false` and a single
 * honest "worth a look nearby" section (quality/freshness only) — never a page that CLAIMS to be
 * personal when there's nothing yet to personalise from (same honesty rule Explore's own
 * `filteredToTaste` flag already uses).
 */

const HOME_WINDOW_DAYS = 21;
const HOME_CANDIDATE_LIMIT = 200;
const FOR_YOU_LIMIT = 6;
const WEEKEND_LIMIT = 6;
const INTEREST_ROW_LIMIT = 6;
const NEAR_YOU_LIMIT = 6;
const EXPLORATION_LIMIT = 3;
// Part 12's own rule: exploration only ever appears once there's enough real personal inventory
// to make clear it's a deliberate "try something different", not Plot quietly admitting it has
// nothing relevant to show.
const MIN_FOR_YOU_TO_SHOW_EXPLORATION = 3;
// A specific interest needs real, deliberate positive signal (roughly "like" or stronger — see
// tasteSignals.ts's STRENGTH_WEIGHT: love=1, like=0.6, open=0.2) to earn its own named row on
// Home — "open" alone is too weak a signal to justify a whole section built around it.
const INTEREST_ROW_THRESHOLD = 0.5;

// Carries `listings` too (not just `venue`) for the same reason explore.ts's own identical type
// does: Home's own detail view needs somewhere to point "view full details & pricing" at, and
// that's ProviderListing's field, not Experience's own. Real, reported bug this fixes — Home
// cards used to link to a generic /explore page with no way to see the actual event they came
// from, let alone send it to a specific Crew from there.
type ExperienceWithVenue = Experience & { venue: Venue | null; listings: { externalUrl: string }[] };

// A small, Home-specific label set for the category-level reason line only ("Because you're
// into Live music") — the specific-interest reason (matchedInterestId) is almost always the more
// precise one when both are available; see scoreForIndividual's own ordering.
const CATEGORY_LABEL: Record<string, string> = {
  LIVE_MUSIC: 'live music', CLUBBING: 'clubbing', RESTAURANT: 'food', BAR: 'bars & drinks',
  COMEDY: 'comedy', THEATRE: 'theatre', CINEMA: 'cinema', ART_CULTURE: 'art & culture',
  SPORT: 'sport', FITNESS: 'fitness', FESTIVAL: 'festivals', DAY_ACTIVITY: 'days out', COMMUNITY: 'local events',
};

export interface HomeReason {
  code: string;
  label: string;
}

export interface HomeItem {
  experience: ExperienceWithVenue;
  score: number;
  reasons: HomeReason[];
  distanceMiles: number | null;
  /** Only present when the caller asked for it (Part 19's recommendation debugger) — the raw
   *  scoring inputs behind `score`/`reasons`, never shipped to a production client by default.
   *  See routes/home.ts's own gate on who can request this. */
  debug?: {
    categoryAffinity: number;
    matchedInterestId: string | null;
    matchedInterestAffinity: number;
    matchedFreeText: string | null;
    qualityScore: number;
    eligible: boolean;
  };
}

export interface HomeInterestRow {
  interestId: string;
  label: string;
  items: HomeItem[];
}

export interface PersonalHome {
  /** False for a brand-new account with no real taste signal yet — every field below is then a
   *  single honest "worth a look nearby" fallback (quality/freshness only), never a page
   *  pretending to already know someone it has no signal for. */
  personalized: boolean;
  forYou: HomeItem[];
  thisWeekend: HomeItem[];
  interestRows: HomeInterestRow[];
  nearYou: HomeItem[];
  /** Small, separate, only ever populated once `forYou` has real depth — see
   *  MIN_FOR_YOU_TO_SHOW_EXPLORATION. Every item here FAILED Stage A eligibility on purpose;
   *  the client is responsible for labelling this distinctly ("Try something different"), never
   *  folding it into a personalised section. */
  exploration: HomeItem[];
  /** Real, honest copy for "nothing eligible right now" — never silently backfilled with
   *  irrelevant filler to make the page look fuller (Part 16). Null when there's real content. */
  emptyMessage: string | null;
}

interface ScoreContext {
  categoryAffinity: Record<string, number>;
  interestAffinity: Record<string, number>;
  freeTextSignals: FreeTextSignal[];
  categoryBudget: Record<string, { minMinor: number; maxMinor: number }>;
  budgetMinMinor: number;
  budgetMaxMinor: number;
  homeLat: number | null;
  homeLng: number | null;
}

function effectiveBudgetFor(category: string, ctx: ScoreContext): { minMinor: number; maxMinor: number } | null {
  const perCategory = ctx.categoryBudget[category];
  if (perCategory) return perCategory;
  if (ctx.budgetMaxMinor > 0) return { minMinor: ctx.budgetMinMinor, maxMinor: ctx.budgetMaxMinor };
  return null;
}

function poundsFrom(minor: number): string {
  const pounds = minor / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

/** THE explainability layer (Part 17: "every recommendation should be explainable... never
 *  generate fake explanations"). Every reason string here is derived directly from a real,
 *  computed signal — nothing is templated from a guess. */
function scoreForIndividual(
  experience: ExperienceWithVenue,
  ctx: ScoreContext,
  includeDebug: boolean,
): HomeItem {
  const relevance: TasteRelevance = evaluateTasteRelevance(
    { category: experience.category, subcategories: experience.subcategories, name: experience.name, description: experience.description },
    ctx.categoryAffinity,
    ctx.interestAffinity,
    ctx.freeTextSignals,
  );

  let score = 0;
  const reasons: HomeReason[] = [];

  if (relevance.matchedInterestId && relevance.matchedInterestAffinity > 0) {
    score += relevance.matchedInterestAffinity * 45;
    reasons.push({ code: 'interest_match', label: `Because you like ${interestLabel(relevance.matchedInterestId)}` });
  } else if (relevance.categoryAffinity > 0.3) {
    score += relevance.categoryAffinity * 30;
    reasons.push({ code: 'category_affinity', label: `Because you're into ${CATEGORY_LABEL[experience.category] ?? experience.category.toLowerCase()}` });
  } else if (relevance.categoryAffinity > 0) {
    score += relevance.categoryAffinity * 30;
  }

  if (relevance.matchedFreeText) {
    score += 25;
    reasons.push({ code: 'free_text_match', label: `You said "${relevance.matchedFreeText}"` });
  }

  const budget = effectiveBudgetFor(experience.category, ctx);
  if (budget && experience.priceMinMinor !== null) {
    if (experience.priceMinMinor <= budget.maxMinor) {
      score += 10;
      reasons.push({ code: 'under_budget', label: `Matches your ${poundsFrom(budget.minMinor)}–${poundsFrom(budget.maxMinor)} budget` });
    } else if (experience.priceMinMinor > budget.maxMinor * 1.5) {
      score -= 8; // soft penalty, never a hard exclusion — someone might still splurge
    }
  } else if (experience.priceMinMinor === 0) {
    reasons.push({ code: 'free', label: 'Free' });
  }

  let distanceMiles: number | null = null;
  if (ctx.homeLat !== null && ctx.homeLng !== null && experience.venue) {
    distanceMiles = haversineMiles(ctx.homeLat, ctx.homeLng, experience.venue.latitude, experience.venue.longitude);
    score += Math.max(0, 10 - distanceMiles / 5);
    const rounded = Math.round(distanceMiles);
    reasons.push({ code: 'distance', label: rounded <= 1 ? 'Under a mile away' : `${rounded} miles away` });
  }

  // A small, honest tiebreaker — never the deciding factor, just resolves ties between
  // otherwise-equal matches toward the more complete/fresher listing.
  score += experience.qualityScore * 0.05;

  return {
    experience,
    score: Math.round(score * 10) / 10,
    reasons,
    distanceMiles,
    ...(includeDebug
      ? {
          debug: {
            categoryAffinity: relevance.categoryAffinity,
            matchedInterestId: relevance.matchedInterestId,
            matchedInterestAffinity: relevance.matchedInterestAffinity,
            matchedFreeText: relevance.matchedFreeText,
            qualityScore: experience.qualityScore,
            eligible: relevance.eligible,
          },
        }
      : {}),
  };
}

function isEligible(item: HomeItem, ctx: ScoreContext): boolean {
  // Re-derive rather than store — evaluateTasteRelevance is cheap (in-memory taxonomy lookups,
  // no I/O) and keeping HomeItem's own shape free of a private "eligible" field means the debug
  // flag above is the only place that fact is ever exposed, not a second untyped field every
  // caller has to know to ignore.
  return evaluateTasteRelevance(
    { category: item.experience.category, subcategories: item.experience.subcategories, name: item.experience.name, description: item.experience.description },
    ctx.categoryAffinity,
    ctx.interestAffinity,
    ctx.freeTextSignals,
  ).eligible;
}

/** This weekend = the coming Friday through Sunday inclusive, or — if today already falls in
 *  that window — starting today, not next week's. Deliberately simple (no timezone-of-venue
 *  handling beyond the app's own Europe/London convention, same as everywhere else in Plot). */
function weekendRange(now: Date): { start: Date; end: Date } {
  const day = now.getDay(); // 0 Sun .. 6 Sat
  const start = new Date(now);
  if (day !== 0 && day !== 6) {
    start.setDate(start.getDate() + ((5 - day + 7) % 7)); // next Friday
  }
  start.setHours(0, 0, 0, 0);
  const startDay = start.getDay();
  const end = new Date(start);
  end.setDate(start.getDate() + (startDay === 0 ? 0 : 7 - startDay));
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export async function buildPersonalHome(userId: string, opts: { debug?: boolean } = {}): Promise<PersonalHome> {
  const [profile, tasteProfile] = await Promise.all([
    prisma.profile.findUnique({ where: { userId }, select: { homeCity: true, homeLat: true, homeLng: true } }),
    prisma.tasteProfile.findUnique({
      where: { userId },
      select: { categoryAffinity: true, interestAffinity: true, freeTextSignals: true, categoryBudget: true, budgetMinMinor: true, budgetMaxMinor: true },
    }),
  ]);

  const city = profile?.homeCity ?? UK_FALLBACK_CENTER.name;
  await ensureInventory(city);

  const ctx: ScoreContext = {
    categoryAffinity: (tasteProfile?.categoryAffinity as Record<string, number> | undefined) ?? {},
    interestAffinity: (tasteProfile?.interestAffinity as Record<string, number> | undefined) ?? {},
    freeTextSignals: (tasteProfile?.freeTextSignals as unknown as FreeTextSignal[] | undefined) ?? [],
    categoryBudget: (tasteProfile?.categoryBudget as Record<string, { minMinor: number; maxMinor: number }> | undefined) ?? {},
    budgetMinMinor: tasteProfile?.budgetMinMinor ?? 0,
    budgetMaxMinor: tasteProfile?.budgetMaxMinor ?? 0,
    homeLat: profile?.homeLat ?? null,
    homeLng: profile?.homeLng ?? null,
  };
  const hasSignal =
    Object.values(ctx.categoryAffinity).some((v) => v > 0) ||
    Object.values(ctx.interestAffinity).some((v) => v > 0) ||
    ctx.freeTextSignals.length > 0;

  const windowStart = new Date();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + HOME_WINDOW_DAYS);
  // Real bug this closes, caught by this file's own acceptance test (test/personalHome.test.ts):
  // without this, "the next N days" silently means "N days from THIS EXACT TIMESTAMP", so an
  // event pinned to a fixed evening time on the LAST day of the window would drop in and out of
  // eligibility depending purely on what time of day this function happened to run — never a
  // fact about the event itself. See match.ts/explore.ts's identical fix for the same reason.
  windowEnd.setHours(23, 59, 59, 999);

  const rows = (await prisma.experience.findMany({
    where: {
      qualityScore: { gte: MIN_PUBLISHABLE_QUALITY_SCORE },
      bookingStatus: { not: 'SOLD_OUT' },
      startsAt: { gte: windowStart, lte: windowEnd },
      venue: { city },
    },
    include: { venue: true, listings: { select: { externalUrl: true }, take: 1, orderBy: { lastRefreshedAt: 'desc' } } },
    orderBy: { startsAt: 'asc' },
    take: HOME_CANDIDATE_LIMIT,
  })) as ExperienceWithVenue[];

  const deduped = dedupeNearDuplicates(rows, (e) => ({ name: e.name, category: e.category, startsAt: e.startsAt }));
  const scored = deduped.map((e) => scoreForIndividual(e, ctx, opts.debug === true));

  if (!hasSignal) {
    // Honest fallback for a brand-new account: quality/freshness only, explicitly NOT claimed as
    // personal (see `personalized` on the response) — same rule Explore's own `filteredToTaste`
    // flag already uses for the identical situation.
    const fallback = [...scored].sort((a, b) => b.score - a.score).slice(0, FOR_YOU_LIMIT);
    return {
      personalized: false,
      forYou: fallback,
      thisWeekend: [],
      interestRows: [],
      nearYou: [],
      exploration: [],
      emptyMessage: fallback.length === 0 ? "Nothing nearby yet — check back soon, or explore further out." : null,
    };
  }

  const eligible = scored.filter((s) => isEligible(s, ctx)).sort((a, b) => b.score - a.score);

  const forYou = eligible.slice(0, FOR_YOU_LIMIT);

  const { start, end } = weekendRange(new Date());
  const thisWeekend = eligible.filter((s) => s.experience.startsAt >= start && s.experience.startsAt <= end).slice(0, WEEKEND_LIMIT);

  // One row per explicit strong interest, strongest affinity first — skipped entirely if there's
  // no real eligible inventory for it (Part 16: never a filler/empty row).
  const strongInterestIds = Object.entries(ctx.interestAffinity)
    .filter(([, v]) => v >= INTEREST_ROW_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const interestRows: HomeInterestRow[] = [];
  for (const interestId of strongInterestIds) {
    const items = eligible.filter((s) => matchesInterest(s, interestId, ctx)).slice(0, INTEREST_ROW_LIMIT);
    if (items.length > 0) interestRows.push({ interestId, label: interestLabel(interestId), items });
  }

  const nearYou =
    ctx.homeLat !== null && ctx.homeLng !== null
      ? [...eligible].filter((s) => s.distanceMiles !== null).sort((a, b) => (a.distanceMiles ?? 0) - (b.distanceMiles ?? 0)).slice(0, NEAR_YOU_LIMIT)
      : [];

  // Explicit, controlled exploration (Part 12) — real candidates that genuinely failed Stage A,
  // never mixed into any section above, and only surfaced once there's enough real personal
  // content that this reads as a deliberate offer, not Plot admitting it came up short.
  const exploration =
    forYou.length >= MIN_FOR_YOU_TO_SHOW_EXPLORATION
      ? [...scored].filter((s) => !isEligible(s, ctx)).sort((a, b) => b.score - a.score).slice(0, EXPLORATION_LIMIT)
      : [];

  return {
    personalized: true,
    forYou,
    thisWeekend,
    interestRows,
    nearYou,
    exploration,
    emptyMessage: eligible.length === 0 ? "That's everything we'd genuinely recommend nearby right now." : null,
  };
}

/** Re-checks whether a specific interest id was the (or a) matching tag for this item — used
 *  when building interest rows, since `scoreForIndividual` only records the SINGLE strongest
 *  matched interest per item (`matchedInterestId`), but an item can legitimately carry more than
 *  one real tag (e.g. a gig that's both "hip_hop" and "small_venues"). Falls back to a fresh
 *  `evaluateTasteRelevance` call scoped to this one interest by temporarily zeroing every other
 *  interest's affinity, so a strong OTHER interest can never crowd this row's own membership
 *  test — cheap (in-memory only) and keeps HomeItem's own shape from needing a full tag list. */
function matchesInterest(item: HomeItem, interestId: string, ctx: ScoreContext): boolean {
  const isolated = evaluateTasteRelevance(
    { category: item.experience.category, subcategories: item.experience.subcategories, name: item.experience.name, description: item.experience.description },
    {},
    { [interestId]: ctx.interestAffinity[interestId] ?? 0 },
    [],
  );
  return isolated.matchedInterestId === interestId && isolated.matchedInterestAffinity > 0;
}

const FEEDBACK_DELTA: Record<HomeFeedbackAction, number> = {
  // Part 18's own distinction, applied to an INDIVIDUAL's own TasteProfile this time (not a
  // Crew's shared learning bias — see match.ts#buildLearningBias for that sibling): a save is a
  // real, meaningful positive; "not for me" is a real, meaningful negative (stronger than a
  // passing dismissal); a bare pass nudges only slightly, since dismissing one specific card is
  // not the same as rejecting the whole category forever. `view` carries no taste signal at all
  // — looking at something isn't the same as having an opinion about it.
  save: 0.3,
  not_for_me: -0.35,
  pass: -0.1,
  view: 0,
};
export type HomeFeedbackAction = 'save' | 'not_for_me' | 'pass' | 'view';

/** THE feedback loop Part 18 asks for: a tap on a Home card nudges this person's OWN
 *  TasteProfile immediately (never a Crew's — Home = ME, so Home feedback stays scoped to the
 *  individual who gave it), bounded to [-1, 1] the same way match.ts's Crew-level learning bias
 *  is bounded, for the same reason: one strong reaction should move the needle, not zero out a
 *  whole category permanently. Nudges BOTH the Experience's own category and every real interest
 *  tag it carries (experienceInterestTags — never a fabricated tag), so "not for me" on a specific
 *  drill night can cool "drill" specifically without necessarily cooling "hip-hop & rap" as a
 *  whole unless enough separate signals do that on their own over time. */
export async function applyHomeFeedback(userId: string, experienceId: string, action: HomeFeedbackAction): Promise<void> {
  const delta = FEEDBACK_DELTA[action];
  if (delta === 0) return; // 'view' — tracked by the caller's own analytics event, no taste write

  const experience = await prisma.experience.findUnique({
    where: { id: experienceId },
    select: { category: true, subcategories: true, name: true, description: true },
  });
  if (!experience) return; // a stale/removed experience id — nothing to learn from

  const existing = await prisma.tasteProfile.findUnique({ where: { userId } });
  const categoryAffinity = { ...((existing?.categoryAffinity as Record<string, number> | undefined) ?? {}) };
  const interestAffinity = { ...((existing?.interestAffinity as Record<string, number> | undefined) ?? {}) };

  const catKey = categoryToTasteKey(experience.category);
  categoryAffinity[catKey] = clamp(-1, 1, (categoryAffinity[catKey] ?? 0) + delta);
  for (const tag of experienceInterestTags(experience)) {
    interestAffinity[tag] = clamp(-1, 1, (interestAffinity[tag] ?? 0) + delta);
  }

  await prisma.tasteProfile.upsert({
    where: { userId },
    update: { categoryAffinity, interestAffinity },
    create: { userId, categoryAffinity, interestAffinity },
  });
}

function clamp(min: number, max: number, v: number): number {
  return Math.max(min, Math.min(max, v));
}
