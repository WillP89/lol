import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma, ExperienceCategory } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { config } from '../lib/config';
import { constantTimeEqual } from '../lib/crypto';
import { syncAllProviders, backfillImageQuality, backfillMissingImages, backfillVenueCities } from '../services/inventorySync';
import { providerRegistry } from '../providers/registry';
import { buildCanonicalKey } from '../services/entityResolution';
import { computeQualityScore, MIN_PUBLISHABLE_QUALITY_SCORE } from '../services/qualityScoring';
import { UK_FALLBACK_CENTER, resolveCityCenter } from '../data/ukPlaces';
import { runRecommendationSweep, runSweepIfDue, generateRecommendationForCrew, getOrCreateSettings, explainCrewRecommendation, PLOT_SYSTEM_EMAIL, RECOMMENDATION_SWEEP_DUE_INTERVAL_MS, SWEEP_JOB_NAME } from '../services/crewRecommendations';
import { CANDIDATE_WINDOW_DAYS } from '../services/match';
import { haversineKm } from '../lib/geo';
import { isPlanWorthyForCrew, isTicketedEvent } from '../services/opportunityIntent';
import { runMessageNotificationSweep, runMessageNotificationSweepIfDue, MESSAGE_NOTIFICATION_SWEEP_DUE_INTERVAL_MS } from '../services/messageNotifications';

// Real gap this closes (the "activation harness" — see docs/PILOT_READINESS_AUDIT.md Cycle 12): a
// bare `error` string and a raw count left the caller to work out for themselves whether "0
// results" meant no credential, no network, a rejected auth header, the provider rate-limiting
// us, a real provider outage, or a city that genuinely has nothing right now — exactly the
// ambiguity someone activating a provider for the first time needs resolved without reading this
// file's source. `classifyOutcome` turns the raw error text (every adapter's own fetch throws a
// consistent `"<Provider> API returned <status>: <body>"` shape — see e.g.
// ticketmaster.ts#fetchPage) into one of a small, fixed set of outcomes so the response can be
// read as an answer, not a puzzle.
type ProbeStatus = 'not_configured' | 'auth_failed' | 'rate_limited' | 'unreachable' | 'provider_error' | 'provider_empty' | 'no_matches_for_query' | 'success';
function classifyProbeOutcome(opts: { isLive: boolean; fetchedTotal: number; matchedTotal: number; hadQuery: boolean; rawError: string | null }): ProbeStatus {
  if (!opts.isLive) return 'not_configured';
  if (opts.rawError) {
    // Real bug this specific check fixes, caught by reading this endpoint's own live output
    // rather than assuming the classifier was right: an outbound network policy (this sandbox's
    // own egress proxy, or any other allowlist a real deployment might sit behind) returns a 403
    // that LOOKS identical, at the raw-status level, to the provider itself rejecting a
    // credential — but for a no-credential adapter (OpenStreetMap/FHRS) there is no credential to
    // have failed, and even for a keyed one this 403 never reached the real provider at all.
    // Labelling it `auth_failed` would send someone straight to the wrong place (double-checking
    // an API key that was never the problem). Checked first, before the generic status-code
    // mapping below.
    if (/host not in allowlist/i.test(opts.rawError)) return 'unreachable';
    const statusMatch = opts.rawError.match(/returned (\d{3})/);
    const code = statusMatch ? Number(statusMatch[1]) : null;
    if (code === 401 || code === 403) return 'auth_failed';
    if (code === 429) return 'rate_limited';
    if (code !== null) return 'provider_error';
    return 'unreachable'; // network-level failure (DNS, timeout, connection refused/reset, egress block) — no HTTP status at all
  }
  if (opts.fetchedTotal === 0) return 'provider_empty';
  if (opts.hadQuery && opts.matchedTotal === 0) return 'no_matches_for_query';
  return 'success';
}

interface ProbedProviderResult {
  id: string;
  isLive: boolean;
  status: ProbeStatus;
  error: string | null;
  fetchedTotal: number;
  matched: number;
  events: { name: string; category: string; subcategories: string[]; venueName: string; startsAt: Date; withinRecommendationWindow: boolean; externalUrl: string }[];
}

/**
 * The shared core behind both `/inventory-probe` (one city/query at a time, full event detail)
 * and `/pilot-certification` (the same probe run across a fixed spread of real Crew intents in
 * one shot) — calls `fetchListings`+`mapToCanonical` on every matching registered adapter
 * directly, bypassing the DB, quality scoring, and dedup entirely, so both endpoints share one
 * real implementation of "what does a live provider actually have right now" rather than two that
 * could quietly drift apart.
 */
async function probeProviders(opts: { city: string; days: number; q?: string; providerId?: string }): Promise<{ center: ReturnType<typeof resolveCityCenter>; providers: ProbedProviderResult[] }> {
  const { city, days, q, providerId } = opts;
  const center = resolveCityCenter(city);
  const fromDate = new Date();
  const toDate = new Date();
  toDate.setDate(toDate.getDate() + days);
  const recommendationWindowEnd = new Date();
  recommendationWindowEnd.setDate(recommendationWindowEnd.getDate() + CANDIDATE_WINDOW_DAYS);

  const adapters = providerRegistry.filter((a) => !providerId || a.id === providerId);
  const providers = await Promise.all(
    adapters.map(async (adapter): Promise<ProbedProviderResult> => {
      if (!adapter.isLive) return { id: adapter.id, isLive: false, status: 'not_configured', error: null, fetchedTotal: 0, matched: 0, events: [] };
      try {
        const raw = await adapter.fetchListings({ city, fromDate, toDate });
        const mapped = raw
          .map((listing) => {
            try {
              return adapter.mapToCanonical(listing);
            } catch (err) {
              return { __error: err instanceof Error ? err.message : String(err) } as never;
            }
          })
          .filter((m): m is ReturnType<typeof adapter.mapToCanonical> => !(m as { __error?: string }).__error);
        const needle = q?.toLowerCase();
        const filtered = needle
          ? mapped.filter((m) => m.name.toLowerCase().includes(needle) || m.subcategories.some((s) => s.toLowerCase().includes(needle)) || m.description.toLowerCase().includes(needle))
          : mapped;
        // fetchListings() deliberately swallows its own network/API failures and returns [] (see
        // e.g. openStreetMap.ts's fetchListings) so one down provider can never crash a real
        // inventory sync sweep — but that same swallowing made this probe indistinguishable from
        // "genuinely zero real inventory here": a raw fetch that failed outright and a city that
        // truly has nothing both showed fetchedTotal: 0, error: null. Real gap this closes: when
        // the raw fetch came back empty, ask the adapter's own healthCheck() whether that's
        // because it's actually unreachable right now, and surface that reason instead of a
        // silent zero — the one piece of evidence this whole probe exists to give.
        const unexplainedEmpty = mapped.length === 0 ? await adapter.healthCheck().catch(() => null) : null;
        const rawError = unexplainedEmpty && unexplainedEmpty.status === 'DOWN' ? unexplainedEmpty.error ?? 'Provider health check reports DOWN' : null;
        return {
          id: adapter.id,
          isLive: true,
          status: classifyProbeOutcome({ isLive: true, fetchedTotal: mapped.length, matchedTotal: filtered.length, hadQuery: Boolean(needle), rawError }),
          error: rawError,
          fetchedTotal: mapped.length,
          matched: filtered.length,
          events: filtered
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
            .slice(0, 100)
            .map((m) => ({
              name: m.name,
              category: m.category,
              subcategories: m.subcategories,
              venueName: m.venueName,
              startsAt: m.startsAt,
              withinRecommendationWindow: m.startsAt <= recommendationWindowEnd,
              externalUrl: m.externalUrl,
            })),
        };
      } catch (err) {
        const rawError = err instanceof Error ? err.message : String(err);
        return { id: adapter.id, isLive: true, status: classifyProbeOutcome({ isLive: true, fetchedTotal: 0, matchedTotal: 0, hadQuery: Boolean(q), rawError }), error: rawError, fetchedTotal: 0, matched: 0, events: [] };
      }
    }),
  );

  return { center, providers };
}

/**
 * Internal operator tooling (brief §29 admin console, §64 operating dashboard). Gated by a
 * single shared secret (`x-admin-key` header, `ADMIN_API_KEY` env) — a deliberately minimal
 * stopgap, not real role-based admin auth. Upgrading this the moment there's more than one
 * operator (a User.role enum + session-based admin auth, not a shared header secret) is a
 * pre-launch requirement, not a nice-to-have — see docs/DECISIONS.md#admin-auth.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    // Real gap found operating this for the first time: every admin route needed a header,
    // which meant a plain browser tab (paste a URL, done) couldn't reach any of them — the
    // operator had to have curl/Postman handy. A `?key=` query param is weaker as a secret
    // transport (URLs end up in browser history/server access logs) but this is still the same
    // single shared secret either way, not a downgrade in WHO can authenticate — only in where
    // the value can leak to. Acceptable for a pilot's read-mostly ops routes; see the doc-
    // comment above on why this whole scheme needs replacing before real launch regardless.
    const key = request.headers['x-admin-key'] ?? (request.query as Record<string, string> | undefined)?.key;
    // constantTimeEqual over plain `!==`: this is the ONE secret gating every /admin/* route
    // (see this function's own doc comment on how minimal that is already) — a `!==` comparison
    // returns as soon as the first differing byte is found, which is a real, well-documented
    // timing side channel for guessing a secret character-by-character. crypto.ts already built
    // this exact primitive for session-token comparison; reusing it here costs nothing.
    if (typeof key !== 'string' || !constantTimeEqual(key, config.ADMIN_API_KEY)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // Real gap this closes: registry.ts's own comment promised this endpoint would surface "is a
  // real live provider actually configured, or is this city silently running on mock/OSM-only
  // data" — but it only ever returned DB rows already synced, which is empty (or just whichever
  // mock/OSM rows exist) whenever a key was never set, since an unconfigured adapter isn't even
  // registered (see registry.ts's own `liveTicketedProviders`) and so never gets the chance to
  // write a row at all. `registered` now reports the actual truth for every adapter this process
  // currently has — live or mock, and exactly why (`healthCheck()`'s own real error, e.g.
  // "TICKETMASTER_API_KEY not configured") — so "why is there no real boxing/MMA inventory
  // anywhere" is answerable by hitting this endpoint, not by guessing at env vars.
  app.get('/providers', async (_request, reply) => {
    const providers = await prisma.provider.findMany({ include: { _count: { select: { listings: true } } } });
    const registered = await Promise.all(
      providerRegistry.map(async (adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        categories: adapter.categories,
        isLive: adapter.isLive,
        health: await adapter.healthCheck().catch((err) => ({ status: 'DOWN' as const, error: err instanceof Error ? err.message : String(err), checkedAt: new Date() })),
      })),
    );
    // The categories NO currently-registered live adapter covers at all — e.g. SPORT has no
    // source whatsoever unless Ticketmaster, Skiddle, or PredictHQ is configured with a real
    // key; mock/OSM never cover it. Making this explicit is the whole point: a category with
    // zero coverage here can never return real inventory, anywhere, for anyone, no matter how
    // correct the matching/eligibility logic is — that's a data gap, not a bug to debug further.
    const liveCategories = new Set(registered.filter((r) => r.isLive).flatMap((r) => r.categories));
    const allCategories = [...new Set(providerRegistry.flatMap((a) => a.categories))];
    const categoriesWithNoLiveSource = allCategories.filter((c) => !liveCategories.has(c));
    return reply.send({ providers, registered, categoriesWithNoLiveSource });
  });

  // Which live adapter id genuinely produces a real, bookable ticket/action URL vs. a Maps
  // search or a website link — a structural fact about the adapter, not something any single
  // row's data can tell you. See each adapter's own header comment (docs/providers/ticketing.md,
  // food-and-places.md) for the sourcing of each of these.
  const TICKET_CAPABLE_PROVIDER_IDS = new Set(['ticketmaster', 'skiddle', 'eventbrite', 'mock_ticketing', 'manual_curation']);
  // Adapter ids that never produced this process's own fabricated data — see MOCK_PROVIDER_IDS'
  // own comment in crewRecommendations.ts for why this exact set (not "every non-live adapter")
  // is what actually defines "mock" for proactive-eligibility purposes.
  const MOCK_PROVIDER_IDS = new Set(['mock_ticketing', 'mock_restaurants', 'mock_activities']);
  type ProvenanceClass = 'REAL_PROVIDER' | 'MANUAL_REAL' | 'MOCK' | 'UNKNOWN';
  function classifyProvenance(taggedProvider: string | undefined, listingProviderIds: string[]): ProvenanceClass {
    // Experience.tags.provider (set by whichever adapter's mapToCanonical authored this row's
    // own canonical fields) is the primary signal — the same field isRealProvenance() reads in
    // crewRecommendations.ts, so this diagnostic classifies rows the exact same way the real
    // eligibility gate does, not a parallel guess. A row with no tags.provider at all is either
    // POST /admin/experiences/manual (always writes `tags: {}` — see opportunityIntent.ts's own
    // comment on deriveSourceKind) or mockRestaurantProvider/mockActivityProvider (neither sets
    // tags.provider either — see those two files directly). Both cases fall back to the row's
    // own ProviderListing.providerId, which every ingestion path sets correctly regardless of
    // what ends up in tags, to tell those two genuinely different cases apart.
    if (taggedProvider) {
      if (MOCK_PROVIDER_IDS.has(taggedProvider)) return 'MOCK';
      if (taggedProvider === 'manual_curation') return 'MANUAL_REAL';
      return 'REAL_PROVIDER';
    }
    if (listingProviderIds.includes('manual_curation')) return 'MANUAL_REAL';
    if (listingProviderIds.some((id) => MOCK_PROVIDER_IDS.has(id))) return 'MOCK';
    if (listingProviderIds.length > 0) return 'REAL_PROVIDER';
    return 'UNKNOWN';
  }

  /**
   * STEP 3 of the live "establish exactly what I'm actually running" directive: one screen that
   * answers, without exposing any secret, "is Plot operating on real supply right now, in THIS
   * running process, against THIS database". Everything below is read from this process's own
   * live state (env vars, a light healthCheck() per adapter — no new outbound calls this codebase
   * doesn't already make elsewhere, no speculative live-provider fetch) — never guessed, never
   * cached from a previous deploy.
   */
  app.get('/environment-truth', async (_request, reply) => {
    // Render and Railway both inject their own git-commit env var into every deployed service
    // automatically — no config needed on our side (same pattern resolvePublicApiUrl() already
    // uses for RENDER_EXTERNAL_URL/RAILWAY_PUBLIC_DOMAIN, see lib/config.ts). `unknown` (not a
    // fabricated commit) on any host that doesn't set either — e.g. this sandbox, or a bare VPS.
    const deployedCommit = process.env.RENDER_GIT_COMMIT ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown';
    const deployedBranch = process.env.RENDER_GIT_BRANCH ?? process.env.RAILWAY_GIT_BRANCH ?? 'unknown';
    const hostPlatform = process.env.RENDER_GIT_COMMIT ? 'render' : process.env.RAILWAY_GIT_COMMIT_SHA ? 'railway' : 'unknown';

    // Safe-to-display DB identity: host + database name only, credentials stripped. Never the
    // connection string itself — a malformed DATABASE_URL fails safe to 'unparseable', never a
    // partial leak of whatever WAS parseable.
    let databaseIdentifier = 'unparseable';
    try {
      const u = new URL(config.DATABASE_URL);
      databaseIdentifier = `${u.hostname}${u.pathname}`;
    } catch {
      // leave as 'unparseable'
    }

    // Same computation `/health/scheduler` (app.ts) uses, inlined here so this one screen never
    // requires a second request to see whether the background sweep is actually alive.
    const schedulerState = await prisma.schedulerState.findUnique({ where: { jobName: SWEEP_JOB_NAME } });
    const lastRunAt = schedulerState?.lastRunAt ?? null;
    const nextDueAt = lastRunAt ? new Date(lastRunAt.getTime() + RECOMMENDATION_SWEEP_DUE_INTERVAL_MS) : null;
    const schedulerGraceMs = 30 * 60 * 1000;
    const schedulerOverdue = nextDueAt !== null && Date.now() - nextDueAt.getTime() > schedulerGraceMs;

    const registered = await Promise.all(
      providerRegistry.map(async (adapter) => {
        const dbRow = await prisma.provider.findUnique({ where: { id: adapter.id } });
        const health = await adapter.healthCheck().catch((err) => ({ status: 'DOWN' as const, error: err instanceof Error ? err.message : String(err), checkedAt: new Date() }));
        return {
          id: adapter.id,
          displayName: adapter.displayName,
          categories: adapter.categories,
          configured: adapter.isLive,
          reachableNow: health.status !== 'DOWN',
          reachabilityError: health.status === 'DOWN' ? health.error ?? null : null,
          lastSuccessfulSyncAt: dbRow && dbRow.status !== 'DOWN' ? dbRow.lastHealthCheckAt?.toISOString() ?? null : null,
          lastSyncError: dbRow?.status === 'DOWN' ? dbRow.lastError : null,
          ticketCapable: TICKET_CAPABLE_PROVIDER_IDS.has(adapter.id),
          provenanceIfUsed: MOCK_PROVIDER_IDS.has(adapter.id) ? 'MOCK' : adapter.id === 'manual_curation' ? 'MANUAL_REAL' : 'REAL_PROVIDER',
        };
      }),
    );

    // Every Experience whose date still falls in the real recommendation window — the same
    // CANDIDATE_WINDOW_DAYS the live scorer itself uses, so "future opportunities" here means
    // the same thing it means to a real Crew, not just "anything with startsAt > now". Safety-
    // capped the same way /experiences-near already is; a real pilot's live table is nowhere
    // near this size yet.
    const windowEnd = new Date();
    windowEnd.setDate(windowEnd.getDate() + CANDIDATE_WINDOW_DAYS);
    const futureExperiences = await prisma.experience.findMany({
      where: { startsAt: { gte: new Date(), lte: windowEnd } },
      select: {
        tags: true,
        bookingStatus: true,
        priceMinMinor: true,
        qualityScore: true,
        listings: { select: { providerId: true }, take: 5 },
      },
      take: 10000,
    });

    const provenanceTotals: Record<ProvenanceClass, number> = { REAL_PROVIDER: 0, MANUAL_REAL: 0, MOCK: 0, UNKNOWN: 0 };
    const perProviderCounts = new Map<string, { future: number; eligible: number }>();
    for (const exp of futureExperiences) {
      const taggedProvider = (exp.tags as Record<string, unknown> | null)?.provider;
      const listingProviderIds = exp.listings.map((l) => l.providerId);
      const cls = classifyProvenance(typeof taggedProvider === 'string' ? taggedProvider : undefined, listingProviderIds);
      provenanceTotals[cls] += 1;

      // Best-guess "which registered adapter" for the per-provider breakdown below — the tagged
      // provider when present, else the first real ProviderListing this row actually has.
      const attributedProviderId = (typeof taggedProvider === 'string' ? taggedProvider : null) ?? listingProviderIds[0] ?? 'unattributed';
      const bucket = perProviderCounts.get(attributedProviderId) ?? { future: 0, eligible: 0 };
      bucket.future += 1;
      // Structural eligibility only — ticketed + above the real publishable-quality floor + not
      // MOCK. This is NOT "would be sent to a real Crew" (that also needs a specific Crew's own
      // taste-contradiction check, which has no meaning outside a real Crew context — see
      // isProactivelyEligible() in crewRecommendations.ts) — it's "could this row ever qualify
      // for anyone", the honest ceiling this diagnostic can report without fabricating a Crew.
      if (isTicketedEvent(exp) && exp.qualityScore >= MIN_PUBLISHABLE_QUALITY_SCORE && cls !== 'MOCK') bucket.eligible += 1;
      perProviderCounts.set(attributedProviderId, bucket);
    }

    const providers = registered.map((r) => ({
      ...r,
      futureOpportunities: perProviderCounts.get(r.id)?.future ?? 0,
      structurallyEligibleForProactivePlot: perProviderCounts.get(r.id)?.eligible ?? 0,
    }));

    return reply.send({
      environment: config.NODE_ENV,
      deployedCommit,
      deployedBranch,
      hostPlatform,
      databaseIdentifier,
      backgroundWorker: {
        // No separate worker process exists (see docs/DEPLOYMENT.md Step 2.6) — the sweep runs
        // in-process on the same deployed commit as everything else, woken by this same host's
        // own 15-minute in-process poll plus (on Render) the external wake-scheduler ping.
        runsInProcess: true,
        deployedCommit,
        lastRunAt: lastRunAt?.toISOString() ?? null,
        nextDueAt: nextDueAt?.toISOString() ?? null,
        overdue: schedulerOverdue,
        neverRun: lastRunAt === null,
      },
      providers,
      inventoryProvenanceTotals: provenanceTotals,
      recommendationWindowDays: CANDIDATE_WINDOW_DAYS,
      minPublishableQualityScore: MIN_PUBLISHABLE_QUALITY_SCORE,
    });
  });

  /**
   * Real, live-reported question this exists to answer directly rather than by guessing: "the
   * Ticketmaster key is confirmed live — other events show up — so why does boxing/MMA never
   * appear?" `/providers` above only ever confirms a key is CONFIGURED; it never actually asks
   * a live provider what it currently has. This calls `fetchListings`+`mapToCanonical` on every
   * currently-registered adapter directly — bypassing the DB, quality scoring, and dedup
   * entirely — over a WIDE window (default 90 days, `days` query param), then reports each
   * result's real classified category/genre and, critically, whether it actually falls inside
   * `CANDIDATE_WINDOW_DAYS` (21 — the real window Crew recommendations and Explore search) or
   * only within this endpoint's own wider probe window. A real event that exists on Ticketmaster
   * but is scheduled 6 weeks out is a genuinely different problem (the recommendation window is
   * too narrow for an infrequent category) from Ticketmaster having nothing at all — this
   * endpoint is what tells the two apart instead of leaving it a guess.
   */
  app.get('/inventory-probe', async (request, reply) => {
    const Schema = z.object({
      city: z.string().default(UK_FALLBACK_CENTER.name),
      days: z.coerce.number().int().positive().max(180).default(90),
      // Free-text filter against the event name/venue/genre — case-insensitive substring match,
      // e.g. `q=boxing` or `q=mma`. Optional; omitting it returns everything a provider has.
      q: z.string().optional(),
      provider: z.string().optional(), // filter to one adapter id, e.g. `ticketmaster`
    });
    const parsed = Schema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { city, days, q, provider } = parsed.data;

    const { center, providers } = await probeProviders({ city, days, q, providerId: provider });
    return reply.send({
      city,
      center,
      probeWindowDays: days,
      recommendationWindowDays: CANDIDATE_WINDOW_DAYS,
      providers,
    });
  });

  /**
   * The "run the whole certification pass" version of `/inventory-probe` above — the mission's
   * own explicit ask: one command that answers "what does Plot itself find" for a representative
   * spread of real Crew intents in one shot, instead of running `/inventory-probe?q=...` by hand
   * eight times and assembling the table yourself. Diagnostic only, same as `/inventory-probe` —
   * never writes to the database, never sends anything into a real Crew's chat. `INTENTS` below is
   * the same 8-intent list docs/PILOT_READINESS_AUDIT.md's own Cycle 8 coverage matrix used, kept
   * in sync deliberately: that matrix was built by hand from reading provider source and running
   * this exact kind of probe manually; this endpoint is what makes re-running it, once real
   * credentials/network exist, take one request instead of a repeat of that same manual work.
   */
  const INTENTS: { label: string; city: string; q: string; expectedCategory: string }[] = [
    { label: 'Alternative rock', city: 'Birmingham', q: 'rock', expectedCategory: 'LIVE_MUSIC' },
    { label: 'UK garage / house', city: 'Birmingham', q: 'garage', expectedCategory: 'CLUBBING' },
    { label: 'Comedy', city: 'Birmingham', q: 'comedy', expectedCategory: 'COMEDY' },
    { label: 'Football', city: 'Birmingham', q: 'football', expectedCategory: 'SPORT' },
    { label: 'Japanese food', city: 'Birmingham', q: 'japanese', expectedCategory: 'RESTAURANT' },
    { label: 'Food festival / market', city: 'Birmingham', q: 'market', expectedCategory: 'FESTIVAL' },
    { label: 'Theatre', city: 'Birmingham', q: 'theatre', expectedCategory: 'THEATRE' },
    { label: 'Social activity (bowling/escape room)', city: 'Birmingham', q: 'bowling', expectedCategory: 'DAY_ACTIVITY' },
  ];
  app.get('/pilot-certification', async (request, reply) => {
    const Schema = z.object({ city: z.string().optional(), days: z.coerce.number().int().positive().max(180).default(90) });
    const parsed = Schema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { city: cityOverride, days } = parsed.data;

    const results = await Promise.all(
      INTENTS.map(async (intent) => {
        const city = cityOverride ?? intent.city;
        const { providers } = await probeProviders({ city, days, q: intent.q });
        const attempted = providers.length;
        const successful = providers.filter((p) => p.status === 'success').length;
        const rawTotal = providers.reduce((sum, p) => sum + p.fetchedTotal, 0);
        const relevantTotal = providers.reduce((sum, p) => sum + p.matched, 0);
        const categoryMatches = providers.reduce((sum, p) => sum + p.events.filter((e) => e.category === intent.expectedCategory).length, 0);
        // GOOD/PARTIAL/POOR/UNSUPPORTED/LIVE_VALIDATION_REQUIRED — the same rating vocabulary
        // docs/PILOT_READINESS_AUDIT.md's Cycle 8 matrix used by hand, now computed from this
        // run's real data: UNSUPPORTED when no provider that even CLAIMS to cover this category
        // is live (checked against the adapter's own registered `categories`, not just "is any
        // adapter live at all" — a real bug this exact line fixes: the first version reported
        // "Football"/"Food festival" as LIVE_VALIDATION_REQUIRED because OpenStreetMap/FHRS are
        // always live, even though neither one's own `categories` array has ever claimed SPORT or
        // FESTIVAL — no amount of network access would make either return a football fixture);
        // LIVE_VALIDATION_REQUIRED when a covering provider IS live but every one is unreachable/
        // erroring (this sandbox's own permanent state); GOOD/PARTIAL/POOR once real data
        // actually comes back, scaled by how much of it matches the expected category
        // specifically (not just the free-text query).
        const coveringLiveAdapters = providerRegistry.filter((a) => a.isLive && a.categories.includes(intent.expectedCategory as ExperienceCategory));
        const anyConfigured = coveringLiveAdapters.length > 0;
        const anyReachableButEmptyOrError = providers.some((p) => coveringLiveAdapters.some((a) => a.id === p.id) && p.status !== 'success');
        let viability: string;
        if (!anyConfigured) viability = 'UNSUPPORTED';
        else if (categoryMatches === 0 && anyReachableButEmptyOrError && successful === 0) viability = 'LIVE_VALIDATION_REQUIRED';
        else if (categoryMatches >= 5) viability = 'GOOD';
        else if (categoryMatches >= 1) viability = 'PARTIAL';
        else viability = 'POOR';

        return {
          intent: intent.label,
          expectedCategory: intent.expectedCategory,
          city,
          providersAttempted: attempted,
          providersSuccessful: successful,
          rawOpportunities: rawTotal,
          relevantOpportunities: relevantTotal,
          categoryMatchedOpportunities: categoryMatches,
          recommendationViability: viability,
          perProvider: providers.map((p) => ({ id: p.id, status: p.status, fetchedTotal: p.fetchedTotal, matched: p.matched })),
        };
      }),
    );

    return reply.send({ probeWindowDays: days, ranAt: new Date().toISOString(), intents: results });
  });

  // Real gap this closes: `/inventory-probe` shows what a LIVE provider would return right now
  // (bypassing the database entirely), and `/providers` shows aggregate DB counts per provider —
  // neither answers the actual question "what does the automatic engine's own scorer see for
  // THIS city right now, and why did each nearby candidate pass or fail". That gap is exactly
  // what turned a live "0 scored / 0 in radius" incident into several rounds of guessing: sync
  // completing cleanly proves listings exist somewhere, not that any of them are the RIGHT
  // category, within date, above the quality floor, or "plan-worthy" — every one of which is a
  // silent, separate way to end up with zero. This mirrors `scoreExperiencesForCrew`'s own gates
  // (services/match.ts) exactly, read-only, without needing a live Crew id — the diagnostics
  // page's per-Crew explain already covers "why didn't THIS Crew get sent something"; this
  // covers "what does the database actually hold near this city, full stop".
  app.get('/experiences-near', async (request, reply) => {
    const Schema = z.object({
      city: z.string().default(UK_FALLBACK_CENTER.name),
      radiusKm: z.coerce.number().positive().max(500).default(50),
      category: z.string().optional(), // e.g. SPORT, CLUBBING, LIVE_MUSIC — filters after distance, same order as the real scorer's own gates
      limit: z.coerce.number().int().positive().max(200).default(40),
    });
    const parsed = Schema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { city, radiusKm, category, limit } = parsed.data;

    const center = resolveCityCenter(city);
    const windowStart = new Date();
    const windowEnd = new Date();
    windowEnd.setDate(windowEnd.getDate() + CANDIDATE_WINDOW_DAYS);
    windowEnd.setHours(23, 59, 59, 999);

    // Every row with a real venue location, category-filtered at the DB level (cheap, and the
    // one gate genuinely safe to apply before distance) — everything else is annotated rather
    // than pre-filtered, so a candidate excluded for, say, a low quality score is still SHOWN as
    // excluded-and-why, not silently absent the same way "0 scored" alone was.
    const rows = await prisma.experience.findMany({
      where: {
        venueId: { not: null }, // no coordinates, no distance to compute — Venue.latitude/longitude are non-nullable once a venue exists
        ...(category ? { category: category as ExperienceCategory } : {}),
      },
      include: { venue: true },
      take: 3000, // safety cap, same shape as match.ts's own proximity projection
    });

    const withDistance = rows
      .filter((e) => e.venue !== null)
      .map((e) => ({
        experience: e,
        distanceKm: haversineKm(center.lat, center.lng, e.venue!.latitude, e.venue!.longitude),
      }))
      .filter((r) => r.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit);

    return reply.send({
      city,
      center,
      radiusKm,
      category: category ?? null,
      recommendationWindowDays: CANDIDATE_WINDOW_DAYS,
      minPublishableQualityScore: MIN_PUBLISHABLE_QUALITY_SCORE,
      totalWithinRadius: withDistance.length,
      experiences: withDistance.map(({ experience: e, distanceKm }) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        subcategories: e.subcategories,
        venueName: e.venue?.name ?? null,
        venueCity: e.venue?.city ?? null,
        distanceKm: Math.round(distanceKm * 10) / 10,
        startsAt: e.startsAt,
        bookingStatus: e.bookingStatus,
        qualityScore: e.qualityScore,
        hasImage: Boolean(e.imageUrl),
        imageSource: e.imageSource,
        // The exact same three gates scoreExperiencesForCrew applies as `hardConstraints`, plus
        // the separate plan-worthiness gate applied after preference filtering — spelled out
        // individually so "why isn't this reaching a Crew" never requires re-deriving the gate
        // logic from a raw row by hand.
        passesQualityGate: e.qualityScore >= MIN_PUBLISHABLE_QUALITY_SCORE,
        passesDateWindow: e.startsAt >= windowStart && e.startsAt <= windowEnd,
        passesBookingStatus: e.bookingStatus !== 'SOLD_OUT',
        isPlanWorthy: isPlanWorthyForCrew(e),
      })),
    });
  });

  app.post('/sync', async (request, reply) => {
    // No hardcoded London default — an operator who forgets to specify a city gets the same
    // genuinely UK-central fallback every other unset-city path in the app uses (see
    // docs/DECISIONS.md#uk-wide-location), not a silent London bias in ops tooling nobody
    // audits as often as user-facing code.
    const Schema = z.object({ city: z.string().default(UK_FALLBACK_CENTER.name) });
    const parsed = Schema.safeParse(request.body ?? {});
    const city = parsed.success ? parsed.data.city : UK_FALLBACK_CENTER.name;
    const results = await syncAllProviders(city);
    return reply.send({ results });
  });

  // Manual re-trigger for the retroactive image-quality pass (also runs once automatically on
  // boot — see server.ts) — for re-running it on demand without waiting for a redeploy, e.g.
  // right after tightening the quality floor itself.
  app.post('/image-quality-backfill', async (request, reply) => {
    const Schema = z.object({ limit: z.number().int().positive().max(2000).optional() });
    const parsed = Schema.safeParse(request.body ?? {});
    const result = await backfillImageQuality(parsed.success ? parsed.data.limit : undefined);
    return reply.send({ result });
  });

  // Manual re-trigger for the retroactive real-image pass (also runs once automatically on boot
  // — see server.ts) — the explicit product directive this exists for: "I don't want to see ANY
  // events without a real image." For re-running it on demand rather than waiting for a redeploy,
  // e.g. right after this endpoint's own live inventory changed.
  app.post('/missing-image-backfill', async (request, reply) => {
    const Schema = z.object({ limit: z.number().int().positive().max(2000).optional() });
    const parsed = Schema.safeParse(request.body ?? {});
    const result = await backfillMissingImages(parsed.success ? parsed.data.limit : undefined);
    return reply.send({ result });
  });

  // Manual re-trigger for the retroactive venue-city correction (also runs once automatically on
  // boot, then on the same due cadence as the two image backfills — see server.ts). Real,
  // live-reported bug this exists for: "I'm in Birmingham... it's showing me events in Sheffield
  // and Chester" — see services/inventorySync.ts#backfillVenueCities's own comment for the full
  // "why". For re-running it on demand rather than waiting for the next due check.
  app.post('/venue-city-backfill', async (request, reply) => {
    const Schema = z.object({ limit: z.number().int().positive().max(5000).optional() });
    const parsed = Schema.safeParse(request.body ?? {});
    const result = await backfillVenueCities(parsed.success ? parsed.data.limit : undefined);
    return reply.send({ result });
  });

  /**
   * Manual/local inventory ingestion — the "Phase 1" supply path for providers that have no
   * self-serve API (independent venues, OpenTable-gated restaurants; see
   * docs/providers/restaurants.md). Goes through the exact same canonical pipeline
   * (canonicalKey, quality scoring) as an automated provider sync, so Match can't tell the
   * difference between an API-sourced and a hand-entered Experience.
   */
  const ManualExperienceSchema = z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    category: z.enum([
      'LIVE_MUSIC', 'CLUBBING', 'RESTAURANT', 'BAR', 'COMEDY', 'THEATRE', 'CINEMA',
      'ART_CULTURE', 'SPORT', 'FITNESS', 'FESTIVAL', 'DAY_ACTIVITY', 'COMMUNITY',
    ]),
    venueName: z.string().min(1),
    city: z.string().default(UK_FALLBACK_CENTER.name),
    latitude: z.number(),
    longitude: z.number(),
    startsAt: z.string(),
    priceMinMinor: z.number().int().nonnegative().nullable().default(null),
    priceMaxMinor: z.number().int().nonnegative().nullable().default(null),
    externalUrl: z.string().url(),
    // Real gap this closes: this endpoint hardcoded `imageUrl: null` regardless of input, so an
    // operator entering a genuine restaurant/venue photo (exactly the "direct venue
    // relationships" pilot path docs/providers/restaurants.md describes as the realistic
    // near-term route to real imagery for RESTAURANT/BAR) had no way to attach it — every
    // manually-curated listing fell back to the editorial mark even when a real photo existed.
    imageUrl: z.string().url().nullable().default(null),
    // Real gap this closes: every live provider adapter sends subcategory strings (Ticketmaster
    // genres, Skiddle event codes, OSM cuisine tags — see providers/live/*.ts), which the
    // personalisation-engine pass now actually matches against Plot's own interest taxonomy
    // (services/tasteSignals.ts#experienceInterestTags) — but this endpoint hardcoded `[]`
    // regardless of input, so a manually-curated listing could never carry that signal. An
    // operator can tag one directly (e.g. `["uk garage"]`); a raw string that doesn't match the
    // taxonomy is simply never matched by anything, same as an unrecognised provider genre.
    subcategories: z.array(z.string()).default([]),
  });
  app.post('/experiences/manual', async (request, reply) => {
    const parsed = ManualExperienceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    const input = parsed.data;

    await prisma.provider.upsert({
      where: { id: 'manual_curation' },
      update: {},
      create: { id: 'manual_curation', name: 'Manual curation', categories: [input.category] },
    });

    let venue = await prisma.venue.findFirst({ where: { name: input.venueName, city: input.city } });
    if (!venue) {
      venue = await prisma.venue.create({
        data: { name: input.venueName, city: input.city, latitude: input.latitude, longitude: input.longitude },
      });
    }

    const canonicalInput = {
      name: input.name,
      description: input.description,
      category: input.category,
      subcategories: input.subcategories,
      venueName: input.venueName,
      latitude: input.latitude,
      longitude: input.longitude,
      startsAt: new Date(input.startsAt),
      endsAt: null,
      timezone: 'Europe/London',
      priceMinMinor: input.priceMinMinor,
      priceMaxMinor: input.priceMaxMinor,
      currency: 'GBP',
      bookingStatus: 'AVAILABLE' as const,
      imageUrl: input.imageUrl,
      imageSource: input.imageUrl ? ('MANUAL' as const) : null,
      tags: {},
      externalUrl: input.externalUrl,
      commissionEligible: false,
    };
    const canonicalKey = buildCanonicalKey(canonicalInput);
    const qualityScore = computeQualityScore(canonicalInput, new Date());

    // Real bug found via testing this endpoint for the first time (not assumed): `canonicalInput`
    // above is shaped for `buildCanonicalKey`/`computeQualityScore` (brief's CanonicalEvent
    // shape — venueName/latitude/longitude/externalUrl/commissionEligible included), but none of
    // those fields exist on the `Experience` model itself (venue location lives on `Venue`,
    // provider/booking-link details on `ProviderListing`) — spreading it straight into
    // `experience.upsert` therefore threw a Prisma validation error on every call, silently
    // making this entire manual-curation endpoint (the "no self-serve API" supply path — see
    // docs/providers/restaurants.md) unusable. Only the fields that are real Experience columns
    // go into the actual write.
    const experienceData = {
      name: canonicalInput.name,
      description: canonicalInput.description,
      category: canonicalInput.category,
      subcategories: canonicalInput.subcategories,
      startsAt: canonicalInput.startsAt,
      endsAt: canonicalInput.endsAt,
      timezone: canonicalInput.timezone,
      priceMinMinor: canonicalInput.priceMinMinor,
      priceMaxMinor: canonicalInput.priceMaxMinor,
      currency: canonicalInput.currency,
      bookingStatus: 'AVAILABLE' as const,
      imageUrl: canonicalInput.imageUrl,
      tags: canonicalInput.tags,
    };

    const experience = await prisma.experience.upsert({
      where: { canonicalKey },
      update: { ...experienceData, venueId: venue.id, qualityScore },
      create: { ...experienceData, canonicalKey, venueId: venue.id, qualityScore },
    });

    await prisma.providerListing.upsert({
      where: { providerId_providerListingId: { providerId: 'manual_curation', providerListingId: experience.id } },
      update: { experienceId: experience.id, externalUrl: input.externalUrl, lastRefreshedAt: new Date() },
      create: {
        providerId: 'manual_curation',
        providerListingId: experience.id,
        experienceId: experience.id,
        rawPayload: input as Prisma.InputJsonValue,
        externalUrl: input.externalUrl,
        lastRefreshedAt: new Date(),
      },
    });

    return reply.code(201).send({ experience });
  });

  app.get('/dashboard', async (_request, reply) => {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [userCount, crewCount, planCounts, bookingsConfirmed, weeklyActiveCrews, eventCounts] = await Promise.all([
      // Excludes the Plot system account (getPlotSystemUserId) — a real User row so it can
      // author messages, but not a real end-user; counting it here would mislead whoever's
      // actually reading this dashboard about how many people are using the product.
      prisma.user.count({ where: { status: 'ACTIVE', email: { not: PLOT_SYSTEM_EMAIL } } }),
      prisma.crew.count({ where: { archivedAt: null } }),
      prisma.plan.groupBy({ by: ['status'], _count: true }),
      prisma.booking.count({ where: { status: 'CONFIRMED' } }),
      prisma.intentSignal.findMany({
        where: { occurredAt: { gte: since7d }, crewId: { not: null } },
        distinct: ['crewId'],
        select: { crewId: true },
      }),
      prisma.intentSignal.groupBy({ by: ['name'], _count: true, where: { occurredAt: { gte: since7d } } }),
    ]);

    return reply.send({
      users: userCount,
      crews: crewCount,
      weeklyActiveCrews: weeklyActiveCrews.length,
      plansByStatus: Object.fromEntries(planCounts.map((p) => [p.status, p._count])),
      bookingsConfirmed,
      eventCounts7d: Object.fromEntries(eventCounts.map((e) => [e.name, e._count])),
    });
  });

  /**
   * The pilot scorecard — ONE operator report answering the specific questions the pilot brief
   * asked for by name (users/active crews, first-value rate + time, generated-vs-delivered,
   * insufficient-inventory rate, IN/MAYBE/PASS rates, top pass reasons, lock rate, rec-to-plan
   * rate, category/provider performance, dead crews and why), computed from real
   * IntentSignal/CrewRecommendation/PlanVote/RecommendationResponse rows — never a fabricated or
   * assumed success number. "Useful > beautiful" per the brief: same JSON-over-HTTP, paste-a-URL-
   * into-a-browser convention as `/dashboard` and `/pilot-certification`, not a dedicated web page
   * — nothing here needs one yet. `?days=` bounds every rate to a real, recent window so an old
   * cohort's numbers can't quietly drown out this week's; defaults to 30.
   *
   * Depends on the two events Cycle 16 added (`CrewRecommendationEvaluated`,
   * `CrewPreferencesSet`) — a Crew whose only activity predates that ship has real gaps in its own
   * history here (no evaluated-outcome trail, no first-value timestamp), same honest limitation
   * any event-sourced report has for data from before the event existed. Never backfilled or
   * guessed at.
   */
  app.get('/pilot-scorecard', async (request, reply) => {
    const Schema = z.object({ days: z.coerce.number().int().positive().max(365).default(30) });
    const parsed = Schema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { days } = parsed.data;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [userCount, crews, settingsRows, evaluatedEvents, preferencesSetEvents, recsInWindow, votesInWindow, passResponses] = await Promise.all([
      prisma.user.count({ where: { status: 'ACTIVE', email: { not: PLOT_SYSTEM_EMAIL } } }),
      prisma.crew.findMany({ where: { archivedAt: null }, select: { id: true, name: true, createdAt: true } }),
      prisma.crewRecommendationSettings.findMany({ select: { crewId: true, enabled: true, preferencesSetAt: true, preferencesSource: true } }),
      prisma.intentSignal.findMany({
        where: { name: 'CrewRecommendationEvaluated', occurredAt: { gte: since } },
        select: { crewId: true, occurredAt: true, payload: true },
        orderBy: { occurredAt: 'asc' },
      }),
      prisma.intentSignal.findMany({
        where: { name: 'CrewPreferencesSet', occurredAt: { gte: since } },
        select: { crewId: true, payload: true },
      }),
      prisma.crewRecommendation.findMany({
        where: { createdAt: { gte: since } },
        select: {
          id: true,
          crewId: true,
          planId: true,
          experience: { select: { category: true, listings: { select: { providerId: true } } } },
          plan: { select: { status: true } },
        },
      }),
      prisma.planVote.findMany({
        where: { createdAt: { gte: since }, plan: { recommendation: { isNot: null } } },
        select: { vote: true },
      }),
      prisma.recommendationResponse.findMany({
        where: {
          createdAt: { gte: since },
          action: { in: ['NOT_FOR_US', 'TOO_FAR', 'TOO_EXPENSIVE', 'WRONG_VIBE'] },
          reasonCode: { not: null },
        },
        select: { reasonCode: true },
      }),
    ]);

    // --- Users / active crews ---
    const crewIdToName = new Map(crews.map((c) => [c.id, c.name]));

    // --- First value: how many Crews ever reached preferencesSetAt, by which path, and how long
    // it took from Crew creation. Scoped to Crews CREATED within the window — a Crew created long
    // ago that only just got around to setting taste this week would otherwise report a
    // misleadingly huge "time to first value".
    const crewsCreatedInWindow = crews.filter((c) => c.createdAt >= since);
    const settingsByCrewId = new Map(settingsRows.map((s) => [s.crewId, s]));
    const firstValueMinutes: number[] = [];
    let firstValueExplicit = 0;
    let firstValueDerived = 0;
    for (const crew of crewsCreatedInWindow) {
      const settings = settingsByCrewId.get(crew.id);
      if (!settings?.preferencesSetAt) continue;
      firstValueMinutes.push((settings.preferencesSetAt.getTime() - crew.createdAt.getTime()) / 60_000);
      if (settings.preferencesSource === 'EXPLICIT') firstValueExplicit++;
      else if (settings.preferencesSource === 'DERIVED') firstValueDerived++;
    }
    firstValueMinutes.sort((a, b) => a - b);
    const medianMinutesToFirstValue = firstValueMinutes.length > 0 ? firstValueMinutes[Math.floor(firstValueMinutes.length / 2)] : null;
    // Cross-checked against the CrewPreferencesSet events themselves (the source Cycle 16 added
    // specifically so this number doesn't have to be reconstructed from settings-table state
    // alone) — the two should roughly agree; reported separately rather than silently reconciled,
    // since a real mismatch (e.g. a Crew whose settings row was hand-edited outside the normal
    // flow) is itself worth an operator noticing.
    const preferencesSetEventCount = preferencesSetEvents.length;

    // --- Recommendation-sweep funnel: every real outcome, from the durable event trail ---
    const outcomeCounts: Record<string, number> = {};
    for (const ev of evaluatedEvents) {
      const outcome = (ev.payload as { outcome?: string }).outcome ?? 'unknown';
      outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
    }
    const totalEvaluated = evaluatedEvents.length;
    const delivered = outcomeCounts.delivered ?? 0;
    const noEligibleCandidate = outcomeCounts.no_eligible_candidate ?? 0;

    // --- IN/MAYBE/PASS on recommendation-sourced Plans (PlanVote.vote: IN/MAYBE/OUT — "PASS" in
    // the brief's own vocabulary is the product's "Not for me" / OUT) ---
    const voteCounts = { IN: 0, MAYBE: 0, OUT: 0 };
    for (const v of votesInWindow) voteCounts[v.vote]++;
    const totalVotes = votesInWindow.length;

    // --- Top pass reasons: the structured "what wasn't right" already captured on the message-
    // level recommendation response (services/recommendationLearning.ts), not the separate Plan
    // vote (which carries no reason field at all) ---
    const passReasonCounts: Record<string, number> = {};
    for (const r of passResponses) {
      const code = r.reasonCode as string; // filtered to { not: null } above
      passReasonCounts[code] = (passReasonCounts[code] ?? 0) + 1;
    }
    const topPassReasons = Object.entries(passReasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reasonCode, count]) => ({ reasonCode, count }));

    // --- Lock rate + rec-to-plan rate + category/provider performance, all from the same
    // delivered-recommendation set so every rate in this section is computed over an identical
    // denominator ---
    const recsWithPlan = recsInWindow.filter((r) => r.planId !== null);
    const recsLocked = recsWithPlan.filter((r) => r.plan && ['LOCKED', 'BOOKED', 'COMPLETED'].includes(r.plan.status));

    const categoryStats = new Map<string, { delivered: number; locked: number }>();
    const providerStats = new Map<string, { delivered: number; locked: number }>();
    for (const rec of recsInWindow) {
      const category = rec.experience.category;
      const isLocked = rec.plan !== null && ['LOCKED', 'BOOKED', 'COMPLETED'].includes(rec.plan.status);
      const cat = categoryStats.get(category) ?? { delivered: 0, locked: 0 };
      cat.delivered++;
      if (isLocked) cat.locked++;
      categoryStats.set(category, cat);

      // A recommended Experience can carry listings from more than one provider (real entity-
      // resolution dedup — see entityResolution.ts) — counted once per provider that contributed
      // to it, the same "which providers are actually earning their place" question the mission
      // brief's provider-performance ask is really getting at, not a claim any one provider alone
      // sourced it.
      const providerIds = new Set(rec.experience.listings.map((l) => l.providerId));
      if (providerIds.size === 0) providerIds.add('manual_or_unknown');
      for (const providerId of providerIds) {
        const prov = providerStats.get(providerId) ?? { delivered: 0, locked: 0 };
        prov.delivered++;
        if (isLocked) prov.locked++;
        providerStats.set(providerId, prov);
      }
    }
    const toPerformanceRows = (stats: Map<string, { delivered: number; locked: number }>) =>
      [...stats.entries()]
        .map(([key, s]) => ({ key, delivered: s.delivered, locked: s.locked, lockRate: s.delivered > 0 ? Math.round((s.locked / s.delivered) * 1000) / 1000 : null }))
        .sort((a, b) => b.delivered - a.delivered);

    // --- Dead crews: recommendations enabled, taste set, evaluated at least once in the window,
    // but never once delivered in the window — a real "this Crew is stuck" signal, with its own
    // most frequent blocking reason, not just a bare count ---
    const evaluatedByCrewId = new Map<string, string[]>();
    for (const ev of evaluatedEvents) {
      if (!ev.crewId) continue;
      const outcome = (ev.payload as { outcome?: string }).outcome ?? 'unknown';
      const list = evaluatedByCrewId.get(ev.crewId) ?? [];
      list.push(outcome);
      evaluatedByCrewId.set(ev.crewId, list);
    }
    const deadCrews: { crewId: string; name: string; evaluations: number; mostCommonOutcome: string }[] = [];
    for (const [crewId, outcomes] of evaluatedByCrewId) {
      const settings = settingsByCrewId.get(crewId);
      if (!settings?.enabled || !settings.preferencesSetAt) continue;
      if (outcomes.includes('delivered')) continue;
      const counts: Record<string, number> = {};
      for (const o of outcomes) counts[o] = (counts[o] ?? 0) + 1;
      const mostCommonOutcome = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      deadCrews.push({ crewId, name: crewIdToName.get(crewId) ?? '(unknown)', evaluations: outcomes.length, mostCommonOutcome });
    }
    deadCrews.sort((a, b) => b.evaluations - a.evaluations);

    return reply.send({
      windowDays: days,
      generatedAt: new Date().toISOString(),
      users: { total: userCount },
      crews: { total: crews.length },
      firstValue: {
        crewsCreatedInWindow: crewsCreatedInWindow.length,
        crewsReachingFirstValue: firstValueMinutes.length,
        rate: crewsCreatedInWindow.length > 0 ? Math.round((firstValueMinutes.length / crewsCreatedInWindow.length) * 1000) / 1000 : null,
        medianMinutesToFirstValue,
        bySource: { EXPLICIT: firstValueExplicit, DERIVED: firstValueDerived },
        preferencesSetEventCount,
      },
      recommendationFunnel: {
        totalEvaluated,
        byOutcome: outcomeCounts,
        deliveredRate: totalEvaluated > 0 ? Math.round((delivered / totalEvaluated) * 1000) / 1000 : null,
        insufficientInventoryRate: totalEvaluated > 0 ? Math.round((noEligibleCandidate / totalEvaluated) * 1000) / 1000 : null,
      },
      responseRates: {
        totalVotes,
        in: voteCounts.IN,
        maybe: voteCounts.MAYBE,
        pass: voteCounts.OUT,
        inRate: totalVotes > 0 ? Math.round((voteCounts.IN / totalVotes) * 1000) / 1000 : null,
        maybeRate: totalVotes > 0 ? Math.round((voteCounts.MAYBE / totalVotes) * 1000) / 1000 : null,
        passRate: totalVotes > 0 ? Math.round((voteCounts.OUT / totalVotes) * 1000) / 1000 : null,
      },
      topPassReasons,
      recToPlanRate: recsInWindow.length > 0 ? Math.round((recsWithPlan.length / recsInWindow.length) * 1000) / 1000 : null,
      lockRate: {
        recommendationPlans: recsWithPlan.length,
        locked: recsLocked.length,
        rate: recsWithPlan.length > 0 ? Math.round((recsLocked.length / recsWithPlan.length) * 1000) / 1000 : null,
      },
      categoryPerformance: toPerformanceRows(categoryStats).map((r) => ({ category: r.key, delivered: r.delivered, locked: r.locked, lockRate: r.lockRate })),
      providerPerformance: toPerformanceRows(providerStats).map((r) => ({ providerId: r.key, delivered: r.delivered, locked: r.locked, lockRate: r.lockRate })),
      deadCrews,
    });
  });

  app.get('/feedback', async (_request, reply) => {
    const feedback = await prisma.feedbackSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return reply.send({ feedback });
  });

  /**
   * The automatic Crew recommendation system's delivery job, triggerable on demand. THIS is the
   * endpoint an external scheduler (Render Cron Jobs, a GitHub Actions scheduled workflow,
   * cron-job.org, ...) should be pointed at for real production operation — see server.ts's own
   * comment for why an in-process timer alone isn't sufficient on hobby-tier hosting, and
   * docs/DEPLOYMENT.md for exactly how to wire one up. Same admin-key gate as every other route
   * in this file, so it's safe to expose to an external pinger.
   *
   * Default behaviour goes through the exact same database-backed "is a sweep actually due"
   * check server.ts's own poll uses (`runSweepIfDue`) — calling this every 10 minutes from an
   * external cron (this repo's own `.github/workflows/wake-scheduler.yml` — 10 minutes
   * specifically to stay under Render's 15-minute idle-sleep timeout, see that file's own
   * comment) does NOT mean a sweep actually runs every 10 minutes; it means "check every 10
   * minutes, actually run whenever the real 6-hour cadence says it's due". `force: true` bypasses
   * that check for real one-off ops/pilot-testing use ("run generation for these Crews right now
   * and show me the outputs") — a deliberate human override, not the normal path a scheduler
   * should take. See docs/DECISIONS.md#crew-auto-recommendations.
   */
  app.post('/recommendations/sweep', async (request, reply) => {
    const BodySchema = z.object({ crewId: z.string().optional(), force: z.boolean().optional(), guaranteeFirst: z.boolean().optional() });
    const parsed = BodySchema.safeParse(request.body ?? {});
    const crewId = parsed.success ? parsed.data.crewId : undefined;
    const force = parsed.success ? Boolean(parsed.data.force) : false;
    // Manual remediation for a Crew whose real "first event" moment (the 1->2-member join
    // trigger in routes/crews.ts, fired with a bare `.catch()`) silently failed or timed out —
    // e.g. during the live window `ensureInventory` could take 90+ seconds per city before
    // today's provider-latency fixes. That trigger is one-shot: a Crew it failed for never gets
    // retried by the periodic sweep, which deliberately never uses this relaxation (see
    // evaluateCrewEligibility's own comment). This lets an operator manually re-run it with the
    // exact same guarantee, for one named Crew, without waiting for new code to ship.
    const guaranteeFirst = parsed.success ? Boolean(parsed.data.guaranteeFirst) : false;

    if (crewId) {
      const recommendation = await generateRecommendationForCrew(crewId, { guaranteeFirst });
      return reply.send({ crewsEvaluated: 1, delivered: recommendation ? 1 : 0, errors: 0, recommendation });
    }
    if (force) {
      const result = await runRecommendationSweep();
      return reply.send({ ...result, ran: true, forced: true });
    }
    const outcome = await runSweepIfDue(RECOMMENDATION_SWEEP_DUE_INTERVAL_MS);
    return reply.send({ ran: outcome.ran, forced: false, ...(outcome.result ?? { crewsEvaluated: 0, delivered: 0, errors: 0 }) });
  });

  /**
   * The email message-digest sweep's manual trigger — same shape as /recommendations/sweep
   * above (`force: true` bypasses the due-check for real testing/ops use, the default path goes
   * through the same database-backed "is this actually due" check the in-process poll in
   * server.ts uses). See services/messageNotifications.ts for what actually runs.
   */
  app.post('/message-notifications/sweep', async (request, reply) => {
    const BodySchema = z.object({ force: z.boolean().optional() });
    const parsed = BodySchema.safeParse(request.body ?? {});
    const force = parsed.success ? Boolean(parsed.data.force) : false;

    if (force) {
      const result = await runMessageNotificationSweep();
      return reply.send({ ...result, ran: true, forced: true });
    }
    const outcome = await runMessageNotificationSweepIfDue(MESSAGE_NOTIFICATION_SWEEP_DUE_INTERVAL_MS);
    return reply.send({ ran: outcome.ran, forced: false, ...(outcome.result ?? { crewsScanned: 0, membersConsidered: 0, emailsSent: 0, errors: 0 }) });
  });

  /**
   * The single-Crew diagnostic — real gap this closes: every doc comment and code comment
   * pointing at "GET /admin/crews/:id/explain-recommendation" (services/match.ts,
   * services/crewRecommendations.ts, services/opportunityIntent.ts, docs/DECISIONS.md) described
   * a route that was never actually registered — `explainCrewRecommendation` only ever ran
   * embedded inside `/users/lookup` below, one Crew at a time, keyed by a member's email. Useful
   * when you already have a Crew open (its id is right there in the URL) and don't want to look
   * up a member's email first. Paste this URL (with ?key=) into a browser — read-only, sends
   * nothing, same eligibility check `generateRecommendationForCrew` would run right now.
   */
  app.get('/crews/:id/explain-recommendation', async (request, reply) => {
    const { id } = request.params as { id: string };
    const crew = await prisma.crew.findUnique({ where: { id }, select: { id: true, name: true, defaultCity: true } });
    if (!crew) return reply.code(404).send({ error: 'not_found', message: 'No Crew with that id.' });
    const explain = await explainCrewRecommendation(id);
    return reply.send({ crewName: crew.name, defaultCity: crew.defaultCity, ...explain });
  });

  /**
   * Real gap found verifying this in production for the first time: `lastResult.delivered` on
   * `/health/scheduler` proves a sweep delivered *something*, but not WHICH Crew — so "it says
   * delivered:1 but I can't find a message from Plot anywhere" was previously undebuggable
   * without direct database access. Lists exactly what was delivered, to which named Crew, and
   * who's in it, newest first — paste this URL (with ?key=) into a browser.
   */
  app.get('/recommendations/recent', async (request, reply) => {
    const QuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
    const parsed = QuerySchema.safeParse(request.query ?? {});
    const limit = parsed.success ? parsed.data.limit : 20;

    const recommendations = await prisma.crewRecommendation.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        crew: { select: { id: true, name: true, members: { select: { user: { select: { email: true } } } } } },
        experience: { select: { name: true, category: true } },
      },
    });

    return reply.send({
      recommendations: recommendations.map((r) => ({
        crewId: r.crewId,
        crewName: r.crew.name,
        crewMembers: r.crew.members.map((m) => m.user.email),
        experienceName: r.experience?.name ?? null,
        category: r.experience?.category ?? null,
        score: r.score,
        status: r.status,
        createdAt: r.createdAt,
      })),
    });
  });

  /**
   * "It says delivered:1 but I can't find a message from Plot" is undebuggable from the outside
   * without knowing which of a person's OWN Crews (if any) were even evaluated, and why one
   * wasn't. Paste this URL (with ?key=) to see every Crew a given email is a member of, each
   * one's recommendation settings, its most recent delivery (if any), and — critically — WHY
   * the next one hasn't landed yet, using the exact same eligibility checks
   * `generateRecommendationForCrew` runs, without actually sending anything.
   */
  app.get('/users/lookup', async (request, reply) => {
    const QuerySchema = z.object({ email: z.string().email() });
    const parsed = QuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Pass ?email=...' });

    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email.toLowerCase().trim() },
      select: { id: true, email: true, createdAt: true },
    });
    if (!user) return reply.code(404).send({ error: 'not_found', message: 'No user with that email.' });

    const memberships = await prisma.crewMember.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      select: { crew: { select: { id: true, name: true, defaultCity: true, _count: { select: { members: true } } } } },
    });

    const crews = await Promise.all(
      memberships.map(async ({ crew }) => {
        const [settings, memberCount, mostRecent, explain] = await Promise.all([
          getOrCreateSettings(crew.id),
          prisma.crewMember.count({ where: { crewId: crew.id, status: 'ACTIVE' } }),
          prisma.crewRecommendation.findFirst({
            where: { crewId: crew.id },
            orderBy: { createdAt: 'desc' },
            include: { experience: { select: { name: true, category: true } } },
          }),
          // The actual answer to "why hasn't this Crew gotten one yet" — runs the exact same
          // eligibility logic generateRecommendationForCrew would, right now, without sending
          // anything. See explainCrewRecommendation's own doc comment.
          explainCrewRecommendation(crew.id),
        ]);
        return {
          crewId: crew.id,
          crewName: crew.name,
          defaultCity: crew.defaultCity,
          memberCount,
          recommendationsEnabled: settings.enabled,
          mostRecentRecommendation: mostRecent
            ? {
                experienceName: mostRecent.experience?.name ?? null,
                category: mostRecent.experience?.category ?? null,
                score: mostRecent.score,
                createdAt: mostRecent.createdAt,
              }
            : null,
          rightNow: explain,
        };
      }),
    );

    return reply.send({ userId: user.id, email: user.email, joinedAt: user.createdAt, crews });
  });

  /**
   * A real, explicit, one-off operator request ("moving forwards, remove ALL accounts apart
   * from these two real ones, and remove all existing Crews — they were all test/fake") — not
   * something this route should make easy to trigger by accident. Two independent guards: the
   * keep-list is hardcoded, not a request parameter (so a wrong param can't widen or narrow who
   * survives), and the actual deletion only runs with `?confirm=DELETE_ALL_TEST_DATA` exactly —
   * every other call (including the bare `?key=...` alone) is a dry run that reports exactly
   * what WOULD be deleted and changes nothing. Crews are deleted first (cascades to
   * CrewMember/CrewMessage/Plan/CrewRecommendation/etc. — see schema.prisma's onDelete: Cascade
   * on every one of those), then every User not on the keep-list (cascades to their
   * Profile/TasteProfile/etc.) — the Plot system account is deliberately never touched, it
   * self-heals via getPlotSystemUserId() regardless.
   */
  const KEEP_EMAILS = ['willproud89@gmail.com', 'itswillproud@gmail.com'];
  const CONFIRM_PHRASE = 'DELETE_ALL_TEST_DATA';
  app.get('/reset-to-real-accounts', async (request, reply) => {
    const QuerySchema = z.object({ confirm: z.string().optional() });
    const parsed = QuerySchema.safeParse(request.query ?? {});
    const confirm = parsed.success ? parsed.data.confirm : undefined;

    const [usersToDelete, crewsToDelete] = await Promise.all([
      prisma.user.findMany({ where: { email: { notIn: [...KEEP_EMAILS, PLOT_SYSTEM_EMAIL] } }, select: { email: true } }),
      prisma.crew.findMany({ select: { name: true } }),
    ]);

    if (confirm !== CONFIRM_PHRASE) {
      return reply.send({
        dryRun: true,
        wouldKeep: KEEP_EMAILS,
        wouldDeleteUserCount: usersToDelete.length,
        wouldDeleteUserEmails: usersToDelete.map((u) => u.email),
        wouldDeleteCrewCount: crewsToDelete.length,
        wouldDeleteCrewNames: crewsToDelete.map((c) => c.name),
        message: `Nothing was deleted. Add &confirm=${CONFIRM_PHRASE} to this exact URL to actually run this.`,
      });
    }

    const deletedCrews = await prisma.crew.deleteMany({});
    const deletedUsers = await prisma.user.deleteMany({ where: { email: { notIn: [...KEEP_EMAILS, PLOT_SYSTEM_EMAIL] } } });

    return reply.send({
      dryRun: false,
      kept: KEEP_EMAILS,
      deletedCrewCount: deletedCrews.count,
      deletedUserCount: deletedUsers.count,
    });
  });
}
