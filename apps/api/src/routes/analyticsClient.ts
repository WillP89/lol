import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { track } from '../services/analytics';
import { requireUser } from '../middleware/auth';

/**
 * A narrow, explicitly-allow-listed bridge for the handful of funnel moments that only happen
 * client-side (tapping a real external booking link, tapping "Add to calendar") and so have no
 * natural server-side call site to `track()` from. Deliberately not a generic "log anything the
 * client says" endpoint — the schema only accepts these two named shapes.
 */
const ClientEventSchema = z.union([
  z.object({ name: z.literal('BookingStarted'), planId: z.string(), model: z.enum(['deep_link', 'affiliate', 'api', 'native']) }),
  z.object({ name: z.literal('CalendarAdded'), planId: z.string() }),
]);

export async function analyticsClientRoutes(app: FastifyInstance): Promise<void> {
  app.post('/analytics/client-event', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = ClientEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    if (parsed.data.name === 'BookingStarted') {
      await track('BookingStarted', { planId: parsed.data.planId, userId: request.user.id, model: parsed.data.model }, { userId: request.user.id, planId: parsed.data.planId });
    } else {
      await track('CalendarAdded', { planId: parsed.data.planId, userId: request.user.id }, { userId: request.user.id, planId: parsed.data.planId });
    }
    return reply.code(204).send();
  });
}
