import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { track } from '../services/analytics';

const FeedbackSchema = z.object({
  context: z.string().min(1),
  category: z.enum([
    'wrong_info',
    'recommendation_feedback',
    'booking_issue',
    'event_cancelled',
    'price_incorrect',
    'venue_incorrect',
    'not_my_vibe',
    'too_far',
    'too_expensive',
    'already_knew',
    'great_recommendation',
  ]),
  note: z.string().optional(),
});

const CATEGORY_MAP: Record<string, string> = {
  wrong_info: 'WRONG_INFO',
  recommendation_feedback: 'RECOMMENDATION_FEEDBACK',
  booking_issue: 'BOOKING_ISSUE',
  event_cancelled: 'EVENT_CANCELLED',
  price_incorrect: 'PRICE_INCORRECT',
  venue_incorrect: 'VENUE_INCORRECT',
  not_my_vibe: 'NOT_MY_VIBE',
  too_far: 'TOO_FAR',
  too_expensive: 'TOO_EXPENSIVE',
  already_knew: 'ALREADY_KNEW',
  great_recommendation: 'GREAT_RECOMMENDATION',
};

/**
 * Lightweight, always-available feedback (brief §41 "pilot feedback system"). Works whether or
 * not the user is signed in — a "wrong price" report on a public Plan Card matters even from
 * an anonymous visitor.
 */
export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/feedback', async (request, reply) => {
    const parsed = FeedbackSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const signal = await prisma.feedbackSignal.create({
      data: {
        userId: request.user?.id,
        context: parsed.data.context,
        category: CATEGORY_MAP[parsed.data.category] as never,
        note: parsed.data.note,
      },
    });

    await track('FeedbackSubmitted', { context: parsed.data.context, category: parsed.data.category, userId: request.user?.id }, {
      userId: request.user?.id,
    });

    return reply.code(201).send({ signal });
  });
}
