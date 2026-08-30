import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config';

/**
 * Token handling for magic links and sessions.
 *
 * We never store a raw, guessable secret in the database. A raw token is generated, handed to
 * the client (in the magic-link URL, or in the session cookie), and only its HMAC digest is
 * persisted — so a database read (backup leak, SQL injection, careless admin query) does not
 * hand out usable credentials. This is the same shape as how most production auth systems
 * (e.g. Lucia, Django's session framework) handle opaque tokens, deliberately chosen over
 * storing bcrypt/argon2 hashes here because these are high-entropy random tokens, not
 * low-entropy user-chosen passwords — HMAC is the correct, cheaper primitive for that case.
 */

export function generateRawToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function hashToken(raw: string, purpose: 'magic_link' | 'session'): string {
  const secret = purpose === 'magic_link' ? config.TOKEN_HASH_SECRET : config.SESSION_SECRET;
  return createHmac('sha256', secret).update(raw).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Session cookie value is `${sessionId}.${rawSecret}` — id for O(1) DB lookup, secret verified via HMAC. */
export function packSessionCookie(sessionId: string, rawSecret: string): string {
  return `${sessionId}.${rawSecret}`;
}

export function unpackSessionCookie(cookie: string): { sessionId: string; rawSecret: string } | null {
  const idx = cookie.indexOf('.');
  if (idx === -1) return null;
  const sessionId = cookie.slice(0, idx);
  const rawSecret = cookie.slice(idx + 1);
  if (!sessionId || !rawSecret) return null;
  return { sessionId, rawSecret };
}
