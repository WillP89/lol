import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { config } from './lib/config';
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

/**
 * Builds the Fastify app without calling `listen()` — kept separate from server.ts so
 * integration tests can exercise the full HTTP surface via `app.inject()` against the real
 * test database without binding a port. See test/golden-path.test.ts.
 */
export function buildApp() {
  const app = Fastify({ logger, disableRequestLogging: config.NODE_ENV === 'test' });

  app.register(cookie);

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

  app.register(authRoutes);
  app.register(userRoutes);
  app.register(crewRoutes);
  app.register(matchRoutes);
  app.register(planRoutes);
  app.register(bookingRoutes);
  app.register(rewindRoutes);
  app.register(feedbackRoutes);
  app.register(adminRoutes, { prefix: '/admin' });

  return app;
}
