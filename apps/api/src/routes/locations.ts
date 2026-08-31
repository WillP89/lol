import type { FastifyInstance } from 'fastify';
import { searchUkPlaces } from '../data/ukPlaces';
import { requireUser } from '../middleware/auth';

/**
 * UK-wide place search — powers onboarding's "Where are you based?" and Explore's city switcher.
 * Backed by a static gazetteer (see data/ukPlaces.ts), not a live geocoder — this environment's
 * egress proxy blocks the geocoding APIs that would normally back this. See
 * docs/DECISIONS.md#uk-wide-location for the exact upgrade path once one is reachable.
 */
export async function locationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/locations/search', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { q } = request.query as { q?: string };
    const results = searchUkPlaces(q ?? '', 8);
    return reply.send({ results });
  });
}
