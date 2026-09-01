import type { FastifyInstance } from 'fastify';
import { searchUkPlaces } from '../data/ukPlaces';
import { looksLikeUkPostcode, resolvePostcode } from '../lib/postcodes';
import { requireUser } from '../middleware/auth';

export interface LocationSearchResult {
  name: string;
  region: string;
  lat: number;
  lng: number;
  /** 'place' = a gazetteer town/city (provider inventory syncs directly against its name).
   * 'postcode' = a real postcode/outward-code resolved via postcodes.io — Explore treats this
   * as a radius-search centre rather than an exact city match, since no venue is tagged with a
   * postcode as its city. See services/explore.ts#listExploreExperiencesByRadius. */
  kind: 'place' | 'postcode';
}

/**
 * UK-wide place search — powers onboarding's "Where are you based?" and Explore's location
 * picker. Two real sources merged into one result list: the static gazetteer (data/ukPlaces.ts)
 * for town/city names, and a real postcode lookup (lib/postcodes.ts, postcodes.io) when the
 * query is shaped like a UK postcode — "Even a postcode" per the directive this was built for.
 * Neither is a live geocoder for arbitrary free-text addresses (this environment's egress proxy
 * blocks one anyway) — see docs/DECISIONS.md#uk-wide-location for the exact upgrade path.
 */
export async function locationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/locations/search', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { q } = request.query as { q?: string };
    const query = q ?? '';

    const placeResults: LocationSearchResult[] = searchUkPlaces(query, 8).map((p) => ({ name: p.name, region: p.region, lat: p.lat, lng: p.lng, kind: 'place' as const }));

    // Only worth a real network call when the query is actually postcode-shaped — not fired on
    // every keystroke of an ordinary "manch..." town-name search.
    if (looksLikeUkPostcode(query)) {
      const postcode = await resolvePostcode(query);
      if (postcode) {
        placeResults.unshift({ name: postcode.label, region: postcode.district || 'Postcode', lat: postcode.lat, lng: postcode.lng, kind: 'postcode' as const });
      }
    }

    return reply.send({ results: placeResults.slice(0, 8) });
  });
}
