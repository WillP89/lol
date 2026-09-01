import { prisma } from '../lib/prisma';
import { MIN_PUBLISHABLE_QUALITY_SCORE } from './qualityScoring';
import { ensureInventory } from './inventorySync';
import { categoryToTasteKey } from './match';
import { dedupeNearDuplicates } from './entityResolution';
import { haversineKm } from '../lib/geo';
import { placesWithinRadiusKm } from '../data/ukPlaces';
import type { Experience, Venue } from '@prisma/client';

const EXPLORE_WINDOW_DAYS = 21;
const EXPLORE_LIMIT = 200;

// Venue is a nullable FK on Experience at the schema level (see prisma/schema.prisma) even
// though every row this file queries has one in practice — kept nullable here rather than
// asserted non-null, so a genuinely orphaned row (a Venue hard-deleted out from under it) fails
// the radius distance check below instead of crashing the request.
type ExperienceWithVenue = Experience & { venue: Venue | null };

/** Shared by both the exact-city and the radius search below: quality/booking-status/date-
 * window filtering, near-duplicate suppression, and taste-affinity ordering are the exact same
 * rules regardless of how the candidate set of Experience rows was gathered. */
async function finishExploreList(rows: ExperienceWithVenue[], userId?: string): Promise<ExperienceWithVenue[]> {
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
export async function listExploreExperiences(city: string, userId?: string): Promise<ExperienceWithVenue[]> {
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
  return finishExploreList(rows, userId);
}

export interface RadiusSearchMeta {
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  /** The real gazetteer places actually synced/searched for this query — shown in the UI so
   * "extend the radius" is honest about what widening it actually pulled in, not a black box. */
  placesSearched: { name: string; distanceKm: number }[];
}

/**
 * The radius/postcode search this directive asked for ("extend the map radius and pick areas,
 * even a postcode"). Provider inventory is synced per named city (mock and live adapters alike
 * — see providers/registry.ts), so a radius search works by finding every real gazetteer place
 * (data/ukPlaces.ts) within `radiusKm` of the given centre, syncing each of them, then filtering
 * every resulting Experience down to ones whose actual venue coordinates fall inside the
 * requested radius — never a fabricated "nearby" result, always a real distance check against a
 * real venue location. Widening the radius genuinely surfaces more real places' worth of
 * inventory, not just a re-labelled version of the same one city.
 */
export async function listExploreExperiencesByRadius(
  center: { lat: number; lng: number },
  radiusKm: number,
  userId?: string,
): Promise<{ experiences: ExperienceWithVenue[]; meta: RadiusSearchMeta }> {
  const places = placesWithinRadiusKm(center.lat, center.lng, radiusKm);
  await Promise.all(places.map((p) => ensureInventory(p.name)));

  const windowStart = new Date();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + EXPLORE_WINDOW_DAYS);

  const rows = await prisma.experience.findMany({
    where: {
      qualityScore: { gte: MIN_PUBLISHABLE_QUALITY_SCORE },
      bookingStatus: { not: 'SOLD_OUT' },
      startsAt: { gte: windowStart, lte: windowEnd },
      venue: { city: { in: places.map((p) => p.name) } },
    },
    include: { venue: true },
    orderBy: { startsAt: 'asc' },
    // Wider net than the single-city limit — several cities' worth of rows get distance-filtered
    // below, so this needs enough headroom that a genuinely close result from a smaller synced
    // city isn't crowded out by `take` before distance filtering ever runs.
    take: EXPLORE_LIMIT * Math.max(places.length, 1),
  });

  // The real distance check — a place being in `places` only means its CENTRE is within radius;
  // an individual venue near that city's edge can still legitimately fall outside it. A row with
  // no venue at all (see the ExperienceWithVenue comment above) has no coordinates to check —
  // excluded rather than assumed in-range.
  const withinRadius = rows.filter((r) => r.venue && haversineKm(center.lat, center.lng, r.venue.latitude, r.venue.longitude) <= radiusKm);

  const experiences = await finishExploreList(withinRadius.slice(0, EXPLORE_LIMIT * 2), userId);
  const meta: RadiusSearchMeta = {
    centerLat: center.lat,
    centerLng: center.lng,
    radiusKm,
    placesSearched: places.map((p) => ({ name: p.name, distanceKm: Math.round(haversineKm(center.lat, center.lng, p.lat, p.lng)) })),
  };
  return { experiences: experiences.slice(0, EXPLORE_LIMIT), meta };
}
