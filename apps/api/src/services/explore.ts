import { prisma } from '../lib/prisma';
import { MIN_PUBLISHABLE_QUALITY_SCORE } from './qualityScoring';
import { ensureInventory } from './inventorySync';
import { categoryToTasteKey } from './match';
import { experienceInterestTags, experienceMatchesFreeText, type FreeTextSignal } from './tasteSignals';
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
// `listings` (real bug fix: "the event details... should be able to see what the cost and
// details are") is Experience's own real link back to its source provider page — `externalUrl`
// itself lives on ProviderListing, not on Experience (see schema.prisma), so it was never on
// this shape at all before, and Explore's detail sheet had no way to point someone at the real
// listing for whatever Plot's own normalized fields don't carry (full price tiers, seating,
// terms). Same field, same shape (`listings: { externalUrl }[]`), as the Plan detail page
// already exposes for exactly this reason — one convention, not two.
type ExperienceWithVenue = Experience & { venue: Venue | null; listings: { externalUrl: string }[] };

export interface ExplorePersonalisationResult {
  experiences: ExperienceWithVenue[];
  /** True only when a real filter was actually applied (the viewer has genuine taste signal AND
   *  filtering wasn't explicitly turned off) — the client uses this to decide whether "Showing
   *  only what matches your taste" is an honest thing to say. */
  filteredToTaste: boolean;
  /** How many rows existed before the taste filter ran — lets the client say "12 hidden", never
   *  a black box when someone wants to see everything again. */
  totalBeforeFilter: number;
}

/** Real, specific relevance check — never a bare category guess. An Experience counts as
 *  "within your preference" if ANY of: (1) its own category has positive affinity, (2) at least
 *  one of the Experience's own real interest tags (see tasteSignals.ts#experienceInterestTags —
 *  provider subcategories + a scoped keyword scan, never invented) has positive affinity, or (3)
 *  it textually matches one of the viewer's own free-text signals. The same signals match.ts
 *  already scores a Crew recommendation against — Explore's "only show what's relevant" now
 *  means the same thing "relevant" means everywhere else in Plot, not a separate, cruder rule. */
function isRelevantToTaste(
  experience: ExperienceWithVenue,
  categoryAffinity: Record<string, number>,
  interestAffinity: Record<string, number>,
  freeTextSignals: FreeTextSignal[],
): boolean {
  if ((categoryAffinity[categoryToTasteKey(experience.category)] ?? 0) > 0) return true;

  const tags = experienceInterestTags({
    category: experience.category,
    subcategories: experience.subcategories,
    name: experience.name,
    description: experience.description ?? '',
  });
  if (tags.some((id) => (interestAffinity[id] ?? 0) > 0)) return true;

  if (freeTextSignals.some((s) => experienceMatchesFreeText({ name: experience.name, description: experience.description ?? '' }, s.text))) return true;

  return false;
}

/** Shared by both the exact-city and the radius search below: quality/booking-status/date-
 * window filtering, near-duplicate suppression, and taste-based ordering/filtering are the exact
 * same rules regardless of how the candidate set of Experience rows was gathered.
 *
 * Real product change, not just a reorder any more (docs/DECISIONS.md#explore-personalisation
 * originally chose "reorder, never hide" — superseded by explicit direction: preferences must
 * make Explore show ONLY what's relevant, immediately, not keep every irrelevant event visible
 * just reshuffled further down). Filtering only ever engages when the viewer has real taste
 * signal to filter BY (`hasSignal` below) — a brand-new account with nothing tuned yet still sees
 * the full, honest chronological list, never an empty page because there was nothing to match
 * against. `filterToTaste: false` is the explicit escape hatch (the client's "Show everything"
 * toggle) for anyone who wants to browse unfiltered even once they do have taste signal. */
async function finishExploreList(rows: ExperienceWithVenue[], userId?: string, opts?: { filterToTaste?: boolean }): Promise<ExplorePersonalisationResult> {
  const deduped = dedupeNearDuplicates(rows, (e) => ({ name: e.name, category: e.category, startsAt: e.startsAt }));

  if (!userId) return { experiences: deduped, filteredToTaste: false, totalBeforeFilter: deduped.length };
  const tasteProfile = await prisma.tasteProfile.findUnique({
    where: { userId },
    select: { categoryAffinity: true, interestAffinity: true, freeTextSignals: true },
  });
  if (!tasteProfile) return { experiences: deduped, filteredToTaste: false, totalBeforeFilter: deduped.length }; // no taste signal yet — chronological stays the honest default

  const categoryAffinity = (tasteProfile.categoryAffinity as Record<string, number>) ?? {};
  const interestAffinity = (tasteProfile.interestAffinity as Record<string, number>) ?? {};
  const freeTextSignals = ((tasteProfile.freeTextSignals as unknown as FreeTextSignal[]) ?? []);
  const hasSignal =
    Object.values(categoryAffinity).some((v) => v > 0) || Object.values(interestAffinity).some((v) => v > 0) || freeTextSignals.length > 0;

  // A stable sort: JS's Array#sort is guaranteed stable, so ties (same affinity, including the
  // common "no signal for this category" 0 case) keep their original chronological order rather
  // than being shuffled — still a relevance reorder underneath the filter, not a randomisation.
  const ordered = [...deduped].sort((a, b) => {
    const scoreA = categoryAffinity[categoryToTasteKey(a.category)] ?? 0;
    const scoreB = categoryAffinity[categoryToTasteKey(b.category)] ?? 0;
    return scoreB - scoreA;
  });

  const shouldFilter = hasSignal && opts?.filterToTaste !== false;
  if (!shouldFilter) return { experiences: ordered, filteredToTaste: false, totalBeforeFilter: ordered.length };

  const relevant = ordered.filter((e) => isRelevantToTaste(e, categoryAffinity, interestAffinity, freeTextSignals));
  return { experiences: relevant, filteredToTaste: true, totalBeforeFilter: ordered.length };
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
export async function listExploreExperiences(city: string, userId?: string, opts?: { filterToTaste?: boolean }): Promise<ExplorePersonalisationResult> {
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
    include: { venue: true, listings: { select: { externalUrl: true }, take: 1, orderBy: { lastRefreshedAt: 'desc' } } },
    orderBy: { startsAt: 'asc' },
    take: EXPLORE_LIMIT,
  });
  return finishExploreList(rows, userId, opts);
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
  opts?: { filterToTaste?: boolean },
): Promise<{ experiences: ExperienceWithVenue[]; meta: RadiusSearchMeta; filteredToTaste: boolean; totalBeforeFilter: number }> {
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
    include: { venue: true, listings: { select: { externalUrl: true }, take: 1, orderBy: { lastRefreshedAt: 'desc' } } },
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

  const result = await finishExploreList(withinRadius.slice(0, EXPLORE_LIMIT * 2), userId, opts);
  const meta: RadiusSearchMeta = {
    centerLat: center.lat,
    centerLng: center.lng,
    radiusKm,
    placesSearched: places.map((p) => ({ name: p.name, distanceKm: Math.round(haversineKm(center.lat, center.lng, p.lat, p.lng)) })),
  };
  return { experiences: result.experiences.slice(0, EXPLORE_LIMIT), meta, filteredToTaste: result.filteredToTaste, totalBeforeFilter: result.totalBeforeFilter };
}
