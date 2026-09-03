import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMagicLink, consumeMagicLink, loginOrRequestLink, revokeSession, AuthError } from '../services/auth';
import { SESSION_COOKIE, requireUser } from '../middleware/auth';
import { config } from '../lib/config';
import { oauthProviderStatus } from '../providers/oauth';

const MagicLinkRequestSchema = z.object({ email: z.string().email(), next: z.string().optional() });
const MagicLinkCallbackSchema = z.object({ token: z.string().min(10) });
const LoginRequestSchema = z.object({ email: z.string().email(), next: z.string().optional() });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/magic-link', async (request, reply) => {
    const parsed = MagicLinkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    try {
      const result = await requestMagicLink(parsed.data.email, request.ip, parsed.data.next);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(429).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/auth/callback', async (request, reply) => {
    const parsed = MagicLinkCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    try {
      const { user, cookieValue, expiresAt } = await consumeMagicLink(parsed.data.token, {
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      });

      reply.setCookie(SESSION_COOKIE, cookieValue, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        expires: expiresAt,
      });

      return reply.send({
        user: { id: user.id, email: user.email, displayName: user.displayName },
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // Pilot-scale instant login — see loginOrRequestLink's own doc comment for the tradeoff. A
  // RETURNING, already-verified user is logged straight in off the email alone, no link click;
  // a first-time or never-verified email falls through to the same real magic-link flow as
  // `/auth/magic-link` above, so the response shape branches on `mode` the way that one doesn't.
  app.post('/auth/login', async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    try {
      const result = await loginOrRequestLink(
        parsed.data.email,
        request.ip,
        { userAgent: request.headers['user-agent'], ipAddress: request.ip },
        parsed.data.next,
      );

      if (result.mode === 'logged_in') {
        reply.setCookie(SESSION_COOKIE, result.cookieValue, {
          httpOnly: true,
          secure: config.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          expires: result.expiresAt,
        });
        return reply.send({
          mode: 'logged_in',
          user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName },
        });
      }

      return reply.send({ mode: 'link_sent', devMagicLinkUrl: result.devMagicLinkUrl });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(429).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const cookieValue = request.cookies[SESSION_COOKIE];
    if (cookieValue) await revokeSession(cookieValue);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/auth/me', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id, email, displayName, status } = request.user;
    return reply.send({ user: { id, email, displayName, status } });
  });

  // Surfaces which OAuth providers are actually configured, so the web app can hide
  // "Continue with Google/Apple" buttons instead of offering a dead flow.
  app.get('/auth/providers', async (_request, reply) => {
    return reply.send(oauthProviderStatus());
  });
}
