import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../middleware/auth';
import { isCrewMember, listUpcomingPlansForUser } from '../services/crew';
import {
  createPlanFromRecommendationOption,
  sendExperienceToCrew,
  createSoftPlan,
  createManualPlanForCrew,
  submitVote,
  getPlanBySlug,
  getPlanById,
  computePlanPulse,
  markCompleted,
  cancelPlan,
  lockPlan,
} from '../services/plan';
import { track } from '../services/analytics';
import { hasLiveTicketedProvider } from '../providers/registry';
import { prisma } from '../lib/prisma';

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

  app.post('/crews/:crewId/plans/manual', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { crewId } = request.params as { crewId: string };
    const Schema = z.object({
      title: z.string().trim().min(1).max(120),
      venueName: z.string().trim().min(1).max(160).optional(),
      startsAt: z.string().datetime().optional(),
    });
    const parsed = Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    if (!(await isCrewMember(crewId, request.user.id))) return reply.code(403).send({ error: 'forbidden' });

    const plan = await createManualPlanForCrew(crewId, request.user.id, {
      title: parsed.data.title,
      venueName: parsed.data.venueName,
      startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : undefined,
    });
    await track('SentToCrew', { crewId, planId: plan.id, source: 'individual_send' }, { userId: request.user.id, crewId, planId: plan.id });
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
    // Only present when this Plan came from the automatic recommendation engine — the client
    // uses this to render the "✨ Plot" badge + reason ("Because your Crew likes comedy") and
    // the lightweight response controls, distinct from a Plan a member shared themselves. See
    // docs/DECISIONS.md#crew-auto-recommendations.
    const recommendation = await prisma.crewRecommendation.findUnique({
      where: { planId: plan.id },
      select: { id: true, reasonText: true, status: true },
    });
    return reply.send({ plan, pulse, recommendation });
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
    // The booking page needs to know whether this Plan's Experience has a real, live-provider
    // booking URL behind it or just sample data (mockTicketingProvider's deliberate
    // `.invalid` placeholder — see docs/DECISIONS.md#booking-status-split) — without this, the
    // booking flow would silently open a dead tab with zero explanation instead of an honest
    // "sample data" message. `dataSource` on the response, not on Experience itself: whether a
    // provider is live is a deployment-wide fact (is TICKETMASTER_API_KEY set at all), not a
    // per-row property to store and risk going stale.
    return reply.send({ plan, pulse, dataSource: hasLiveTicketedProvider ? 'live' : 'mock' });
  });

  // "Lock it in" — see services/plan.ts#lockPlan's own comment for why this is a direct status
  // transition, not something that only happens as a side effect of booking.
  app.post('/plans/:id/lock', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    const plan = await getPlanById(id);
    if (!plan) return reply.code(404).send({ error: 'not_found' });
    if (!(await isCrewMember(plan.crewId, request.user.id))) return reply.code(403).send({ error: 'forbidden' });

    const locked = await lockPlan(id, request.user.id);
    return reply.send({ plan: locked });
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
