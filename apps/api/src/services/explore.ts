import { prisma } from '../lib/prisma';
import { MIN_PUBLISHABLE_QUALITY_SCORE } from './qualityScoring';
import { ensureInventory, ensureLocalAreaInventory, LOCAL_AREA_RADIUS_KM } from './inventorySync';
import { categoriesImpliedByInterests, categoryToTasteKey, evaluateTasteRelevance, type FreeTextSignal } from './tasteSignals';
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
  // Deliberately NOT `|| Object.values(categoryAffinity).some(...)` any more — same real,
  // live-reported bug and fix as personalHome.ts#hasSignal and tasteSignals.ts#evaluateTasteRelevance's
  // own `eligible`: a stale, one-time, unclearable onboarding category swipe could trigger
  // filtering on its own, hiding everything outside a category the person's actual current taste
  // (interestAffinity) says nothing about.
  const hasSignal = Object.values(interestAffinity).some((v) => v > 0) || freeTextSignals.length > 0;

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

  const relevance = ordered.map((e) =>
    evaluateTasteRelevance(
      { category: e.category, subcategories: e.subcategories, name: e.name, description: e.description ?? '' },
      categoryAffinity,
      interestAffinity,
      freeTextSignals,
    ),
  );
  const strictRelevant = ordered.filter((_e, i) => relevance[i].eligible);

  // Real, live-reported bug this fixes, the moment the strict fix above shipped: an account with
  // entirely real, current interests set (boxing, MMA, restaurants, street food) could still see
  // "0 recommendations" — real provider inventory essentially never uses Plot's own specific
  // taxonomy wording. Scoped PER INTEREST, not "widen everything the moment the whole set is
  // empty" (see personalHome.ts's identical fallback and its own comment on exactly why a global
  // empty-check would let one interest's real coverage silently suppress a completely different
  // interest's fallback) — only interests with ZERO strict matches anywhere in `ordered` get
  // widened (see evaluateTasteRelevance's own `impliedByInterestId` doc comment for why this is
  // never folded into strict eligibility itself); an interest already finding real, specific
  // matches is never touched by this at all.
  const matchedInterestIds = new Set(relevance.map((r) => r.matchedInterestId).filter((id): id is string => id !== null));
  const underCoveredInterests = Object.fromEntries(
    Object.entries(interestAffinity).filter(([id, v]) => v > 0 && !matchedInterestIds.has(id)),
  );
  const impliedCategoriesForUnderCovered = categoriesImpliedByInterests(underCoveredInterests);
  const strictRelevantIds = new Set(strictRelevant.map((e) => e.id));
  const widenedByCategory = ordered.filter((e) => !strictRelevantIds.has(e.id) && impliedCategoriesForUnderCovered.has(e.category));
  // Territories requiring an explicit relation (@plot/shared's TERRITORIES_REQUIRING_EXPLICIT_
  // RELATION — currently `music`, see its own comment: the drill/Sam Smith bug) get NO blanket
  // category grant above — `categoriesImpliedByInterests` already excludes them. Their only
  // fallback is a genuinely curated close relation (RELATED_INTERESTS), checked per-experience via
  // `relevance[i].impliedByInterestId` (already computed above, index-aligned with `ordered`).
  const widenedByCategoryIds = new Set(widenedByCategory.map((e) => e.id));
  const widenedByRelation = ordered.filter((e, i) => {
    if (strictRelevantIds.has(e.id) || widenedByCategoryIds.has(e.id)) return false;
    const impliedId = relevance[i].impliedByInterestId;
    return impliedId !== null && underCoveredInterests[impliedId] !== undefined;
  });
  const relevant = [...strictRelevant, ...widenedByCategory, ...widenedByRelation];

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
// "This area" (the exact-city default, `radiusKm === null` on the client) was, until this real,
// live-reported bug ("I'm in Birmingham... it's showing me events in Sheffield and Chester"), a
// bare `venue.city === city` string match. Every live ticketed-events provider deliberately
// searches well beyond the requested city (Ticketmaster 100km, Skiddle ~104km, PredictHQ 40km —
// see each adapter's own SEARCH_RADIUS comment) so Explore's own radius-widening feature has real
// inventory from one sync — genuinely correct on its own — but a `venue.city` string match then
// trusted whatever label a venue happened to get (see inventorySync.ts#syncProvider's own fix for
// the ingestion half of this bug) with zero real distance check at all. `ensureLocalAreaInventory`
// (services/inventorySync.ts) is the query-time half, shared with personalHome.ts so both mean
// the same real-world radius: even a still-mislabelled row can never again reach "This area"
// unless it's genuinely close, while genuinely local neighbouring towns (Uttoxeter/Cannock/
// Trentham all sit within ~25km of Stafford) still count, exactly as they always honestly should.
export async function listExploreExperiences(city: string, userId?: string, opts?: { filterToTaste?: boolean }): Promise<ExplorePersonalisationResult> {
  const { center, places } = await ensureLocalAreaInventory(city);

  const windowStart = new Date();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + EXPLORE_WINDOW_DAYS);
  // See match.ts's own identical fix for the full story: without this, "the next N days"
  // silently depends on what time of day the request happens to fire, not just the date.
  windowEnd.setHours(23, 59, 59, 999);

  const rows = await prisma.experience.findMany({
    where: {
      qualityScore: { gte: MIN_PUBLISHABLE_QUALITY_SCORE },
      bookingStatus: { not: 'SOLD_OUT' },
      startsAt: { gte: windowStart, lte: windowEnd },
      venue: { city: { in: places.map((p) => p.name) } },
    },
    include: { venue: true, listings: { select: { externalUrl: true }, take: 1, orderBy: { lastRefreshedAt: 'desc' } } },
    orderBy: { startsAt: 'asc' },
    take: EXPLORE_LIMIT * Math.max(places.length, 1),
  });
  // The actual, real distance check — being in `places` only means a venue's CITY LABEL is one
  // of the real nearby gazetteer names; this confirms the venue's own real coordinates are
  // genuinely within the local radius too, the same defense-in-depth belt-and-braces the radius
  // search below already applies. A row with no venue has no coordinates to check — excluded
  // rather than assumed local.
  const withinLocalArea = rows.filter((r) => r.venue && haversineKm(center.lat, center.lng, r.venue.latitude, r.venue.longitude) <= LOCAL_AREA_RADIUS_KM);
  return finishExploreList(withinLocalArea.slice(0, EXPLORE_LIMIT), userId, opts);
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
  // See match.ts's own identical fix for the full story: without this, "the next N days"
  // silently depends on what time of day the request happens to fire, not just the date.
  windowEnd.setHours(23, 59, 59, 999);

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
