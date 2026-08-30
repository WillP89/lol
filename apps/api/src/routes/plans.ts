import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../middleware/auth';
import { isCrewMember, listUpcomingPlansForUser } from '../services/crew';
import {
  createPlanFromRecommendationOption,
  sendExperienceToCrew,
  createSoftPlan,
  submitVote,
  getPlanBySlug,
  getPlanById,
  computePlanPulse,
  markCompleted,
  cancelPlan,
} from '../services/plan';
import { track } from '../services/analytics';

export async function planRoutes(app: FastifyInstance): Promise<void> {
  app.post('/crews/:crewId/plans/from-option', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { crewId } = request.params as { crewId: string };
    const Schema = z.object({ optionId: z.string() });
    const parsed = Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!(await isCrewMember(crewId, request.user.id))) return reply.code(403).send({ error: 'forbidden' });

    const plan = await createPlanFromRecommendationOption(crewId, parsed.data.optionId, request.user.id);
    return reply.code(201).send({ plan });
  });

  app.post('/crews/:crewId/plans/send', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { crewId } = request.params as { crewId: string };
    const Schema = z.object({ experienceId: z.string() });
    const parsed = Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!(await isCrewMember(crewId, request.user.id))) return reply.code(403).send({ error: 'forbidden' });

    const plan = await sendExperienceToCrew(crewId, parsed.data.experienceId, request.user.id);
    return reply.code(201).send({ plan });
  });

  app.post('/crews/:crewId/plans/soft', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { crewId } = request.params as { crewId: string };
    const Schema = z.object({ title: z.string().min(1).max(120) });
    const parsed = Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!(await isCrewMember(crewId, request.user.id))) return reply.code(403).send({ error: 'forbidden' });

    const plan = await createSoftPlan(crewId, request.user.id, parsed.data.title);
    return reply.code(201).send({ plan });
  });

  // Public — the Plan Card page (brief §16). No auth required to view.
  app.get('/plans/public/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const plan = await getPlanBySlug(slug);
    if (!plan) return reply.code(404).send({ error: 'not_found' });

    await track('PlanCardViewed', { planId: plan.id, viewerUserId: request.user?.id, authenticated: Boolean(request.user) }, {
      userId: request.user?.id,
      planId: plan.id,
      crewId: plan.crewId,
    });

    const pulse = await computePlanPulse(plan.id);
    return reply.send({ plan, pulse });
  });

  // Public — vote without an account (email-only). See services/plan.ts#submitVote.
  const VoteSchema = z.object({ vote: z.enum(['in', 'maybe', 'out']), email: z.string().email().optional() });
  app.post('/plans/public/:slug/vote', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = VoteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const plan = await getPlanBySlug(slug);
    if (!plan) return reply.code(404).send({ error: 'not_found' });

    if (!request.user && !parsed.data.email) {
      return reply.code(400).send({ error: 'identity_required', message: 'Sign in or provide an email to vote.' });
    }

    const result = await submitVote(
      plan.id,
      parsed.data.vote,
      { userId: request.user?.id, email: parsed.data.email },
      request.ip,
    );
    return reply.send(result);
  });

  // "Plans" nav destination — every confirmed Plan across every Crew you're in, not just the
  // one you happen to have open. See services/crew.ts#listUpcomingPlansForUser.
  app.get('/plans/upcoming', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const plans = await listUpcomingPlansForUser(request.user.id);
    return reply.send({ plans });
  });

  app.get('/plans/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    const plan = await getPlanById(id);
    if (!plan) return reply.code(404).send({ error: 'not_found' });
    if (!(await isCrewMember(plan.crewId, request.user.id))) return reply.code(403).send({ error: 'forbidden' });
    const pulse = await computePlanPulse(id);
    return reply.send({ plan, pulse });
  });

  app.post('/plans/:id/complete', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    await markCompleted(id);
    return reply.send({ ok: true });
  });

  app.post('/plans/:id/cancel', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    await cancelPlan(id);
    return reply.send({ ok: true });
  });
}
