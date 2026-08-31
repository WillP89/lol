import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { config } from '../lib/config';
import { syncAllProviders } from '../services/inventorySync';
import { buildCanonicalKey } from '../services/entityResolution';
import { computeQualityScore } from '../services/qualityScoring';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';

/**
 * Internal operator tooling (brief §29 admin console, §64 operating dashboard). Gated by a
 * single shared secret (`x-admin-key` header, `ADMIN_API_KEY` env) — a deliberately minimal
 * stopgap, not real role-based admin auth. Upgrading this the moment there's more than one
 * operator (a User.role enum + session-based admin auth, not a shared header secret) is a
 * pre-launch requirement, not a nice-to-have — see docs/DECISIONS.md#admin-auth.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    if (request.headers['x-admin-key'] !== config.ADMIN_API_KEY) {
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

    const experience = await prisma.experience.upsert({
      where: { canonicalKey },
      update: { ...canonicalInput, venueId: venue.id, qualityScore },
      create: { ...canonicalInput, canonicalKey, venueId: venue.id, qualityScore },
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
}
