import type { FastifyInstance } from 'fastify';
import { requireUser } from '../middleware/auth';
import { listExploreExperiences } from '../services/explore';
import { hasLiveTicketedProvider } from '../providers/registry';
import { prisma } from '../lib/prisma';
import { UK_FALLBACK_CENTER, UK_PLACES } from '../data/ukPlaces';

export async function exploreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/explore/experiences', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { city } = request.query as { city?: string };

    // No city in the query — Explore's own default, not a hardcoded London — falls back to
    // this viewer's own home city (set in onboarding) before a genuinely UK-central point.
    // See docs/DECISIONS.md#uk-wide-location.
    let resolvedCity = city?.trim();
    if (!resolvedCity) {
      const profile = await prisma.profile.findUnique({ where: { userId: request.user.id }, select: { homeCity: true } });
      resolvedCity = profile?.homeCity ?? UK_FALLBACK_CENTER.name;
    }

    const experiences = await listExploreExperiences(resolvedCity, request.user.id);
    // The map needs *somewhere* to centre on even with zero results for this city — its own
    // coordinates from the gazetteer, not a hardcoded London point. See
    // docs/DECISIONS.md#uk-wide-location.
    const cityPlace = UK_PLACES.find((p) => p.name.toLowerCase() === resolvedCity!.toLowerCase()) ?? UK_FALLBACK_CENTER;
    // Lets the client show "sample events" honestly instead of presenting mock data as real
    // listings — see docs/DECISIONS.md#real-events.
    return reply.send({
      experiences,
      dataSource: hasLiveTicketedProvider ? 'live' : 'mock',
      city: resolvedCity,
      cityLat: cityPlace.lat,
      cityLng: cityPlace.lng,
    });
  });
}
