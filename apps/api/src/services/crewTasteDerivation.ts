import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { categoryToTasteKey } from './tasteSignals';
import { track } from './analytics';

// TasteProfile.categoryAffinity is keyed by whatever a swipe's free-text `category` was —
// see submitTasteSwipes's own comment. Onboarding's own chip set (apps/web/src/lib/interests.ts
// INTERESTS) is broader and looser than the real ExperienceCategory enum (it includes things
// like "pubs & drinks", "days out", "markets", "family" that don't map 1:1 onto a category), so
// most real affinity keys do NOT safely convert into a `categoryPreferences` hard filter — only
// the ones that exactly match a real category's own taste-key (categoryToTasteKey's own map,
// inverted here) do. Anything else is silently ignored for CATEGORY derivation — never guessed
// at — which is exactly right: `interestPreferences` (via TasteProfile.interestAffinity, the
// separate taxonomy-aligned mechanism `/users/me/taste/interests` writes) is the real, precise
// lever for onboarding's broader/looser categories anyway.
const CATEGORY_SLUG_TO_ENUM: Record<string, string> = Object.fromEntries(
  ['LIVE_MUSIC', 'CLUBBING', 'RESTAURANT', 'BAR', 'COMEDY', 'THEATRE', 'CINEMA', 'ART_CULTURE', 'SPORT', 'FITNESS', 'FESTIVAL', 'DAY_ACTIVITY', 'COMMUNITY'].map(
    (category) => [categoryToTasteKey(category), category],
  ),
);

/**
 * The Crew-E "first value" problem (docs/DECISIONS.md#crew-first-value): a Crew's automatic
 * recommendations were gated on `preferencesSetAt`, which could ONLY be stamped by a person
 * explicitly completing the taste step. A real Crew — created, invite link already shared,
 * members already joined — could sit in `preferences_not_set` forever if that one step never
 * got finished, with no path back to value that didn't require someone to notice a banner and
 * act on it. This module is the safety net: a genuinely safe, evidence-based way to infer a
 * Crew's shared taste from its own members' real TasteProfile data (built from their own
 * onboarding swipes — not invented, not a guess), so a realistic Crew reaches its first
 * recommendation without anyone having to manually rescue the setup.
 *
 * This is deliberately NOT a union of everyone's likes and NOT a plain average — either would
 * risk sending a highly conflicted Crew something one enthusiastic member loves and another
 * has explicitly said they dislike (or, just as bad, something ONLY one member has any opinion
 * on at all, with everyone else silent), which is a worse first impression than sending nothing.
 * Three rules keep this safe:
 *
 *  1. VETO — any member with a real, meaningfully negative affinity for a category/interest
 *     excludes it outright, no matter how much everyone else likes it. A derived preference can
 *     only ever be something no one in the Crew has said they dislike.
 *  2. REAL AGREEMENT, not one enthusiast — for a Crew of 2+ members, a preference needs a
 *     genuine positive opinion from at least 2 DIFFERENT members, not just one person with
 *     everyone else silent (silence is neutral, never counted as support). Real onboarding data
 *     is sparse — most people only swipe a handful of things — so without this rule, "no one
 *     objects" alone would let almost every member's individual taste leak through as if it
 *     were shared, which is exactly the "average everyone's interests together" failure mode
 *     this whole module exists to avoid. A brand-new Crew with only 1 member is the one
 *     exception — that member's own real taste IS the only signal there is yet, so 1 real
 *     opinion is enough (and gets safely refined the moment a 2nd member's own taste is known).
 *  3. GENUINE LEAN, not raw sum — among the members who share a real opinion, the AVERAGE must
 *     clear a real positive bar, so a lukewarm shared "open to it" can't outrank a smaller
 *     number of genuinely enthusiastic shared picks.
 *
 * For a genuinely conflicted Crew (the mission's own example: football/boxing vs. restaurants/
 * theatre vs. live music/comedy — every interest held by exactly one member, zero real overlap
 * between any two), all three rules correctly produce an EMPTY result —
 * `deriveCrewTasteFromMembers` returns null, and the Crew simply stays ungated-but-still-
 * signal-less rather than getting a forced, incoherent pick built from whichever member's taste
 * happened to iterate first. That's the intended outcome: "no obviously bad results" means it's
 * fine to still have nothing yet, never wrong to have something. See
 * crewRecommendations.ts#tryDeriveAndApplyCrewPreferences for where this gets (re-)applied, and
 * CrewRecommendationSettings.preferencesSource's own schema comment for how this differs from —
 * and never overrides — an explicit human pick.
 */

const POSITIVE_LEAN_THRESHOLD = 0.3;
const VETO_THRESHOLD = -0.3;
const MAX_DERIVED_CATEGORIES = 3;
const MAX_DERIVED_INTERESTS = 6;

export interface DerivedCrewTaste {
  categoryPreferences: string[];
  interestPreferences: string[];
}

export async function deriveCrewTasteFromMembers(crewId: string): Promise<DerivedCrewTaste | null> {
  const members = await prisma.crewMember.findMany({
    where: { crewId, status: 'ACTIVE' },
    select: { user: { select: { tasteProfile: { select: { categoryAffinity: true, interestAffinity: true } } } } },
  });

  const profiles = members
    .map((m) => m.user.tasteProfile)
    .filter((tp): tp is NonNullable<typeof tp> => Boolean(tp));
  if (profiles.length === 0) return null;

  const categoryPreferences = pickSafeOverlap(
    profiles.map((p) => remapToKnownCategories((p.categoryAffinity ?? {}) as Record<string, number>)),
    MAX_DERIVED_CATEGORIES,
  );
  const interestPreferences = pickSafeOverlap(
    profiles.map((p) => (p.interestAffinity ?? {}) as Record<string, number>),
    MAX_DERIVED_INTERESTS,
  );

  if (categoryPreferences.length === 0 && interestPreferences.length === 0) return null;
  return { categoryPreferences, interestPreferences };
}

/**
 * The one writer of a 'DERIVED' CrewRecommendationSettings row — called from every real
 * (non-diagnostic) evaluation attempt (services/crewRecommendations.ts#generateRecommendationForCrewNow)
 * and from the manual "Find us something"/chat-suggest path (services/crewPreferencesGate.ts),
 * so a Crew never has to wait specifically for the automatic sweep to self-heal, nor does a
 * member get a hard "preferences not set" error a manual request could have safely resolved
 * itself. Deliberately self-contained (its own upsert, not services/crewRecommendations.ts#
 * getOrCreateSettings) to avoid a circular import — crewRecommendations.ts already imports
 * services/match.ts, which imports crewPreferencesGate.ts, which needs this function too; see
 * getOrCreateSettings's own comment for the identical P2002-race pattern this mirrors.
 *
 * Returns true only the moment a Crew's preferences get stamped for the very first time (never
 * set before, explicit or derived) — callers use that to grant this pass the same "never come up
 * empty" guarantee an explicit first-set already gets. A Crew whose preferences are already
 * DERIVED gets silently refined (as more members join, or their own taste data changes) without
 * re-triggering that guarantee — normal cadence picks up a refined pick on its own. Never touches
 * a row whose preferencesSource is 'EXPLICIT' (or, for a row written before this column existed,
 * one with preferencesSetAt already set) — a real human decision always wins and is never
 * silently replaced.
 */
export async function tryDeriveAndApplyCrewPreferences(crewId: string): Promise<boolean> {
  let settings;
  try {
    settings = await prisma.crewRecommendationSettings.upsert({ where: { crewId }, update: {}, create: { crewId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      settings = await prisma.crewRecommendationSettings.findUniqueOrThrow({ where: { crewId } });
    } else {
      throw err;
    }
  }

  const source = settings.preferencesSource ?? (settings.preferencesSetAt ? 'EXPLICIT' : null);
  if (source === 'EXPLICIT') return false;

  const derived = await deriveCrewTasteFromMembers(crewId);
  if (!derived) return false;

  const unchanged =
    source === 'DERIVED' &&
    sameStringArray(settings.categoryPreferences, derived.categoryPreferences) &&
    sameStringArray(settings.interestPreferences, derived.interestPreferences);
  if (unchanged) return false;

  const stampingFirstTime = settings.preferencesSetAt === null;
  await prisma.crewRecommendationSettings.update({
    where: { crewId },
    data: {
      categoryPreferences: derived.categoryPreferences,
      interestPreferences: derived.interestPreferences,
      preferencesSource: 'DERIVED',
      ...(stampingFirstTime ? { preferencesSetAt: new Date() } : {}),
    },
  });
  if (stampingFirstTime) {
    void track(
      'CrewPreferencesSet',
      { crewId, source: 'DERIVED', categoryPreferences: derived.categoryPreferences, interestPreferences: derived.interestPreferences },
      { crewId },
    );
  }
  return stampingFirstTime;
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

/** See CATEGORY_SLUG_TO_ENUM's own comment — only affinity keys that exactly match a real
 *  category's taste-key survive; a bare 'pubs_drinks'/'days_out'/'markets' etc. simply
 *  contributes nothing to CATEGORY derivation (never a guessed mapping). */
function remapToKnownCategories(affinity: Record<string, number>): Record<string, number> {
  const remapped: Record<string, number> = {};
  for (const [key, score] of Object.entries(affinity)) {
    const category = CATEGORY_SLUG_TO_ENUM[key];
    if (category) remapped[category] = score;
  }
  return remapped;
}

function pickSafeOverlap(affinityMaps: Record<string, number>[], limit: number): string[] {
  const keys = new Set<string>();
  for (const map of affinityMaps) for (const key of Object.keys(map)) keys.add(key);

  // Rule 2's own minimum — a solo Crew's one real member IS the only signal there is yet; a
  // multi-member Crew needs real agreement from at least 2 of them, never just one enthusiast.
  const minAgreement = affinityMaps.length <= 1 ? 1 : 2;

  const safe: { key: string; lean: number }[] = [];
  for (const key of keys) {
    const scores = affinityMaps.map((map) => map[key] ?? 0);
    if (scores.some((s) => s <= VETO_THRESHOLD)) continue; // rule 1 — any real dislike vetoes it
    const positiveOpinions = scores.filter((s) => s > 0);
    if (positiveOpinions.length < minAgreement) continue; // rule 2 — real agreement, not one voice
    const lean = positiveOpinions.reduce((sum, s) => sum + s, 0) / positiveOpinions.length;
    if (lean >= POSITIVE_LEAN_THRESHOLD) safe.push({ key, lean }); // rule 3 — genuine shared lean
  }

  return safe
    .sort((a, b) => b.lean - a.lean)
    .slice(0, limit)
    .map((s) => s.key);
}
