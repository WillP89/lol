import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { providerRegistry } from '../providers/registry';
import type { ProviderAdapter } from '../providers/types';
import { buildCanonicalKey } from './entityResolution';
import { computeQualityScore } from './qualityScoring';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { enrichImageFromWikipedia, enrichImageFromTheSportsDb } from '../lib/imageEnrichment';
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
