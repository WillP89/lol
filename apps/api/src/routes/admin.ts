import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { config } from '../lib/config';
import { syncAllProviders, backfillImageQuality, backfillMissingImages } from '../services/inventorySync';
import { buildCanonicalKey } from '../services/entityResolution';
import { computeQualityScore } from '../services/qualityScoring';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { runRecommendationSweep, runSweepIfDue, generateRecommendationForCrew, getOrCreateSettings, explainCrewRecommendation, PLOT_SYSTEM_EMAIL, RECOMMENDATION_SWEEP_DUE_INTERVAL_MS } from '../services/crewRecommendations';
import { runMessageNotificationSweep, runMessageNotificationSweepIfDue, MESSAGE_NOTIFICATION_SWEEP_DUE_INTERVAL_MS } from '../services/messageNotifications';

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
    if (key !== config.ADMIN_API_KEY) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/providers', async (_request, reply) => {
    const providers = await prisma.provider.findMany({ include: { _count: { select: { listings: true } } } });
    return reply.send({ providers });
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
