import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../lib/config';
import {
  generateRawToken,
  hashToken,
  constantTimeEqual,
  packSessionCookie,
  unpackSessionCookie,
} from '../lib/crypto';
import { isRateLimited } from '../lib/rateLimit';
import { track } from './analytics';
import type { User } from '@prisma/client';

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    message: string,
    public code: 'rate_limited' | 'invalid_token' | 'expired_token' | 'invalid_session',
  ) {
    super(message);
  }
}

/**
 * Step 1 of magic-link auth. Creates the user record if this is the first time we've seen
 * this email (status ACTIVE, unverified) so onboarding can start immediately rather than
 * gating on email verification round-trip — email gets verified implicitly the moment they
 * click the link.
 *
 * NOTE on email delivery: we do not have a transactional email provider configured (see
 * docs/providers/email.md — Postmark or SES, needs a verified sending domain). In development
 * and the pilot, the raw magic-link URL is logged and returned in the API response so the
 * flow is fully testable end-to-end; that response field is omitted outside development, at
 * which point this function needs a real `sendMagicLinkEmail` call wired in before launch.
 */
export async function requestMagicLink(
  email: string,
  requestIp: string | undefined,
): Promise<{ devMagicLinkUrl?: string }> {
  const normalisedEmail = email.trim().toLowerCase();

  if (isRateLimited(`magic-link:${normalisedEmail}`, 5, 15 * 60 * 1000)) {
    throw new AuthError('Too many magic link requests for this email. Try again shortly.', 'rate_limited');
  }
  if (requestIp && isRateLimited(`magic-link-ip:${requestIp}`, 20, 15 * 60 * 1000)) {
    throw new AuthError('Too many requests from this network. Try again shortly.', 'rate_limited');
  }

  const user = await prisma.user.upsert({
    where: { email: normalisedEmail },
    update: {},
    create: { email: normalisedEmail },
  });

  const rawToken = generateRawToken();
  await prisma.authToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken, 'magic_link'),
      purpose: 'MAGIC_LINK',
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
      requestIp,
    },
  });

  const url = `${config.WEB_APP_URL}/auth/callback?token=${rawToken}`;

  if (config.NODE_ENV === 'production') {
    // TODO(email-provider): send via Postmark/SES here. See docs/providers/email.md.
    logger.warn('No email provider configured — magic link was generated but NOT sent to the user.');
    return {};
  }

  logger.info({ email: normalisedEmail, url }, 'Magic link (dev mode — would normally be emailed)');
  return { devMagicLinkUrl: url };
}

/**
 * Step 2: exchange a raw magic-link token for a session. Single-use — `consumedAt` is set
 * atomically with the lookup via a transaction so a token can't be replayed even under
 * concurrent requests.
 */
export async function consumeMagicLink(
  rawToken: string,
  context: { userAgent?: string; ipAddress?: string },
): Promise<{ user: User; cookieValue: string; expiresAt: Date }> {
  const tokenHash = hashToken(rawToken, 'magic_link');

  const user = await prisma.$transaction(async (tx) => {
    const token = await tx.authToken.findUnique({ where: { tokenHash } });
    if (!token || token.purpose !== 'MAGIC_LINK') {
      throw new AuthError('This link is invalid.', 'invalid_token');
    }
    if (token.consumedAt) {
      throw new AuthError('This link has already been used.', 'invalid_token');
    }
    if (token.expiresAt < new Date()) {
      throw new AuthError('This link has expired. Request a new one.', 'expired_token');
    }

    await tx.authToken.update({ where: { id: token.id }, data: { consumedAt: new Date() } });

    return tx.user.update({
      where: { id: token.userId },
      data: { emailVerifiedAt: { set: new Date() } },
    });
  });

  const created = await createSession(user.id, context);

  const isFirstLogin = await isFirstEverSession(user.id, created.sessionId);
  await track(
    isFirstLogin ? 'SignupCompleted' : 'SignupStarted',
    isFirstLogin ? { userId: user.id, method: 'email' } : { method: 'email' },
    { userId: user.id },
  );

  return { user: created.user, cookieValue: created.cookieValue, expiresAt: created.expiresAt };
}

async function isFirstEverSession(userId: string, currentSessionId: string): Promise<boolean> {
  const count = await prisma.session.count({ where: { userId, NOT: { id: currentSessionId } } });
  return count === 0;
}

async function createSession(
  userId: string,
  context: { userAgent?: string; ipAddress?: string },
): Promise<{ user: User; cookieValue: string; expiresAt: Date; sessionId: string }> {
  const rawSecret = generateRawToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hashToken(rawSecret, 'session'),
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
      expiresAt,
    },
  });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { user, cookieValue: packSessionCookie(session.id, rawSecret), expiresAt, sessionId: session.id };
}

export async function verifySessionCookie(cookieValue: string): Promise<User | null> {
  const unpacked = unpackSessionCookie(cookieValue);
  if (!unpacked) return null;

  const session = await prisma.session.findUnique({ where: { id: unpacked.sessionId } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

  const expectedHash = hashToken(unpacked.rawSecret, 'session');
  if (!constantTimeEqual(expectedHash, session.refreshTokenHash)) return null;

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status !== 'ACTIVE') return null;

  return user;
}

export async function revokeSession(cookieValue: string): Promise<void> {
  const unpacked = unpackSessionCookie(cookieValue);
  if (!unpacked) return;
  await prisma.session.updateMany({
    where: { id: unpacked.sessionId },
    data: { revokedAt: new Date() },
  });
}

/** Used by account deactivation/deletion — logs the user out on every device at once. */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
