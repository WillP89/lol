import type { FastifyInstance } from 'fastify';
import { requireUser } from '../middleware/auth';
import { listExploreExperiences } from '../services/explore';

export async function exploreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/explore/experiences', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { city } = request.query as { city?: string };

    const experiences = await listExploreExperiences(city?.trim() || 'London');
    return reply.send({ experiences });
  });
}
