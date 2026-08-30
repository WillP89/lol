import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { track } from '../services/analytics';

const RewindSchema = z.object({
  rating: z.enum(['love', 'like', 'meh', 'no']),
  reasons: z.array(z.string()).default([]),
});

const RATING_MAP = { love: 'LOVE', like: 'LIKE', meh: 'MEH', no: 'NO' } as const;

/**
 * Rewind (brief §36 / phase-3 §36): one tap, post-plan — "would your Crew do this again?"
 * Deliberately the cheapest possible feedback surface because it's training data disguised as
 * a question the group already wants to answer. See docs/DECISIONS.md#rewind-not-memory-reel
 * for why this ships instead of a full photo/memory-reel feature.
 */
export async function rewindRoutes(app: FastifyInstance): Promise<void> {
  app.post('/plans/:id/rewind', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id: planId } = request.params as { id: string };
    const parsed = RewindSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    if (plan.status !== 'COMPLETED') {
      return reply.code(400).send({ error: 'invalid_state', message: 'Rewind is only available once a plan is completed.' });
    }

    const signal = await prisma.rewindSignal.upsert({
      where: { planId_userId: { planId, userId: request.user.id } },
      update: { rating: RATING_MAP[parsed.data.rating], reasons: parsed.data.reasons },
      create: { planId, userId: request.user.id, rating: RATING_MAP[parsed.data.rating], reasons: parsed.data.reasons },
    });

    await track(
      'RewindSubmitted',
      { planId, crewId: plan.crewId, userId: request.user.id, rating: parsed.data.rating },
      { userId: request.user.id, planId, crewId: plan.crewId },
    );

    return reply.code(201).send({ signal });
  });
}
