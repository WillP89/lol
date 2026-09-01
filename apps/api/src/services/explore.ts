import { prisma } from '../lib/prisma';
import { MIN_PUBLISHABLE_QUALITY_SCORE } from './qualityScoring';
import { ensureInventory } from './inventorySync';
import { categoryToTasteKey } from './match';
import { dedupeNearDuplicates } from './entityResolution';

const EXPLORE_WINDOW_DAYS = 21;
const EXPLORE_LIMIT = 200;

/**
 * Backs the real Explore/map view — every result has real venue coordinates (see
 * `Venue.latitude`/`longitude`), unlike the CSS-drawn map in the founding-team demo. Same
 * quality/booking-status/date-window constraints as `findUsSomething`'s Layer 1, minus the
 * crew-specific scoring — this is a browse view, not a recommendation.
 *
 * `userId`, when given, personalises the ORDER (not the set — Explore stays fully browsable,
 * nothing is hidden from a member's own choice). Real bug found via testing (not assumed): this
 * previously took only a city, so onboarding taste swipes had zero visible effect anywhere in
 * Explore or Home's "worth a look nearby" strip, which both call this — exactly the "my
 * preferences didn't do anything" complaint. Higher-affinity categories now sort first within
 * the date window; same affinity tier falls back to chronological order, so "happening soon"
 * still surfaces rather than a total taste-only reshuffle. See docs/DECISIONS.md#explore-
 * personalisation.
 */
export async function listExploreExperiences(city: string, userId?: string) {
  await ensureInventory(city);

  const windowStart = new Date();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + EXPLORE_WINDOW_DAYS);

  const rows = await prisma.experience.findMany({
    where: {
      qualityScore: { gte: MIN_PUBLISHABLE_QUALITY_SCORE },
      bookingStatus: { not: 'SOLD_OUT' },
      startsAt: { gte: windowStart, lte: windowEnd },
      venue: { city },
    },
    include: { venue: true },
    orderBy: { startsAt: 'asc' },
    take: EXPLORE_LIMIT,
  });
  // Near-duplicate suppression (see entityResolution.ts#dedupeNearDuplicates) — kept in
  // chronological order, so the surviving representative of any cluster is whichever happens
  // soonest, same as the rest of this browse view. A real duplicate ("Jorja Smith DJ Set" twice,
  // a day apart, same venue family) should never reach the feed as two cards.
  const experiences = dedupeNearDuplicates(rows, (e) => ({ name: e.name, category: e.category, startsAt: e.startsAt }));

  if (!userId) return experiences;
  const tasteProfile = await prisma.tasteProfile.findUnique({ where: { userId }, select: { categoryAffinity: true } });
  if (!tasteProfile) return experiences; // no taste signal yet — chronological stays the honest default

  const affinity = tasteProfile.categoryAffinity as Record<string, number>;
  // A stable sort: JS's Array#sort is guaranteed stable, so ties (same affinity, including the
  // common "no signal for this category" 0 case) keep their original chronological order rather
  // than being shuffled — the personalisation is a reordering by relevance, not a randomisation.
  return [...experiences].sort((a, b) => {
    const scoreA = affinity[categoryToTasteKey(a.category)] ?? 0;
    const scoreB = affinity[categoryToTasteKey(b.category)] ?? 0;
    return scoreB - scoreA;
  });
}
