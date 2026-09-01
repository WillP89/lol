import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config, s3Configured } from './lib/config';
import { UPLOAD_DIR } from './lib/mediaStorage';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { attachUser } from './middleware/auth';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { crewRoutes } from './routes/crews';
import { matchRoutes } from './routes/match';
import { planRoutes } from './routes/plans';
import { bookingRoutes } from './routes/bookings';
import { rewindRoutes } from './routes/rewind';
import { adminRoutes } from './routes/admin';
import { feedbackRoutes } from './routes/feedback';
import { exploreRoutes } from './routes/explore';
import { locationRoutes } from './routes/locations';
import { analyticsClientRoutes } from './routes/analyticsClient';
import { SWEEP_JOB_NAME, RECOMMENDATION_SWEEP_DUE_INTERVAL_MS } from './services/crewRecommendations';

/**
 * Builds the Fastify app without calling `listen()` — kept separate from server.ts so
 * integration tests can exercise the full HTTP surface via `app.inject()` against the real
 * test database without binding a port. See test/golden-path.test.ts.
 */
export function buildApp() {
  const app = Fastify({ logger, disableRequestLogging: config.NODE_ENV === 'test' });

  app.register(cookie);
  app.register(multipart, { limits: { fileSize: 6 * 1024 * 1024, files: 1 } });
  // Local-disk media serving — dev/test only. When S3 is configured, uploaded media is served
  // straight from the bucket (S3_PUBLIC_URL) and this route never sees a request; see
  // lib/mediaStorage.ts for why local disk isn't used in production at all.
  if (!s3Configured) {
    app.register(fastifyStatic, { root: UPLOAD_DIR, prefix: '/media/', decorateReply: false });
  }

  app.addHook('onRequest', async (request) => {
    await attachUser(request);
  });

  app.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, 'Unhandled route error');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({
      error: status === 500 ? 'internal_error' : 'request_error',
      message: status === 500 ? 'Something went wrong.' : err.message,
    });
  });

  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ok', db: 'ok', time: new Date().toISOString() });
    } catch (err) {
      app.log.error({ err }, 'Health check DB query failed');
      return reply.code(503).send({ status: 'error', db: 'unreachable' });
    }
  });

  /**
   * Public, read-only, no admin key — same trust level as `/health` above: timestamps only, no
   * secrets or user data. The real gap this closes: on a host that idle-sleeps (Render's free
   * tier — see docs/DEPLOYMENT.md, server.ts's own comment on `checkSweep`), NOTHING in-process
   * can prove the automatic recommendation sweep is actually running — the only way to find out
   * today was to read server logs nobody's watching. This lets anyone with the API's URL (a
   * browser tab is enough, no curl/headers needed) see, in plain terms, whether the sweep has
   * ever run and whether it's overdue by more than would be explained by the normal 15-minute
   * in-process check interval — which is the exact, specific symptom of a sleeping dyno with no
   * external cron pinging it. See `SWEEP_JOB_NAME`/`RECOMMENDATION_SWEEP_DUE_INTERVAL_MS` in
   * services/crewRecommendations.ts for what actually writes this row.
   */
  app.get('/health/scheduler', async (_request, reply) => {
    const state = await prisma.schedulerState.findUnique({ where: { jobName: SWEEP_JOB_NAME } });
    const now = Date.now();
    const dueIntervalHours = RECOMMENDATION_SWEEP_DUE_INTERVAL_MS / (60 * 60 * 1000);
    const lastRunAt = state?.lastRunAt ?? null;
    const nextDueAt = lastRunAt ? new Date(lastRunAt.getTime() + RECOMMENDATION_SWEEP_DUE_INTERVAL_MS) : null;
    // Grace beyond the due interval before calling it "overdue" rather than just "not due yet" —
    // wide enough to absorb the in-process 15-minute check cadence plus a slow cold start, so
    // this doesn't cry wolf on a perfectly healthy host between checks.
    const graceMs = 30 * 60 * 1000;
    const overdue = nextDueAt !== null && now - nextDueAt.getTime() > graceMs;
    const neverRun = lastRunAt === null;
    let diagnosis: string;
    if (neverRun) {
      diagnosis =
        'The sweep has never run since this SchedulerState row was created. If the API has been up for ' +
        'more than ~15 minutes, this is unexpected — check server logs for errors, or the process may not ' +
        'be staying alive long enough to complete the boot-time check.';
    } else if (overdue) {
      diagnosis =
        `Overdue: a sweep was due by ${nextDueAt!.toISOString()} but has not run since ${lastRunAt!.toISOString()}. ` +
        'The most common cause is an idle-sleeping host (e.g. Render free tier) with no external cron ' +
        'pinging POST /admin/recommendations/sweep to wake it — see docs/DEPLOYMENT.md Step 2.6.';
    } else {
      diagnosis = 'Healthy — the sweep has run within its expected cadence.';
    }
    return reply.send({
      jobName: SWEEP_JOB_NAME,
      lastRunAt: lastRunAt?.toISOString() ?? null,
      lastClaimedAt: state?.lastClaimedAt?.toISOString() ?? null,
      nextDueAt: nextDueAt?.toISOString() ?? null,
      dueIntervalHours,
      overdue,
      neverRun,
      diagnosis,
      lastResult: state?.lastResult ?? null,
    });
  });

  app.register(authRoutes);
  app.register(userRoutes);
  app.register(crewRoutes);
  app.register(matchRoutes);
  app.register(planRoutes);
  app.register(bookingRoutes);
  app.register(rewindRoutes);
  app.register(feedbackRoutes);
  app.register(exploreRoutes);
  app.register(locationRoutes);
  app.register(analyticsClientRoutes);
  app.register(adminRoutes, { prefix: '/admin' });

  return app;
}
