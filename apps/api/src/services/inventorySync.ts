import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { providerRegistry } from '../providers/registry';
import type { ProviderAdapter } from '../providers/types';
import { buildCanonicalKey } from './entityResolution';
import { computeQualityScore } from './qualityScoring';
import { UK_FALLBACK_CENTER, nearestPlaceName, resolveCityCenter, placesWithinRadiusKm, type UkPlace } from '../data/ukPlaces';
import { enrichImageFromWikipedia, enrichImageFromTheSportsDb } from '../lib/imageEnrichment';
import { getCategoryStockImage } from '../lib/categoryStockImages';
import { getPexelsStockImage } from '../lib/pexelsStockImages';
import { isImageQualityBad } from '../lib/imageDimensions';
import { config } from '../lib/config';

// EVERY provider's image gets byte-verified now, no exceptions — real, repeated live reports
// ("distorted and shit quality") kept recurring even after this file first shipped, because that
// first version only probed sources with no declared width at all and trusted Ticketmaster's/
// Wikipedia's own self-reported number outright. A provider's own declared width was clearly not
// a strong enough bar on its own; the real bytes are the only thing actually trusted now. TheSportsDB
// team badges are the one deliberate exception: a badge/crest is meant to be a small, icon-like
// image, not a photo — the same "hero photo" floor doesn't apply to that asset class, and forcing
// it would reject every real result TheSportsDB has.
const IMAGE_QUALITY_EXEMPT_SOURCES = new Set(['THESPORTSDB', 'MANUAL']);

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
        } else {
          // Real, explicit product directive: "I don't want to see ANY events without a real
          // image" — a generic listing ("Quiz Night at The Anchor") has no Wikipedia page to
          // enrich from, but it's still a real, identifiable TYPE of event. This is the true last
          // resort before a listing is left with imageUrl null (and the web app's own generated
          // category-art graphic — lib/v2Art.ts — is all that's left to show): a real,
          // category-appropriate photograph. TWO independent sources tried in order, not one —
          // Commons first (free, no key), then Pexels (needs PEXELS_API_KEY) — because Wikimedia's
          // own edge infrastructure returns a hard 403 to this app's real Render deployment
          // (confirmed from production logs; en.wikipedia.org and commons.wikimedia.org share that
          // same edge), which would otherwise silently defeat the Commons tier alone. See
          // lib/categoryStockImages.ts's and lib/pexelsStockImages.ts's own headers for the full
          // reasoning.
          const commonsStock = await getCategoryStockImage(canonicalInput.category, canonicalInput.name);
          const pexelsStock = commonsStock ? null : await getPexelsStockImage(canonicalInput.category, canonicalInput.name);
          const stock = commonsStock ?? pexelsStock;
          if (stock) {
            canonicalInput.imageUrl = stock.url;
            canonicalInput.imageSource = commonsStock ? 'CATEGORY_STOCK' : 'PEXELS_STOCK';
          }
        }
      }
      // THE real, provider-agnostic quality floor (see lib/imageDimensions.ts's own header
      // comment) — every source now, no exemption for a provider that merely declares its own
      // width. Best-effort: a probe failure keeps the image exactly as before this existed, it
      // never turns a working sync into a broken one.
      if (canonicalInput.imageUrl && canonicalInput.imageSource && !IMAGE_QUALITY_EXEMPT_SOURCES.has(canonicalInput.imageSource)) {
        if (await isImageQualityBad(canonicalInput.imageUrl)) {
          canonicalInput.imageUrl = null;
          canonicalInput.imageSource = null;
        }
      }
      const canonicalKey = buildCanonicalKey(canonicalInput);
      const now = new Date();
      const qualityScore = computeQualityScore(canonicalInput, now);

      // Venue has no natural unique key in the schema beyond id (two venues can share a name
      // in different cities), so we look up by name+city and create on miss rather than
      // misusing `upsert` against a synthetic id — see docs/DECISIONS.md#venue-identity.
      //
      // Real, live-reported bug this closes: "I'm in Birmingham, filtered to this area, and it's
      // showing me events in Sheffield and Chester." Every live ticketed-events provider
      // deliberately searches well beyond the requested city (Ticketmaster 100km, Skiddle
      // ~104km, PredictHQ 40km — see each adapter's own SEARCH_RADIUS comment, all sized so
      // Explore's own radius-widening UI has real inventory to reveal from one sync), so a
      // `city: "Birmingham"` sync can genuinely, validly return a real venue that's actually in
      // Sheffield. This used to label that real venue's `city` field with `params.city` — the
      // SYNCED city — regardless of where it really is. `nearestPlaceName` derives the label from
      // the venue's own real coordinates instead, so a venue is only ever filed under the city
      // it's actually in — never the city whose sync happened to discover it. This is the
      // ingestion half of the fix; `ensureLocalAreaInventory` below is the query-time half every
      // "This area" caller (explore.ts, personalHome.ts) now goes through instead of a bare exact
      // match — belt-and-braces, so even a row some other path left mislabelled can't slip in.
      const venueCity = nearestPlaceName(canonicalInput.latitude, canonicalInput.longitude);
      const existingVenue = await prisma.venue.findFirst({
        where: { name: canonicalInput.venueName, city: venueCity },
      });
      const venue =
        existingVenue ??
        (await prisma.venue.create({
          data: {
            name: canonicalInput.venueName,
            latitude: canonicalInput.latitude,
            longitude: canonicalInput.longitude,
            city: venueCity,
          },
        }));

      // Real, live-caught bug this specifically fixes (originally): an earlier version of the
      // mock ticketing provider generated a `picsum.photos` stock-photo URL (see
      // mock/ticketingProvider.ts's own comment on why that was removed) — rows synced back then
      // still carried it in the dev database. A naive "only overwrite imageUrl on an actual new
      // truthy value" rule can never clear that kind of stale artifact, so this used to clear
      // the field whenever the new sync pass found nothing — protecting only a `MANUAL`ly-entered
      // photo (an operator's own upload — see routes/admin.ts) from that.
      //
      // SECOND, more serious real bug that same rule caused, found from a live report ("STOCK
      // IMAGES, AGAIN") of Explore cards that had a real photo flip BACK to the generic v2Art
      // fallback graphic on their own: `ensureInventoryProduction` resyncs an already-seeded
      // city periodically in the background (not just once), and every resync re-runs the FULL
      // enrichment chain (Wikipedia/TheSportsDB -> Commons -> Pexels) from scratch for every
      // listing. Those two external stock sources are real, rate-limited, occasionally-flaky
      // network calls (this exact "one pass came up short" pattern is already documented in
      // categoryStockImages.ts's/pexelsStockImages.ts's own EMPTY_POOL_TTL_MS comments) — a
      // transient miss on any LATER resync used to overwrite an already-real, already quality-
      // verified image straight back to null, even though nothing about that photo had actually
      // stopped being valid. A resync should only ever IMPROVE or REFRESH imageUrl (a genuine new
      // provider photo, or a fresh enrichment success) — never regress a working real photo back
      // to the fallback graphic just because one particular pass got unlucky.
      //
      // The distinguishing signal is `imageSource`, not just `imageUrl`: the original stale-
      // picsum-artifact case this guard first existed for is a row with a real `imageUrl` STRING
      // but `imageSource: null` — genuinely untrusted/legacy provenance from before this field
      // existed, which a resync correctly still clears (imageProvenance.test.ts's own first
      // test). Every row this newer fix protects (a real provider photo, Wikipedia/TheSportsDB,
      // Commons/Pexels category stock, or a MANUAL upload) always has a real, non-null
      // `imageSource` written alongside its `imageUrl` — see every call site above and in
      // backfillMissingImages/enrichMissingImageForExperience below. So "does the existing row
      // have a known, tracked source" is exactly the right test for "is this a real photo worth
      // protecting from a later pass's transient miss", independent of MANUAL specifically.
      const existing = await prisma.experience.findUnique({ where: { canonicalKey }, select: { imageSource: true } });
      const keepExistingImage = Boolean(existing?.imageSource) && !canonicalInput.imageUrl;
      const imageUpdate = keepExistingImage ? {} : { imageUrl: canonicalInput.imageUrl, imageSource: canonicalInput.imageSource };

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

  // Real live bug this closes: providers used to run one after another, so one sync's total
  // latency was the SUM of every registered provider's own worst case — Ticketmaster's page
  // retries plus Skiddle's category retries plus OpenStreetMap's query retry, all added
  // together, inside the same synchronous call a live page load awaits (ensureInventory). That
  // sum is exactly what hung Discover the moment a second live provider (Skiddle) was added.
  // Each adapter already isolates its OWN failures (syncProvider's try/catch marks a provider
  // DOWN without touching the others) and each now bounds its OWN worst-case latency (see
  // PER_CATEGORY_RETRY/PAGE_RETRY/FETCH_RETRY in the adapters themselves) — running them
  // concurrently turns total sync latency into the MAX of those bounds instead of their sum.
  //
  // Known, pre-existing, and unchanged trade-off: syncProvider's own venue lookup
  // (`findFirst` then `create` — see its own comment on why, and docs/DECISIONS.md#venue-identity)
  // has no unique constraint to make it atomic, so two providers racing to create the same
  // brand-new venue (same name+city) concurrently can create a harmless duplicate Venue row
  // rather than throwing. This was already possible before this change (two separate requests
  // for the same never-synced city landing close together), just less likely with everything
  // sequential — running providers concurrently doesn't introduce a new failure mode, only
  // makes an already-accepted one somewhat more likely. Not a crash, not data loss — some
  // experiences would just split across two Venue rows for the same real place until the next
  // dedup pass. A real fix needs a DB-level unique constraint plus a data cleanup migration,
  // deliberately out of scope here without being able to inspect production's existing venue
  // data first.
  const results = await Promise.all(providerRegistry.map((adapter) => syncProvider(adapter, { city, fromDate, toDate })));

  // Real risk this guards against: `retireSupersededMockListings` deletes old mock rows purely
  // because the registry has moved on from them — it has no idea whether today's real providers
  // actually delivered a replacement. If every currently-registered provider fails or returns
  // nothing for this city in this one sync (a live Overpass outage, a network blip on the host,
  // a provider bug) while the OLD mock data still gets wiped, a city could go from "has content"
  // to "has nothing at all" in one unlucky sync — worse than the stale-mock problem this was
  // built to fix. Only retire once at least one registered provider actually produced real rows
  // this run, so a bad sync leaves the previous (even if imperfect) inventory in place instead
  // of deleting it out from under a page that's about to read it.
  const anyRealUpsertsThisRun = results.some((r) => r.upserted > 0);
  if (anyRealUpsertsThisRun) {
    await retireSupersededMockListings(city);
  } else {
    logger.warn({ city, results }, 'Skipping stale-mock retirement — no registered provider produced any listings this sync');
  }
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
// Real, live-reported bug this closes: EVERY caller of `ensureInventory` (both `explore.ts`'s
// two list functions AND `crewRecommendations.ts`'s `evaluateCrewEligibility`) awaited it
// unguarded. Before this file's periodic-resync rewrite, that was safe in practice — the old
// "sync once, ever" guard meant an already-seeded city almost never actually ran
// `syncAllProviders` again, so there was little live surface for a sync-time exception to
// escape through. The periodic due-check changed that: now a normal request can be the one that
// happens to trigger a real resync, and ANYTHING unexpected during it (a transient DB hiccup, a
// provider adapter's own bug, anything not already individually caught inside `syncProvider`)
// propagates straight out of this function — which meant Explore returning a 500 (rendering as
// "loads with no images", not an error the user would necessarily notice) and, far worse, the
// "send a recommendation the moment a Crew hits 2 members" trigger (`routes/crews.ts`) silently
// failing and delivering nothing, exactly the two live symptoms this closes. `ensureInventory`
// exists specifically to run BEFORE reading data that should already work whether or not a
// resync happened to be due — a resync failing must never be worse than a resync simply not
// having run yet. Catches everything at this one boundary rather than requiring every call site
// to remember to guard itself.
// Exported (not just used internally) specifically so this exact non-throwing guarantee is
// directly testable, bypassing the `config.NODE_ENV === 'test'` branch below that the ordinary
// `ensureInventory` export always takes inside the test suite — the same reason `syncProvider`
// above is exported rather than kept private. See test/ensureInventoryResilience.test.ts.
export async function ensureInventoryProduction(city: string): Promise<void> {
  // Real live bug this closes: every caller — including ones reading a city that already has a
  // full catalogue — used to BLOCK on the due-sync completing, even though there was already
  // something real to show. That's what made Discover feel "stuck loading" the moment a due
  // resync happened to land on someone's request: three providers' worth of network latency
  // (now individually bounded, and now run concurrently — see syncAllProviders) still isn't
  // "instant". A city that already has content doesn't need to wait for a fresher one — the
  // due sync still runs, just in the background, and the NEXT request picks up its results
  // (a standard stale-while-revalidate trade-off: briefly-stale-but-real data now, not a
  // multi-second wait for marginally fresher data). A genuinely empty city (nothing to show at
  // all yet) is the one case that still has to wait — there's no "instant" version of showing
  // real content that doesn't exist yet.
  const hasExistingContent = (await prisma.experience.count({ where: { venue: { city } } })) > 0;

  let run = inFlightSyncs.get(city);
  if (!run) {
    run = runInventorySyncIfDue(city).catch((err) => {
      logger.error({ err, city }, 'Inventory sync failed — continuing with whatever inventory already exists rather than failing the request');
    });
    inFlightSyncs.set(city, run);
    // Not `finally` on an awaited call — this promise may run to completion long after THIS
    // caller has already returned (the whole point, for an already-seeded city) — so cleanup is
    // attached directly to the background promise itself, guarded so a newer sync that already
    // replaced this map entry (a fresh due-check some time later) isn't clobbered by a late
    // cleanup from this older one.
    const settled = run;
    void settled.finally(() => {
      if (inFlightSyncs.get(city) === settled) inFlightSyncs.delete(city);
    });
  }

  if (!hasExistingContent) {
    await run;
  }
}

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

  await ensureInventoryProduction(city);
}

// "This area" (a viewer's own home city on Home, a Crew's own default city, Explore's exact-city
// default) has always honestly meant "here, plus the real neighbouring towns anyone here would
// still call local" — not a bare string match against whatever a venue's own `city` column
// happens to say. Real, live-reported bug this exists to fix: "I'm in Birmingham... it's showing
// me events in Sheffield and Chester" — see syncProvider's own comment for the ingestion half.
// Shared by every caller that used to do a plain `venue: { city }` exact match (services/
// explore.ts, services/personalHome.ts) so all three ever mean the same real-world radius, not
// three independently-tuned definitions of "local" drifting apart.
export const LOCAL_AREA_RADIUS_KM = 30;

/**
 * Resolves a named city to its real gazetteer centre, syncs every genuinely nearby real place
 * (Explore's own radius search already proved this pattern out — see
 * services/explore.ts#listExploreExperiencesByRadius), and hands back both so the caller can
 * build a `venue: { city: { in: places } }` where-clause and then apply the actual real-distance
 * check against `center` — the same belt-and-braces the radius search already does, so even a
 * still-mislabelled row can never again reach "This area" unless it's genuinely close.
 */
export async function ensureLocalAreaInventory(city: string, radiusKm: number = LOCAL_AREA_RADIUS_KM): Promise<{ center: UkPlace; places: UkPlace[] }> {
  const center = resolveCityCenter(city);
  const places = placesWithinRadiusKm(center.lat, center.lng, radiusKm);
  await Promise.all(places.map((p) => ensureInventory(p.name)));
  return { center, places };
}

export interface ImageQualityBackfillResult {
  checked: number;
  cleared: number;
}

// Bounded concurrency for the backfill below — every probe is a real network request against a
// provider's own CDN; running hundreds sequentially would be needlessly slow, running them all
// at once would be a thundering herd against providers this app still needs to be well-behaved
// towards.
const BACKFILL_CONCURRENCY = 5;

/**
 * THE RETROACTIVE HALF of the image-quality floor — real gap found from a live report: the
 * resolution/dimension gates in syncProvider (above) and providers/live/ticketmaster.ts only
 * protect a row the MOMENT it's (re)synced. A row already sitting in the database from before
 * either gate existed keeps its stale, ungated `imageUrl` until that row's city happens to be
 * resynced again — which, on a pilot-scale app with no constant traffic, can be a real,
 * user-visible delay ("still stretched and distorted" reported minutes after the gate itself
 * shipped and deployed). This re-probes every EXISTING Experience with an image against the
 * exact same floor, so the fix reaches already-synced rows on the very next deploy rather than
 * waiting on that city's own resync cadence.
 *
 * SECOND real gap, found only after that SAME complaint kept recurring even after the first
 * version of this function shipped and ran on every boot: it selected `orderBy: updatedAt desc,
 * take: 300` — the 300 MOST RECENTLY updated rows, every single time. A row that stops being
 * touched by any sync (its provider's feed moved on, or it's simply outside whatever city gets
 * resynced most) never rises back into that top-300 window — it is permanently skipped, forever,
 * no matter how many times the process reboots. That is indistinguishable from "the backfill
 * doesn't work" from the outside, and is exactly the shape of "still seeing the same bad image
 * after every fix" reports. Fixed by fetching the ENTIRE matching set in one query (see this
 * function's own comment below for why that query is a single upfront snapshot, not a re-queried
 * cursor loop) — one call walks every non-exempt row with an image exactly once, however large
 * the catalogue has grown. `maxToCheck` only exists for the admin endpoint's own on-demand
 * testing, never for the boot/periodic callers below, which always run to full completion.
 *
 * MANUAL-sourced images are deliberately excluded — see syncProvider's own `preserveManualImage`
 * comment: an operator's own upload is the one thing an automated pass must never silently
 * clear, regardless of its dimensions. Every other source is re-checked, including ones already
 * gated at sync-time (Ticketmaster, Wikipedia) — a row from before that gate shipped is
 * indistinguishable from one after it without actually re-checking, and a re-check on an
 * already-good image is a cheap no-op.
 */
export async function backfillImageQuality(maxToCheck?: number): Promise<ImageQualityBackfillResult> {
  // A SINGLE upfront query for the full candidate id list, not a re-queried cursor loop — real
  // bug found writing the first version of this fix: Prisma's cursor+skip pagination needs the
  // cursor row to still satisfy the query's own WHERE clause to skip correctly, and this
  // function's WHERE clause (`imageUrl: { not: null }`) is exactly the field THIS function
  // itself mutates mid-run. The moment a page boundary happened to land on a row that had just
  // been cleared, the next page's `skip: 1` silently dropped one real, unprocessed row instead of
  // the (now filtered-out) cursor row — a genuine, reproducible off-by-one, not a flake. Fetching
  // every matching id/url ONCE, before any clearing happens, removes the moving target entirely.
  // At this app's real pilot scale (a handful of UK cities' worth of listings) the full id+url
  // projection is trivially small to hold in memory — nowhere near the shape of problem cursor
  // pagination exists to solve.
  const candidates = await prisma.experience.findMany({
    where: { imageUrl: { not: null }, imageSource: { notIn: ['MANUAL', 'THESPORTSDB'] } },
    select: { id: true, imageUrl: true },
    orderBy: { id: 'asc' },
    ...(maxToCheck !== undefined ? { take: maxToCheck } : {}),
  });

  let cleared = 0;
  for (let i = 0; i < candidates.length; i += BACKFILL_CONCURRENCY) {
    const batch = candidates.slice(i, i + BACKFILL_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (row) => ({ id: row.id, bad: await isImageQualityBad(row.imageUrl!) })),
    );
    const toClear = results.filter((r) => r.bad).map((r) => r.id);
    if (toClear.length) {
      await prisma.experience.updateMany({ where: { id: { in: toClear } }, data: { imageUrl: null, imageSource: null } });
      cleared += toClear.length;
    }
  }

  const checked = candidates.length;
  logger.info({ checked, cleared }, 'Image quality backfill complete');
  return { checked, cleared };
}

export const IMAGE_QUALITY_BACKFILL_JOB_NAME = 'image_quality_backfill';

/**
 * The same DB-backed "is a run actually due" atomic claim as crewRecommendations.ts
 * #claimSweepIfDue — see that function's own comment for the full reasoning (this app's real
 * deployment shape can sleep/restart/scale, so a bare in-memory setInterval/one-shot boot call
 * can't be trusted as the only thing standing between a stale row and the user seeing it). A
 * SEPARATE scheduler row from the recommendation sweep's, not a shared one: this job's job is
 * fundamentally different — it must keep RE-checking rows it already passed before (a provider's
 * CDN can start serving something different later, and any future write path this app doesn't
 * yet know needs gating is only ever caught by something that keeps coming back), not just sweep
 * forward through newly-created rows the way the recommendation sweep does.
 */
async function claimImageQualityBackfillIfDue(dueIntervalMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - dueIntervalMs);
  const now = new Date();

  await prisma.schedulerState.upsert({
    where: { jobName: IMAGE_QUALITY_BACKFILL_JOB_NAME },
    update: {},
    create: { jobName: IMAGE_QUALITY_BACKFILL_JOB_NAME },
  });

  const claim = await prisma.schedulerState.updateMany({
    where: { jobName: IMAGE_QUALITY_BACKFILL_JOB_NAME, OR: [{ lastClaimedAt: null }, { lastClaimedAt: { lt: cutoff } }] },
    data: { lastClaimedAt: now },
  });

  return claim.count === 1;
}

/**
 * The one function server.ts (and, in principle, an external cron hitting
 * `POST /admin/image-quality-backfill`) should call — "run the FULL exhaustive backfill if the
 * database says one is actually due", never "run it because my own timer just fired" or "run it
 * once at boot and hope that was enough". See claimImageQualityBackfillIfDue above.
 */
export async function runImageQualityBackfillIfDue(
  dueIntervalMs: number,
): Promise<{ ran: boolean; result?: ImageQualityBackfillResult }> {
  const claimed = await claimImageQualityBackfillIfDue(dueIntervalMs);
  if (!claimed) {
    return { ran: false };
  }
  const result = await backfillImageQuality();
  await prisma.schedulerState.update({
    where: { jobName: IMAGE_QUALITY_BACKFILL_JOB_NAME },
    data: { lastRunAt: new Date(), lastResult: result as unknown as Prisma.InputJsonValue },
  });
  logger.info({ event: 'image_quality_backfill_ran', ...result }, 'Image quality backfill: ran (database confirmed it was due)');
  return { ran: true, result };
}

export interface MissingImageBackfillResult {
  checked: number;
  filled: number;
}

/**
 * THE RETROACTIVE HALF of the real-image directive — real, explicit, repeated product instruction:
 * "I don't want to see ANY events without a real image." syncProvider's own enrichment chain
 * (provider photo -> Wikipedia/TheSportsDB -> lib/categoryStockImages.ts's live Commons search —
 * see that function's own call site above) only protects a row the MOMENT it's (re)synced. A row
 * already sitting in the database from before that chain existed (or from before the
 * categoryStockImages tier was added) keeps `imageUrl: null` — and the web app's own generated
 * category-art graphic — until that row's city happens to be resynced again, exactly the same gap
 * backfillImageQuality above already exists to close for the dimension floor. Same fix, same
 * shape, for "has no image at all" instead of "has a bad one": re-run the FULL enrichment chain
 * against every existing null-image row, once, on this exact deploy, rather than waiting on
 * whatever that row's own resync cadence happens to be.
 *
 * A `MANUAL` row is never targeted here — imageUrl is only null in the first place if no operator
 * has uploaded one; there's nothing to preserve for a row this query would ever touch.
 */
/**
 * The single-row version of the backfill loop below — pulled out into its own function so the
 * exact same enrichment chain can also run SYNCHRONOUSLY, on demand, for one specific row, not
 * just as part of a full sweep. Real gap this closes: a brand-new Experience can sit with
 * `imageUrl: null` for up to MISSING_IMAGE_BACKFILL_DUE_INTERVAL_MS (6 hours, see server.ts)
 * before the periodic sweep ever reaches it — invisible for routine inventory, but genuinely
 * unacceptable for a Crew's Plot recommendation (crewRecommendations.ts calls this right before
 * delivering one): that is the single highest-visibility, most scrutinised card in the whole
 * product, "one shot to make a good impression" already established for taste-matching and no
 * less true for imagery — it should never ship the generic v2Art fallback graphic when a real
 * photo was genuinely findable at send time, just because the scheduled sweep hadn't reached
 * that row yet. Returns true only when a real image was found, quality-gated, AND written.
 */
export async function enrichMissingImageForExperience(row: { id: string; name: string; category: string }): Promise<boolean> {
  const sportBadge = row.category === 'SPORT' ? await enrichImageFromTheSportsDb(row.name) : null;
  const enriched = sportBadge ?? (await enrichImageFromWikipedia(row.name));
  let imageUrl: string | null = null;
  let imageSource: 'THESPORTSDB' | 'WIKIPEDIA' | 'CATEGORY_STOCK' | 'PEXELS_STOCK' | null = null;
  if (enriched) {
    imageUrl = enriched.url;
    imageSource = sportBadge ? 'THESPORTSDB' : 'WIKIPEDIA';
  } else {
    // Same two-independent-sources reasoning as syncProvider's own call site above — see
    // that comment, and categoryStockImages.ts's/pexelsStockImages.ts's own headers.
    const commonsStock = await getCategoryStockImage(row.category, row.name);
    const pexelsStock = commonsStock ? null : await getPexelsStockImage(row.category, row.name);
    const stock = commonsStock ?? pexelsStock;
    if (stock) {
      imageUrl = stock.url;
      imageSource = commonsStock ? 'CATEGORY_STOCK' : 'PEXELS_STOCK';
    }
  }
  // Same real, provider-agnostic quality floor as syncProvider — a THESPORTSDB badge is
  // exempt (see IMAGE_QUALITY_EXEMPT_SOURCES's own comment), everything else found here gets
  // byte-verified before it's trusted onto a row, not just this function's own metadata-
  // level filtering (categoryStockImages.ts's pool already filters on Commons' own declared
  // size; this is defense in depth against a mismatched/corrupted response, same discipline
  // as every other image source in this app).
  const pickedSource = imageSource;
  const pickedUrl = imageUrl;
  if (imageUrl && imageSource && !IMAGE_QUALITY_EXEMPT_SOURCES.has(imageSource)) {
    if (await isImageQualityBad(imageUrl)) {
      imageUrl = null;
      imageSource = null;
    }
  }
  // Real diagnostic gap found live: a production run with FULL Commons candidate pools
  // (real photos confirmed via categoryStockImages.ts's own "search complete" log) still
  // finished 0/288 filled, with no error/rejection visible anywhere — meaning something
  // between "a candidate was picked" and "the row was updated" was silently discarding it,
  // and there was no per-row log to show which step. This makes every row's own outcome
  // explicit rather than inferring it from an aggregate count.
  try {
    if (imageUrl && imageSource) {
      await prisma.experience.update({ where: { id: row.id }, data: { imageUrl, imageSource } });
      logger.info({ id: row.id, name: row.name, category: row.category, imageSource }, 'Missing-image backfill: row filled');
      return true;
    }
    if (pickedUrl) {
      logger.info({ id: row.id, name: row.name, category: row.category, pickedSource, pickedUrl }, 'Missing-image backfill: candidate found but rejected by the quality gate');
    } else {
      logger.info({ id: row.id, name: row.name, category: row.category }, 'Missing-image backfill: no candidate found from any source');
    }
    return false;
  } catch (err) {
    logger.error({ err, id: row.id, name: row.name, category: row.category, imageUrl, imageSource }, 'Missing-image backfill: DB update failed for this row');
    return false;
  }
}

export async function backfillMissingImages(maxToCheck?: number): Promise<MissingImageBackfillResult> {
  // Same single-upfront-query reasoning as backfillImageQuality above — this function's own WHERE
  // clause is `imageUrl: null`, and this function is exactly the thing that mutates that field, so
  // a re-queried cursor loop would have the identical off-by-one hazard that function's own header
  // comment documents. One snapshot, taken before any writes happen, removes the moving target.
  const candidates = await prisma.experience.findMany({
    where: { imageUrl: null },
    select: { id: true, name: true, category: true },
    orderBy: { id: 'asc' },
    ...(maxToCheck !== undefined ? { take: maxToCheck } : {}),
  });

  let filled = 0;
  for (let i = 0; i < candidates.length; i += BACKFILL_CONCURRENCY) {
    const batch = candidates.slice(i, i + BACKFILL_CONCURRENCY);
    const results = await Promise.all(batch.map((row) => enrichMissingImageForExperience(row)));
    filled += results.filter(Boolean).length;
  }

  const checked = candidates.length;
  logger.info({ checked, filled }, 'Missing-image backfill complete');
  return { checked, filled };
}

export const MISSING_IMAGE_BACKFILL_JOB_NAME = 'missing_image_backfill';

/** Same DB-backed "is a run actually due" atomic claim as claimImageQualityBackfillIfDue above —
 *  see that function's own comment for the full reasoning. A separate scheduler row: this job
 *  targets `imageUrl: null` rows, a disjoint set from the dimension-floor backfill's own
 *  `imageUrl: { not: null }` targets, so the two never compete over the same rows in one run. */
async function claimMissingImageBackfillIfDue(dueIntervalMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - dueIntervalMs);
  const now = new Date();

  await prisma.schedulerState.upsert({
    where: { jobName: MISSING_IMAGE_BACKFILL_JOB_NAME },
    update: {},
    create: { jobName: MISSING_IMAGE_BACKFILL_JOB_NAME },
  });

  const claim = await prisma.schedulerState.updateMany({
    where: { jobName: MISSING_IMAGE_BACKFILL_JOB_NAME, OR: [{ lastClaimedAt: null }, { lastClaimedAt: { lt: cutoff } }] },
    data: { lastClaimedAt: now },
  });

  return claim.count === 1;
}

/**
 * The one function server.ts (and, in principle, an external cron hitting
 * `POST /admin/missing-image-backfill`) should call — see runImageQualityBackfillIfDue above for
 * the full "why not a bare setInterval/one-shot boot call" reasoning; identical shape here.
 */
export async function runMissingImageBackfillIfDue(
  dueIntervalMs: number,
): Promise<{ ran: boolean; result?: MissingImageBackfillResult }> {
  const claimed = await claimMissingImageBackfillIfDue(dueIntervalMs);
  if (!claimed) {
    return { ran: false };
  }
  const result = await backfillMissingImages();
  await prisma.schedulerState.update({
    where: { jobName: MISSING_IMAGE_BACKFILL_JOB_NAME },
    data: { lastRunAt: new Date(), lastResult: result as unknown as Prisma.InputJsonValue },
  });
  logger.info({ event: 'missing_image_backfill_ran', ...result }, 'Missing-image backfill: ran (database confirmed it was due)');
  return { ran: true, result };
}

export interface VenueCityBackfillResult {
  checked: number;
  corrected: number;
  merged: number;
}

/**
 * The retroactive half of syncProvider's own venue-city fix above — corrects every Venue row
 * already mislabelled with the SYNCED city instead of the city it's actually in (see that
 * function's own comment for the full "why": a live provider's own search radius genuinely
 * reaches neighbouring cities, and this used to stamp every one of those real, farther-out
 * results with the wrong city name). The code fix alone only stops NEW mislabelling — production
 * already has real rows sitting under the wrong city from before this shipped, which is exactly
 * what a live report ("I'm in Birmingham... it's showing me events in Sheffield and Chester")
 * was actually seeing. Idempotent and safe to run repeatedly: a venue already labelled correctly
 * is left untouched, so once the existing backlog is corrected this becomes a fast no-op scan on
 * every later run rather than something that ever needs disabling again.
 */
export async function backfillVenueCities(maxToCheck?: number): Promise<VenueCityBackfillResult> {
  const venues = await prisma.venue.findMany({
    select: { id: true, name: true, city: true, latitude: true, longitude: true },
    orderBy: { id: 'asc' },
    ...(maxToCheck !== undefined ? { take: maxToCheck } : {}),
  });

  let corrected = 0;
  let merged = 0;
  for (const venue of venues) {
    const correctCity = nearestPlaceName(venue.latitude, venue.longitude);
    if (correctCity === venue.city) continue;

    // A correctly-labelled venue of the same name may already exist under the real city (e.g. a
    // native Sheffield sync already created "The Foo" there, before a separate Birmingham sync's
    // own wider radius independently mislabelled the same real place under "Birmingham") —
    // repoint its Experiences to the real one and drop the now-empty duplicate, rather than
    // leaving two rows for one real venue.
    const canonical = await prisma.venue.findFirst({ where: { name: venue.name, city: correctCity, NOT: { id: venue.id } } });
    if (canonical) {
      await prisma.experience.updateMany({ where: { venueId: venue.id }, data: { venueId: canonical.id } });
      await prisma.venue.delete({ where: { id: venue.id } });
      merged += 1;
    } else {
      await prisma.venue.update({ where: { id: venue.id }, data: { city: correctCity } });
    }
    corrected += 1;
  }

  const checked = venues.length;
  logger.info({ checked, corrected, merged }, 'Venue-city backfill complete');
  return { checked, corrected, merged };
}

export const VENUE_CITY_BACKFILL_JOB_NAME = 'venue_city_backfill';

/** Same DB-backed "is a run actually due" atomic claim as the other backfills above — see
 *  claimImageQualityBackfillIfDue's own comment for the full reasoning. */
async function claimVenueCityBackfillIfDue(dueIntervalMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - dueIntervalMs);
  const now = new Date();

  await prisma.schedulerState.upsert({
    where: { jobName: VENUE_CITY_BACKFILL_JOB_NAME },
    update: {},
    create: { jobName: VENUE_CITY_BACKFILL_JOB_NAME },
  });

  const claim = await prisma.schedulerState.updateMany({
    where: { jobName: VENUE_CITY_BACKFILL_JOB_NAME, OR: [{ lastClaimedAt: null }, { lastClaimedAt: { lt: cutoff } }] },
    data: { lastClaimedAt: now },
  });

  return claim.count === 1;
}

/**
 * The one function server.ts (and, in principle, an external cron hitting
 * `POST /admin/venue-city-backfill`) should call — see runImageQualityBackfillIfDue above for the
 * full "why not a bare setInterval/one-shot boot call" reasoning; identical shape here. Once
 * production's existing backlog is corrected, every later "due" run finds nothing left to fix and
 * returns quickly — this never needs to be turned off again.
 */
export async function runVenueCityBackfillIfDue(dueIntervalMs: number): Promise<{ ran: boolean; result?: VenueCityBackfillResult }> {
  const claimed = await claimVenueCityBackfillIfDue(dueIntervalMs);
  if (!claimed) {
    return { ran: false };
  }
  const result = await backfillVenueCities();
  await prisma.schedulerState.update({
    where: { jobName: VENUE_CITY_BACKFILL_JOB_NAME },
    data: { lastRunAt: new Date(), lastResult: result as unknown as Prisma.InputJsonValue },
  });
  logger.info({ event: 'venue_city_backfill_ran', ...result }, 'Venue-city backfill: ran (database confirmed it was due)');
  return { ran: true, result };
}
