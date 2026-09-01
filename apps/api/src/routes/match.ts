import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../middleware/auth';
import { isCrewMember } from '../services/crew';
import { findUsSomething, suggestToCrewChat } from '../services/match';
import { getCrewAvailabilityByDay } from '../services/availability';
import { track } from '../services/analytics';
import { hasLiveTicketedProvider } from '../providers/registry';

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.post('/crews/:crewId/find-us-something', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { crewId } = request.params as { crewId: string };

    if (!(await isCrewMember(crewId, request.user.id))) {
      return reply.code(403).send({ error: 'forbidden', message: 'Not a member of this Crew.' });
    }

    await track('FindUsSomethingOpened', { crewId, userId: request.user.id }, { userId: request.user.id, crewId });

    const result = await findUsSomething(crewId, request.user.id);
    // See docs/DECISIONS.md#real-events — the client shows a "sample events" banner rather
    // than presenting mock data as real listings.
    return reply.send({ ...result, dataSource: hasLiveTicketedProvider ? 'live' : 'mock' });
  });

  // The core loop: find the best options AND put them straight into the Crew's conversation
  // in one tap — see services/match.ts#suggestToCrewChat. No separate results screen to review
  // first; the group sees and reacts to suggestions together, in chat.
  app.post('/crews/:crewId/suggest-to-chat', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { crewId } = request.params as { crewId: string };
    if (!(await isCrewMember(crewId, request.user.id))) {
      return reply.code(403).send({ error: 'forbidden', message: 'Not a member of this Crew.' });
    }

    await track('FindUsSomethingOpened', { crewId, userId: request.user.id }, { userId: request.user.id, crewId });

    const plans = await suggestToCrewChat(crewId, request.user.id);
    return reply.send({ plans, dataSource: hasLiveTicketedProvider ? 'live' : 'mock' });
  });

  app.get('/crews/:crewId/availability', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { crewId } = request.params as { crewId: string };
    if (!(await isCrewMember(crewId, request.user.id))) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const QuerySchema = z.object({ days: z.string().optional() });
    const parsed = QuerySchema.safeParse(request.query);
    const daysAhead = parsed.success && parsed.data.days ? parsed.data.days.split(',').map(Number) : [0, 1, 2, 3];

    const availability = await getCrewAvailabilityByDay(crewId, daysAhead);
    return reply.send({ availability });
  });
}
