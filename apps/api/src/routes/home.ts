import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../middleware/auth';
import { buildPersonalHome, applyHomeFeedback, type HomeFeedbackAction } from '../services/personalHome';
import { track } from '../services/analytics';
import { config } from '../lib/config';

const FeedbackSchema = z.object({
  action: z.enum(['save', 'not_for_me', 'pass', 'view']),
});

/**
 * HOME = ME (docs/DECISIONS.md#personal-home) — the individual-facing counterpart to
 * routes/match.ts's Crew-facing "Find us something"/automatic sweep. Everything here reads/
 * writes exactly one person's own TasteProfile; nothing here ever touches a Crew's.
 */
export async function homeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/home/personalized', async (request, reply) => {
    if (!requireUser(request, reply)) return;

    // Part 19's recommendation debugger — real scoring inputs behind every reason/score, never
    // shipped by default. Gated the same way every other ops-adjacent surface in this codebase
    // is (x-admin-key, see routes/admin.ts) OR simply always available outside production, since
    // a local/staging developer inspecting their own Home doesn't need a key to do it.
    const wantsDebug = (request.query as { debug?: string })?.debug === '1';
    const adminKey = request.headers['x-admin-key'];
    const debugAllowed = config.NODE_ENV !== 'production' || adminKey === config.ADMIN_API_KEY;
    const debug = wantsDebug && debugAllowed;

    const home = await buildPersonalHome(request.user.id, { debug });

    await track(
      'HomePersonalizedImpression',
      {
        personalized: home.personalized,
        forYouCount: home.forYou.length,
        thisWeekendCount: home.thisWeekend.length,
        interestRowCount: home.interestRows.length,
        nearYouCount: home.nearYou.length,
        explorationCount: home.exploration.length,
      },
      { userId: request.user.id },
    );

    return reply.send(home);
  });

  app.post('/home/personalized/:experienceId/feedback', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = FeedbackSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });

    const { experienceId } = request.params as { experienceId: string };
    const action: HomeFeedbackAction = parsed.data.action;
    await applyHomeFeedback(request.user.id, experienceId, action);
    await track('HomeItemFeedback', { experienceId, action }, { userId: request.user.id });

    return reply.send({ ok: true });
  });
}
