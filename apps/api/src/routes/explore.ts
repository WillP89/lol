import type { FastifyInstance } from 'fastify';
import { requireUser } from '../middleware/auth';
import { listExploreExperiences, listExploreExperiencesByRadius } from '../services/explore';
import { hasLiveTicketedProvider } from '../providers/registry';
import { prisma } from '../lib/prisma';
import { UK_FALLBACK_CENTER, UK_PLACES } from '../data/ukPlaces';

// Bounds on the radius control (directive: "extend the map radius") — floor keeps a request
// from syncing zero real distance's worth of anything useful, ceiling keeps a single request
// from fanning out across a huge share of the whole gazetteer (data/ukPlaces.ts's
// placesWithinRadiusKm already caps the place COUNT too; this caps the requested distance
// itself, since a very large radius from a densely-covered area could otherwise still resolve
// to many genuinely-within-range places before that count cap kicks in).
const MIN_RADIUS_KM = 1;
const MAX_RADIUS_KM = 120;

export async function exploreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/explore/experiences', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { city, lat, lng, radiusKm } = request.query as { city?: string; lat?: string; lng?: string; radiusKm?: string };

    // Radius mode: an explicit centre point (a postcode search, or "extend the radius" from the
    // current city) — real distance filtering across every real gazetteer place within range,
    // never a re-labelled single-city result. See services/explore.ts#listExploreExperiencesByRadius.
    const parsedLat = lat !== undefined ? Number(lat) : NaN;
    const parsedLng = lng !== undefined ? Number(lng) : NaN;
    if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng)) {
      const requestedRadius = radiusKm !== undefined ? Number(radiusKm) : NaN;
      const resolvedRadius = Number.isFinite(requestedRadius) ? Math.min(Math.max(requestedRadius, MIN_RADIUS_KM), MAX_RADIUS_KM) : 15;

      const { experiences, meta } = await listExploreExperiencesByRadius({ lat: parsedLat, lng: parsedLng }, resolvedRadius, request.user.id);
      return reply.send({
        experiences,
        dataSource: hasLiveTicketedProvider ? 'live' : 'mock',
        city: city ?? null,
        cityLat: parsedLat,
        cityLng: parsedLng,
        radius: meta,
      });
    }

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
      radius: null,
    });
  });
}
