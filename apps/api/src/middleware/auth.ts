import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifySessionCookie } from '../services/auth';

const SESSION_COOKIE = 'plot_session';

export { SESSION_COOKIE };

/**
 * Attaches `request.user` when a valid session cookie is present. Does NOT reject the
 * request — routes that require auth call `requireUser(request, reply)` explicitly, so
 * public routes (Plan Card pages, health check) can still read `request.user` when present
 * (e.g. to personalise a Plan Card for a logged-in viewer) without forcing a login wall.
 */
export async function attachUser(request: FastifyRequest): Promise<void> {
  const cookieValue = request.cookies[SESSION_COOKIE];
  if (!cookieValue) return;
  const user = await verifySessionCookie(cookieValue);
  if (user) request.user = user;
}

export function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
): request is FastifyRequest & { user: NonNullable<FastifyRequest['user']> } {
  if (!request.user) {
    reply.code(401).send({ error: 'unauthorized', message: 'Sign in required.' });
    return false;
  }
  return true;
}
