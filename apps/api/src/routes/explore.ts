import type { FastifyInstance } from 'fastify';
import { requireUser } from '../middleware/auth';
import { listExploreExperiences } from '../services/explore';
import { hasLiveProvider } from '../providers/registry';

export async function exploreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/explore/experiences', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { city } = request.query as { city?: string };

    const experiences = await listExploreExperiences(city?.trim() || 'London');
    // Lets the client show "sample events" honestly instead of presenting mock data as real
    // listings — see docs/DECISIONS.md#real-events.
    return reply.send({ experiences, dataSource: hasLiveProvider ? 'live' : 'mock' });
  });
}
