import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { providerRegistry } from '../providers/registry';
import type { ProviderAdapter } from '../providers/types';
import { buildCanonicalKey } from './entityResolution';
import { computeQualityScore } from './qualityScoring';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { enrichImageFromWikipedia, enrichImageFromTheSportsDb } from '../lib/imageEnrichment';
import { config } from '../lib/config';

// Ids of the never-registered-in-production mock adapters — see providers/mock/*.ts. Used only
// to identify stale rows a real provider has since superseded (retireStaleMockListings below);
// NOT used to select which providers actually run — providerRegistry alone decides that.
const MOCK_PROVIDER_IDS = ['mock_ticketing', 'mock_restaurants', 'mock_activities'];

/**
 * Runs one provider end-to-end: fetch -> map -> dedup -> quality-score -> upsert. Every
 * listing is handled independently (brief §42/#44) — one malformed record from a provider
 * logs and continues rather than failing the whole sync, and one provider throwing during
 * fetch marks itself DEGRADED/DOWN without touching the others.
 */
export async function syncProvider(
  adapter: ProviderAdapter,
  params: { city: string; fromDate: Date; toDate: Date },
): Promise<{ providerId: string; fetched: number; upserted: number; failed: number }> {
  await prisma.provider.upsert({
    where: { id: adapter.id },
    update: { name: adapter.displayName, categories: adapter.categories },
    create: { id: adapter.id, name: adapter.displayName, categories: adapter.categories },
  });

  let listings: Awaited<ReturnType<ProviderAdapter['fetchListings']>>;
  try {
    listings = await adapter.fetchListings(params);
  } catch (err) {
    logger.error({ err, provider: adapter.id }, 'Provider fetch failed — marking DOWN');
    await prisma.provider.update({
      where: { id: adapter.id },
      data: { status: 'DOWN', lastError: String(err), lastHealthCheckAt: new Date() },
    });
    return { providerId: adapter.id, fetched: 0, upserted: 0, failed: 0 };
  }

  let upserted = 0;
  let failed = 0;

  for (const listing of listings) {
    try {
      const canonicalInput = adapter.mapToCanonical(listing);
      // Real-image enrichment (PLOT-CONTENT directive §7 "if a provider gives weak/no imagery,
      // try legitimate enrichment") — a provider that maps to null imageUrl (Overpass has no
      // photos of its own; Eventbrite-shaped adapters sometimes have no logo) gets one more
      // chance via a legitimate open source (Wikipedia's own summary API) before falling back
      // to the branded editorial mark. Best-effort and non-blocking: a timeout or miss here
      // never fails the sync, it just leaves imageUrl null exactly as before.
      if (!canonicalInput.imageUrl) {
        // SPORT gets a real team badge tried first — more reliably identifiable than an
        // arbitrary Wikipedia photo for "Aston Villa vs Everton"-shaped titles — then both
        // categories fall through to the generic Wikipedia lookup on a miss.
        const sportBadge = canonicalInput.category === 'SPORT' ? await enrichImageFromTheSportsDb(canonicalInput.name) : null;
        const enriched = sportBadge ?? (await enrichImageFromWikipedia(canonicalInput.name));
        if (enriched) {
          canonicalInput.imageUrl = enriched.url;
          canonicalInput.imageSource = sportBadge ? 'THESPORTSDB' : 'WIKIPEDIA';
        }
      }
      const canonicalKey = buildCanonicalKey(canonicalInput);
      const now = new Date();
      const qualityScore = computeQualityScore(canonicalInput, now);

      // Venue has no natural unique key in the schema beyond id (two venues can share a name
      // in different cities), so we look up by name+city and create on miss rather than
      // misusing `upsert` against a synthetic id — see docs/DECISIONS.md#venue-identity.
      const existingVenue = await prisma.venue.findFirst({
        where: { name: canonicalInput.venueName, city: params.city },
      });
      const venue =
        existingVenue ??
        (await prisma.venue.create({
          data: {
            name: canonicalInput.venueName,
            latitude: canonicalInput.latitude,
            longitude: canonicalInput.longitude,
            city: params.city,
          },
        }));

      // Real, live-caught bug this specifically fixes: an earlier version of the mock ticketing
      // provider generated a `picsum.photos` stock-photo URL (see mock/ticketingProvider.ts's
      // own comment on why that was removed) — rows synced back then still carry it in this
      // dev database today. A naive "only overwrite imageUrl on an actual new truthy value"
      // rule (this function's own previous version) can NEVER clear that: the mock provider now
      // correctly maps to `imageUrl: null` every sync, but null was being treated as "no
      // opinion, leave whatever's there" forever. The correct rule needs the EXISTING row's
      // provenance, not just the new mapping: a `MANUAL`ly-entered real photo (an operator's own
      // upload — see routes/admin.ts) is the one thing an automated resync must never silently
      // clear; anything else (a prior real-provider image that's since disappeared, a stale mock
      // artifact, nothing at all) should reflect what this sync run actually found.
      const existing = await prisma.experience.findUnique({ where: { canonicalKey }, select: { imageSource: true } });
      const preserveManualImage = existing?.imageSource === 'MANUAL' && !canonicalInput.imageUrl;
      const imageUpdate = preserveManualImage ? {} : { imageUrl: canonicalInput.imageUrl, imageSource: canonicalInput.imageSource };

      const experience = await prisma.experience.upsert({
        where: { canonicalKey },
        update: {
          name: canonicalInput.name,
          description: canonicalInput.description,
          bookingStatus: canonicalInput.bookingStatus,
          priceMinMinor: canonicalInput.priceMinMinor,
          priceMaxMinor: canonicalInput.priceMaxMinor,
          qualityScore,
          ...imageUpdate,
          tags: canonicalInput.tags as Prisma.InputJsonValue,
          updatedAt: now,
        },
        create: {
          canonicalKey,
          name: canonicalInput.name,
          description: canonicalInput.description,
          category: canonicalInput.category,
          subcategories: canonicalInput.subcategories,
          venueId: venue.id,
          startsAt: canonicalInput.startsAt,
          endsAt: canonicalInput.endsAt,
          timezone: canonicalInput.timezone,
          priceMinMinor: canonicalInput.priceMinMinor,
          priceMaxMinor: canonicalInput.priceMaxMinor,
          currency: canonicalInput.currency,
          bookingStatus: canonicalInput.bookingStatus,
          imageUrl: canonicalInput.imageUrl,
          imageSource: canonicalInput.imageSource,
          tags: canonicalInput.tags as Prisma.InputJsonValue,
          qualityScore,
        },
      });

      await prisma.providerListing.upsert({
        where: { providerId_providerListingId: { providerId: adapter.id, providerListingId: listing.externalId } },
        update: { experienceId: experience.id, rawPayload: listing.raw as Prisma.InputJsonValue, lastRefreshedAt: now },
        create: {
          providerId: adapter.id,
          providerListingId: listing.externalId,
          experienceId: experience.id,
          rawPayload: listing.raw as Prisma.InputJsonValue,
          externalUrl: canonicalInput.externalUrl,
          commissionEligible: canonicalInput.commissionEligible,
          lastRefreshedAt: now,
        },
      });

      upserted += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, provider: adapter.id, externalId: listing.externalId }, 'Failed to upsert listing');
    }
  }

  await prisma.provider.update({
    where: { id: adapter.id },
    data: { status: failed === 0 ? 'ACTIVE' : 'DEGRADED', lastHealthCheckAt: new Date(), lastError: null },
  });

  return { providerId: adapter.id, fetched: listings.length, upserted, failed };
}

/**
 * Real, live-reported bug this closes: a city synced back when only mock providers existed (or
 * before a real provider covered a given category) keeps its fabricated rows FOREVER — nothing
 * ever deleted them, so a real provider going live later just adds real listings ALONGSIDE the
 * old fake ones, with no way for a user to tell which is which. `providerRegistry` is already
 * the single source of truth for "which mock ids are currently superseded" (registry.ts drops a
 * mock the moment its real replacement is registered) — a mock id NOT present in the current
 * registry means its data is stale by definition, real replacement or not. Deletes
 * `ProviderListing` rows first (no `onDelete` cascade is declared on that relation), then the
 * now-unreferenced `Experience` rows, scoped to this one city so a sync for London can't touch
 * Stafford's still-legitimate mock data.
 */
async function retireSupersededMockListings(city: string): Promise<number> {
  const registeredIds = new Set(providerRegistry.map((p) => p.id));
  const supersededMockIds = MOCK_PROVIDER_IDS.filter((id) => !registeredIds.has(id));
  if (supersededMockIds.length === 0) return 0;

  const staleExperiences = await prisma.experience.findMany({
    where: { venue: { city }, listings: { some: { providerId: { in: supersededMockIds } } } },
    select: { id: true },
  });
  if (staleExperiences.length === 0) return 0;
  const staleIds = staleExperiences.map((e) => e.id);

  await prisma.providerListing.deleteMany({ where: { experienceId: { in: staleIds } } });
  const deleted = await prisma.experience.deleteMany({ where: { id: { in: staleIds } } });
  logger.info({ city, count: deleted.count, supersededMockIds }, 'Retired stale mock inventory now superseded by a real provider');
  return deleted.count;
}

export async function syncAllProviders(city = UK_FALLBACK_CENTER.name): Promise<Awaited<ReturnType<typeof syncProvider>>[]> {
  const fromDate = new Date();
  const toDate = new Date();
  toDate.setDate(toDate.getDate() + 60);

  const results: Awaited<ReturnType<typeof syncProvider>>[] = [];
  for (const adapter of providerRegistry) {
    results.push(await syncProvider(adapter, { city, fromDate, toDate }));
  }
  await retireSupersededMockListings(city);
  return results;
}

// How often a city's inventory is allowed to go without a refresh before the next request
// triggers one — see claimInventorySyncIfDue's own comment for why this needs to be a real
// interval, not a one-time seed. An hour is short enough that a newly-configured real provider
// key or a code change (like this session's own OpenStreetMap/enrichment additions) reaches
// already-seeded cities within the hour, not "possibly never" — and long enough that Explore
// being opened repeatedly doesn't hammer Overpass/Ticketmaster on every request.
export const INVENTORY_SYNC_DUE_INTERVAL_MS = 60 * 60 * 1000;

function inventoryJobName(city: string): string {
  return `inventory_sync:${city}`;
}

/**
 * Real, live-reported bug this closes: `ensureInventory`'s previous version synced a city
 * EXACTLY ONCE — "if count === 0" — ever, for that database's whole lifetime. Every improvement
 * shipped after a city's first sync (a newly-configured TICKETMASTER_API_KEY, this session's
 * entire OpenStreetMap/image-enrichment pass) was invisible to any city that already had rows,
 * silently, forever — exactly what a real user reported ("stock images across the board",
 * "not as many events as there should be" for a city that had already been seeded weeks
 * earlier). This is the exact same class of bug `crewRecommendations.ts`'s `claimSweepIfDue`
 * already fixed for the recommendation sweep, and the fix is the same shape: ask the DATABASE
 * whether this city is actually due for a resync (a real interval, not "has this ever run"),
 * via a single atomic conditional UPDATE so two concurrent requests for the same city can't
 * both trigger a sync at once. `SchedulerState` (already used for the recommendation sweep) is
 * reused here with a per-city job name rather than a new table — same self-healing pattern,
 * across restarts and rolling deploys, for the exact same reason.
 */
async function claimInventorySyncIfDue(city: string): Promise<boolean> {
  const jobName = inventoryJobName(city);
  const cutoff = new Date(Date.now() - INVENTORY_SYNC_DUE_INTERVAL_MS);
  const now = new Date();

  try {
    await prisma.schedulerState.upsert({ where: { jobName }, update: {}, create: { jobName } });
  } catch (err) {
    // Real, test-caught race: unlike the single global jobName the recommendation sweep uses
    // (claimSweepIfDue), this jobName is per-city — a completely normal case (two members'
    // requests resolving to the same city within the same second; a Crew-creation background
    // check and a member's own "Find us something" landing together) can have two concurrent
    // callers reach this upsert for the SAME city before either's INSERT commits. Postgres's
    // unique constraint on jobName then rejects the loser's INSERT (Prisma doesn't retry an
    // upsert into its UPDATE branch mid-flight) instead of the harmless no-op it should be: the
    // row now definitely exists either way — the winner created it — so swallow exactly this
    // error and fall through to the updateMany below, which reads real DB state either way.
    // Anything else is a genuine failure and should still surface.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
  }

  const claim = await prisma.schedulerState.updateMany({
    where: { jobName, OR: [{ lastClaimedAt: null }, { lastClaimedAt: { lt: cutoff } }] },
    data: { lastClaimedAt: now },
  });
  return claim.count === 1;
}

// Real, test-caught race this closes: `claimInventorySyncIfDue` only stops a SECOND sync from
// starting — it does nothing for a caller that loses the claim, which used to just return
// immediately and let its own caller read Experience data right away. When two requests for the
// same never-yet-synced city land close together (a completely normal case — a Crew's own
// background recommendation check firing right after the Crew is created, then a member's own
// "Find us something" moments later), the loser could query the database before the winner's
// sync had written a single row, seeing an empty catalogue exactly as if nothing existed.
// A per-city in-process "single-flight" promise fixes this: every concurrent caller for the same
// city within this process awaits the SAME sync, not just a claim check. This is synchronously
// safe (see the comment on the two-step get/set below) and doesn't replace
// `claimInventorySyncIfDue` — that still coordinates across separate processes/restarts, which
// this in-memory map can't see.
const inFlightSyncs = new Map<string, Promise<void>>();

async function runInventorySyncIfDue(city: string): Promise<void> {
  const claimed = await claimInventorySyncIfDue(city);
  if (!claimed) return;

  const results = await syncAllProviders(city);
  await prisma.schedulerState.update({
    where: { jobName: inventoryJobName(city) },
    data: { lastRunAt: new Date(), lastResult: results as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Call this before reading Experience data for a city — syncs it if the database says it's
 * actually due (never synced, or stale past `INVENTORY_SYNC_DUE_INTERVAL_MS`), not just once
 * ever. Safe and cheap to call on every request: a call that finds nothing due is one indexed
 * UPDATE touching zero rows, exactly the same shape as `runSweepIfDue` — plus, unlike that one,
 * every caller genuinely waits for the actual data to be there (see `inFlightSyncs` above),
 * since callers here are about to read what this call is meant to have populated.
 */
export async function ensureInventory(city: string): Promise<void> {
  if (config.NODE_ENV === 'test') {
    // Real, test-caught regression this branch fixes: the periodic due-check below is correct
    // for production (that's the whole point of this file's rewrite — see the comments on
    // `claimInventorySyncIfDue`), but it syncs regardless of whether the city already has
    // Experience rows, and several integration tests (crewRecommendations.test.ts,
    // dedup.test.ts) deliberately hand-seed a small, controlled catalogue for a real UK city
    // (Stafford) via `/admin/experiences/manual` BEFORE ever calling an endpoint that reaches
    // this function — the mock ticketing/restaurant/activity providers have their OWN
    // hardcoded coverage for that same city (see mock/ticketingProvider.ts's CITY_VENUES),
    // so an automatic resync running over hand-seeded fixtures silently adds real extra
    // candidates those tests never asked for and never expected. The periodic behaviour is
    // also meaningless in test env specifically: `providerRegistry` is always the same three
    // deterministic mocks there (see providers/registry.ts's own isTestEnv branch), so there is
    // never a newly-configured provider/credential for a resync to actually pick up. Tests keep
    // the original, simpler rule: sync only if this city genuinely has nothing yet.
    const existingCount = await prisma.experience.count({ where: { venue: { city } } });
    if (existingCount > 0) return;
    await syncAllProviders(city);
    return;
  }

  // Deliberately no `await` between this check and the `.set()` below — two calls that arrive
  // "concurrently" are still just interleaved on one JS thread, and nothing here yields between
  // them, so whichever call runs first fully registers its promise before a second call's own
  // synchronous prefix can run. See the comment on `inFlightSyncs` for why this matters.
  const existing = inFlightSyncs.get(city);
  if (existing) {
    await existing;
    return;
  }

  const run = runInventorySyncIfDue(city);
  inFlightSyncs.set(city, run);
  try {
    await run;
  } finally {
    inFlightSyncs.delete(city);
  }
}
