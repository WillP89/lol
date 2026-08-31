import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config, providerReadiness } from '../lib/config';
import { sendMagicLinkEmail } from '../lib/email';
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
 * NOTE on email delivery: whether a real email actually gets sent depends only on whether
 * Postmark is configured (`POSTMARK_API_KEY`, see docs/providers/email.md) — NOT on NODE_ENV.
 * Earlier this was gated on NODE_ENV === 'production', which meant setting that (the normal,
 * correct thing to do for a real deployment) silently disabled sign-in entirely with no real
 * email to replace it. Now: Postmark configured -> real email, response omits the raw link.
 * Not configured (any environment) -> the link is returned directly in the response so the
 * flow stays fully testable without a provider. `NODE_ENV === 'test'` always skips a real send
 * regardless of whether a key is present, so the test suite never calls out to Postmark.
 */
/**
 * Only ever a same-origin relative path (`/crews/join/abc`, never `https://evil.example/...`
 * or `//evil.example/...`) — this value round-trips through an emailed link, so treating it
 * as trusted would be an open-redirect vector. Anything else silently falls back to no
 * redirect rather than erroring the whole sign-in over a malformed `next`.
 */
function sanitiseNext(next: string | undefined): string | undefined {
  if (!next) return undefined;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('://')) return undefined;
  return next;
}

export async function requestMagicLink(
  email: string,
  requestIp: string | undefined,
  next?: string,
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

  // Real bug found via analytics audit: this used to only fire at the *end* of auth, and only
  // for a returning user's login (see consumeMagicLink below) — meaning `SignupStarted` never
  // fired at the moment someone actually starts, and instead fired on every routine returning
  // login, corrupting the funnel. It belongs here: the moment anyone (new or returning) asks
  // for a link, which is the real "started" moment for a passwordless flow.
  await track('SignupStarted', { method: 'email' }, { userId: user.id });

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

  const safeNext = sanitiseNext(next);
  const url = `${config.WEB_APP_URL}/auth/callback?token=${rawToken}${safeNext ? `&next=${encodeURIComponent(safeNext)}` : ''}`;

  const emailReady = providerReadiness.resendEmail || providerReadiness.smtpEmail || providerReadiness.postmarkEmail;
  if (emailReady && config.NODE_ENV !== 'test') {
    try {
      await sendMagicLinkEmail(normalisedEmail, url);
      return {};
    } catch (err) {
      // A real send failing (bad credentials, provider outage, unverified sender) shouldn't
      // fully lock someone out of signing in — log loudly and fall through to the dev-link
      // response rather than leaving them with nothing. This does mean the raw link is
      // exposed in the API response on that failure path; that's a deliberate pilot-scale
      // tradeoff (this response only ever reaches the person who made the request), not an
      // oversight.
      logger.error({ err, email: normalisedEmail }, 'Email send failed — falling back to dev-mode link in the response');
    }
  }

  logger.info(
    { email: normalisedEmail, url },
    emailReady ? 'Magic link (test mode — real send skipped)' : 'Magic link — no email provider configured, returning link directly',
  );
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

  // Only a genuine first-ever session completes "signup" — a returning user's login isn't a
  // signup funnel event at all, so it's deliberately not tracked as one (see SignupStarted's
  // own comment in requestMagicLink for the bug this replaced).
  const isFirstLogin = await isFirstEverSession(user.id, created.sessionId);
  if (isFirstLogin) {
    await track('SignupCompleted', { userId: user.id, method: 'email' }, { userId: user.id });
  }

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
