import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { config } from '../lib/config';
import { syncAllProviders } from '../services/inventorySync';
import { buildCanonicalKey } from '../services/entityResolution';
import { computeQualityScore } from '../services/qualityScoring';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';
import { runRecommendationSweep, runSweepIfDue, generateRecommendationForCrew, getOrCreateSettings, explainCrewRecommendation, RECOMMENDATION_SWEEP_DUE_INTERVAL_MS } from '../services/crewRecommendations';

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
      subcategories: [],
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
      imageUrl: null,
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
      prisma.user.count({ where: { status: 'ACTIVE' } }),
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
   * check server.ts's own poll uses (`runSweepIfDue`) — calling this every 30 minutes from an
   * external cron does NOT mean a sweep actually runs every 30 minutes; it means "check every 30
   * minutes, actually run whenever the real 6-hour cadence says it's due". `force: true` bypasses
   * that check for real one-off ops/pilot-testing use ("run generation for these Crews right now
   * and show me the outputs") — a deliberate human override, not the normal path a scheduler
   * should take. See docs/DECISIONS.md#crew-auto-recommendations.
   */
  app.post('/recommendations/sweep', async (request, reply) => {
    const BodySchema = z.object({ crewId: z.string().optional(), force: z.boolean().optional() });
    const parsed = BodySchema.safeParse(request.body ?? {});
    const crewId = parsed.success ? parsed.data.crewId : undefined;
    const force = parsed.success ? Boolean(parsed.data.force) : false;

    if (crewId) {
      const recommendation = await generateRecommendationForCrew(crewId);
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
}
