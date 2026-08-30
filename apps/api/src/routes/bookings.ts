import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../middleware/auth';
import { startDeepLinkBooking, confirmDeepLinkBooking, failBooking } from '../services/booking';
import { prisma } from '../lib/prisma';

export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/plans/:id/bookings', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    const Schema = z.object({ participantUserIds: z.array(z.string()).min(1) });
    const parsed = Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    try {
      const result = await startDeepLinkBooking(id, request.user.id, parsed.data.participantUserIds);
      return reply.code(201).send(result);
    } catch (err) {
      return reply.code(400).send({ error: 'booking_failed', message: (err as Error).message });
    }
  });

  app.post('/bookings/:id/confirm', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    await confirmDeepLinkBooking(id, request.user.id);
    const booking = await prisma.booking.findUnique({ where: { id }, include: { plan: { include: { experience: true } } } });
    return reply.send({ booking });
  });

  app.post('/bookings/:id/fail', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    const Schema = z.object({ reason: z.string().min(1) });
    const parsed = Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    await failBooking(id, parsed.data.reason);
    return reply.send({ ok: true });
  });
}
