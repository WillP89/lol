import { prisma } from '../lib/prisma';
import { track } from './analytics';
import { TASTE_INTEREST_INDEX, TASTE_TAXONOMY, interestsForCategory, type TasteInterest } from '@plot/shared';
import type { TasteProfile } from '@prisma/client';

/**
 * THE PERSONALISATION-ENGINE PASS — the layer underneath TasteProfile.categoryAffinity that
 * actually gives Plot specific, usable signal ("UK garage", not "music"). See
 * @plot/shared/tasteTaxonomy.ts for the fixed taxonomy this all keys off, and
 * docs/DECISIONS.md#personalisation-engine for the full design rationale. Three jobs live here:
 *
 *  1. Turning a person's tap on a specific interest into a stored affinity (`applyInterestUpdates`).
 *  2. Turning free text ("Fred again..", "small indie gigs") into either a matched taxonomy
 *     interest or a preserved raw signal — never a fabricated match (`interpretFreeText`).
 *  3. Turning a real Experience's own provider data (subcategories, name, description) into the
 *     same interest-id space, so scoring can actually compare "what this person likes" against
 *     "what this event is" (`experienceInterestTags`) — this is the missing link that made the
 *     taxonomy real rather than decorative: providers already send subcategory strings (Ticketmaster
 *     genres, Skiddle event codes, OSM cuisine tags — see providers/live/*.ts), they just were
 *     never matched against anything before this pass.
 */

const STRENGTH_WEIGHT: Record<'love' | 'like' | 'open' | 'not_for_me', number> = {
  love: 1,
  like: 0.6,
  open: 0.2,
  not_for_me: -1,
};
export type TasteStrength = keyof typeof STRENGTH_WEIGHT;

// Real bug found via live verification: creating a TasteProfile row here for the first time
// (someone using "Tune my Plot" before ever completing onboarding's swipe step) with only the
// schema's bare column defaults (budgetMaxMinor: 0, travelRadiusMeters: 6000) silently read back
// as "Free" / "Nearby" on Profile — indistinguishable from a real, deliberate choice, when it was
// actually just "never set". These match Profile's own UI defaults (apps/web/.../profile/page.tsx)
// so a brand-new row reads the same as what the page was already showing before anyone touched it.
const DEFAULT_BUDGET_MAX_MINOR = 3000;
const DEFAULT_TRAVEL_RADIUS_METERS = 16000;

/** Lowercase, strip punctuation to spaces, collapse whitespace — deliberately simple
 *  normalisation so matching stays explainable (grep-able, not a black box), not real NLP. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every interest whose label or a synonym appears in (or IS) the normalised text, scanning the
 *  whole taxonomy — free text isn't scoped to one territory the way a provider's own category-
 *  tagged subcategory string is (see `matchInterestsForCategory` below). */
function matchInterests(rawText: string): TasteInterest[] {
  const text = normalize(rawText);
  if (!text) return [];
  const hits: TasteInterest[] = [];
  for (const { interest } of TASTE_INTEREST_INDEX.values()) {
    for (const syn of interest.synonyms) {
      // Word-boundary-ish substring check both ways: "garage" should match "uk garage"'s synonym
      // list, and a longer typed phrase ("small indie gigs") should match the shorter "indie"
      // synonym sitting inside it. Real bug this normalize() call fixes, caught by
      // test/personalHome.test.ts: a synonym straight from @plot/shared/tasteTaxonomy.ts (e.g.
      // "stand-up", "hip-hop/rap") keeps its own punctuation verbatim — it is NOT run through
      // this file's `normalize()` at authoring time, unlike `text` above. A provider's raw
      // subcategory tag, by this whole codebase's own snake_case convention (`stand_up`,
      // `hip_hop`), normalizes its underscore to a space ("stand up") — which then can never
      // match the synonym's un-normalized hyphen ("stand-up") on either side of an `.includes()`
      // check, silently failing every taxonomy entry whose label/synonym contains punctuation.
      // Normalizing the synonym here, at comparison time, is what actually makes "both sides
      // normalised the same way" true rather than just asserted.
      const normalizedSyn = normalize(syn);
      if (text.includes(normalizedSyn) || normalizedSyn.includes(text)) {
        hits.push(interest);
        break;
      }
    }
  }
  return hits;
}

/** Same idea, scoped to the interests valid for one Experience category — used for provider
 *  subcategory strings, where we already know the category and scoping avoids a cross-territory
 *  false positive (a restaurant's "market" cuisine tag should never match MUSIC's territory). */
function matchInterestsForCategory(rawText: string, category: string): TasteInterest[] {
  const text = normalize(rawText);
  if (!text) return [];
  const scoped = interestsForCategory(category);
  // See matchInterests' own comment on why the synonym itself needs normalizing too, not just
  // the input text — this is the same fix, applied to the category-scoped path (provider
  // subcategory tags) that surfaced the bug in the first place.
  return scoped.filter((interest) => interest.synonyms.some((syn) => { const n = normalize(syn); return text.includes(n) || n.includes(text); }));
}

export interface FreeTextSignal {
  text: string;
  matchedInterestIds: string[];
  confidence: 'high' | 'low';
  addedAt: string;
}

/** THE HONESTY RULE the brief is explicit about: if "Fred again.." doesn't map onto anything in
 *  the fixed taxonomy (it doesn't — it's an artist, not a genre), this returns zero matches and
 *  `confidence: 'low'` rather than guessing. The raw text is still preserved by the caller
 *  (`addFreeTextSignal`) and used for literal matching against an Experience's own name/description
 *  later (see `experienceInterestTags`) — so "Fred again.." can still surface an actual Fred
 *  again.. event by name, just never claims a fake genre match to get there. */
export function interpretFreeText(rawText: string): { matchedInterestIds: string[]; confidence: 'high' | 'low' } {
  const matches = matchInterests(rawText);
  return { matchedInterestIds: [...new Set(matches.map((m) => m.id))], confidence: matches.length > 0 ? 'high' : 'low' };
}

/** Merges (never overwrites) taps from the "Tune My Plot" editor into TasteProfile.interestAffinity
 *  — unlike the bulk onboarding swipe write (services/taste.ts#submitTasteSwipes), this gets
 *  called repeatedly over a user's lifetime, one or a few interests at a time, so a partial
 *  update must never clobber everything else already set. */
export async function applyInterestUpdates(
  userId: string,
  updates: { interestId: string; strength: TasteStrength }[],
): Promise<TasteProfile> {
  const existing = await prisma.tasteProfile.findUnique({ where: { userId } });
  const current = (existing?.interestAffinity as Record<string, number> | undefined) ?? {};
  const next = { ...current };
  for (const u of updates) {
    if (!TASTE_INTEREST_INDEX.has(u.interestId)) continue; // never store an id the taxonomy doesn't recognise
    next[u.interestId] = STRENGTH_WEIGHT[u.strength];
  }
  const profile = await prisma.tasteProfile.upsert({
    where: { userId },
    update: { interestAffinity: next },
    create: { userId, categoryAffinity: {}, interestAffinity: next, budgetMaxMinor: DEFAULT_BUDGET_MAX_MINOR, travelRadiusMeters: DEFAULT_TRAVEL_RADIUS_METERS },
  });
  await track('TasteInterestUpdated', { userId, count: updates.length }, { userId });
  return profile;
}

/** Adds one free-text signal, preserving the raw string always, and — only where confidence is
 *  genuinely high (a real taxonomy match, not a guess) — also nudging that matched interest's
 *  affinity up, so a person who types "UK garage" gets the same scoring benefit as someone who
 *  tapped it in the picker, without making them do both. */
export async function addFreeTextSignal(userId: string, rawText: string): Promise<TasteProfile> {
  const text = rawText.trim().slice(0, 120);
  if (!text) throw new Error('empty_signal');
  const { matchedInterestIds, confidence } = interpretFreeText(text);

  const existing = await prisma.tasteProfile.findUnique({ where: { userId } });
  const signals = ((existing?.freeTextSignals as unknown as FreeTextSignal[] | undefined) ?? []).filter(
    (s) => s.text.toLowerCase() !== text.toLowerCase(), // re-adding the same text just refreshes it
  );
  signals.unshift({ text, matchedInterestIds, confidence, addedAt: new Date().toISOString() });

  const affinity = { ...((existing?.interestAffinity as Record<string, number> | undefined) ?? {}) };
  if (confidence === 'high') {
    for (const id of matchedInterestIds) affinity[id] = Math.max(affinity[id] ?? 0, STRENGTH_WEIGHT.like);
  }

  const profile = await prisma.tasteProfile.upsert({
    where: { userId },
    update: { freeTextSignals: signals.slice(0, 40) as unknown as object[], interestAffinity: affinity },
    create: { userId, categoryAffinity: {}, freeTextSignals: signals as unknown as object[], interestAffinity: affinity, budgetMaxMinor: DEFAULT_BUDGET_MAX_MINOR, travelRadiusMeters: DEFAULT_TRAVEL_RADIUS_METERS },
  });
  await track('TasteFreeTextAdded', { userId, matched: matchedInterestIds.length > 0 }, { userId });
  return profile;
}

export async function removeFreeTextSignal(userId: string, text: string): Promise<void> {
  const existing = await prisma.tasteProfile.findUnique({ where: { userId } });
  if (!existing) return;
  const signals = ((existing.freeTextSignals as unknown as FreeTextSignal[] | undefined) ?? []).filter(
    (s) => s.text.toLowerCase() !== text.toLowerCase(),
  );
  await prisma.tasteProfile.update({ where: { userId }, data: { freeTextSignals: signals as unknown as object[] } });
}

export async function setCategoryBudget(
  userId: string,
  category: string,
  range: { minMinor: number; maxMinor: number } | null,
): Promise<TasteProfile> {
  const existing = await prisma.tasteProfile.findUnique({ where: { userId } });
  const current = { ...((existing?.categoryBudget as Record<string, { minMinor: number; maxMinor: number }> | undefined) ?? {}) };
  if (range) current[category] = range;
  else delete current[category];
  return prisma.tasteProfile.upsert({
    where: { userId },
    update: { categoryBudget: current },
    create: { userId, categoryAffinity: {}, categoryBudget: current, budgetMaxMinor: DEFAULT_BUDGET_MAX_MINOR, travelRadiusMeters: DEFAULT_TRAVEL_RADIUS_METERS },
  });
}

/** The other half of the link: what specific interests does THIS Experience actually represent?
 *  Real provider data first (subcategories — Ticketmaster genres, Skiddle event codes, OSM
 *  cuisine — scoped to the Experience's own category so a match is always plausible), then a
 *  bounded keyword scan of the name/description for anything the subcategory data missed (e.g. a
 *  Ticketmaster event whose genre is generic "Music" but whose name says "UK Garage Classics").
 *  Never invents a tag with no textual basis in the Experience's own real data. */
export function experienceInterestTags(experience: {
  category: string;
  subcategories: unknown;
  name: string;
  description: string;
}): string[] {
  const ids = new Set<string>();
  const subcats = Array.isArray(experience.subcategories) ? (experience.subcategories as string[]) : [];
  for (const raw of subcats) {
    for (const interest of matchInterestsForCategory(raw, experience.category)) ids.add(interest.id);
  }
  // Keyword scan is deliberately scoped to interests valid for this Experience's own category —
  // "market" in a restaurant's description shouldn't light up an unrelated territory.
  const haystack = `${experience.name} ${experience.description}`.slice(0, 500);
  for (const interest of matchInterestsForCategory(haystack, experience.category)) ids.add(interest.id);
  return [...ids];
}

/** Does this Experience's own text literally contain a person's raw free-text signal (e.g. an
 *  artist name Plot's taxonomy has no genre entry for)? The one case a plain substring check is
 *  MORE honest than a taxonomy match — "Fred again.." either is or isn't in this event's name. */
export function experienceMatchesFreeText(experience: { name: string; description: string }, rawText: string): boolean {
  const needle = normalize(rawText);
  if (needle.length < 3) return false; // too short to mean anything reliably
  return normalize(experience.name).includes(needle) || normalize(experience.description).includes(needle);
}

/** TasteProfile.categoryAffinity keys are the free-text onboarding swipe categories (e.g.
 *  "clubbing", "live music"), which don't line up 1:1 with the Experience.category enum — this
 *  maps enum values to the closest onboarding key. A real mapping table grows with the taxonomy;
 *  this is deliberately a small, visible function rather than buried inline. Lives here (not
 *  match.ts, which used to own it) so this file — the one place both Crew scoring (match.ts) and
 *  individual scoring (personalHome.ts) get their taxonomy logic from — has no reverse dependency
 *  on either of them; moving it avoided a circular import the moment personalHome.ts needed it
 *  too. */
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

export interface TasteRelevance {
  /** Stage-A eligibility (see docs/DECISIONS.md#personal-home): true the moment ANY real signal
   *  — category, a specific interest tag, or a literal free-text match — is positive. This is
   *  the ONE eligibility rule every individual-facing surface (Explore, Home) shares; Crew
   *  scoring (match.ts#scoreExperiencesForCrew) is deliberately separate — a Crew's own
   *  aggregate/DNA/preference signals mean something different from any one member's. */
  eligible: boolean;
  categoryAffinity: number;
  /** The single strongest matching specific interest, if any — not "some interest matched" but
   *  WHICH one, so a caller can build an honest "because you like UK garage" reason rather than
   *  a vague "matches your taste". */
  matchedInterestId: string | null;
  matchedInterestAffinity: number;
  matchedFreeText: string | null;
}

/** THE canonical "does this belong to this person at all" check — Stage A of the two-stage
 *  eligibility-then-ranking model (docs/DECISIONS.md#personal-home). Used by both
 *  services/explore.ts (Explore's own "only show what's relevant" filter) and
 *  services/personalHome.ts (Home's personal feed) so "relevant" means exactly one thing across
 *  the app, not two definitions that can quietly drift apart. An Experience is eligible the
 *  moment ANY of these is true: (1) its own category has positive affinity, (2) at least one of
 *  its real interest tags (experienceInterestTags below — provider subcategories + a scoped
 *  keyword scan, never invented) has positive affinity, or (3) it textually matches one of the
 *  viewer's own free-text signals. A negative/absent signal on all three is NOT eligible — this
 *  is a hard gate, not a soft reorder (see match.ts's own scorer for the softer, additive
 *  version Crew recommendations use instead). */
export function evaluateTasteRelevance(
  experience: { category: string; subcategories: unknown; name: string; description: string },
  categoryAffinity: Record<string, number>,
  interestAffinity: Record<string, number>,
  freeTextSignals: FreeTextSignal[],
): TasteRelevance {
  const catScore = categoryAffinity[categoryToTasteKey(experience.category)] ?? 0;

  let matchedInterestId: string | null = null;
  let matchedInterestAffinity = 0;
  for (const tag of experienceInterestTags(experience)) {
    const affinity = interestAffinity[tag] ?? 0;
    if (affinity > matchedInterestAffinity) {
      matchedInterestAffinity = affinity;
      matchedInterestId = tag;
    }
  }

  const freeTextHit = freeTextSignals.find((s) => experienceMatchesFreeText(experience, s.text));

  return {
    eligible: catScore > 0 || matchedInterestAffinity > 0 || Boolean(freeTextHit),
    categoryAffinity: catScore,
    matchedInterestId,
    matchedInterestAffinity,
    matchedFreeText: freeTextHit?.text ?? null,
  };
}

export { TASTE_TAXONOMY };
