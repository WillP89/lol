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
      // synonym sitting inside it. Multi-word synonyms (e.g. "hip-hop/rap" normalised) still work
      // as a plain substring check since both sides are already normalised the same way.
      if (text.includes(syn) || syn.includes(text)) {
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
  return scoped.filter((interest) => interest.synonyms.some((syn) => text.includes(syn) || syn.includes(text)));
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
    create: { userId, categoryAffinity: {}, interestAffinity: next },
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
    create: { userId, categoryAffinity: {}, freeTextSignals: signals as unknown as object[], interestAffinity: affinity },
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
    create: { userId, categoryAffinity: {}, categoryBudget: current },
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

export { TASTE_TAXONOMY };
