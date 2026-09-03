import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * `POST /auth/login` — the pilot-scale instant-login shortcut (see loginOrRequestLink's own doc
 * comment in src/services/auth.ts for the tradeoff this is a deliberate acceptance of). Covers
 * exactly the distinction the feature depends on: a first-time/never-verified email still gets
 * the real magic-link round-trip, a returning already-verified one skips it — never the reverse.
 */

const app = buildApp();

beforeAll(async () => {
  await resetDatabase();
});

describe('POST /auth/login', () => {
  test('a brand-new email gets the real magic-link flow, not an instant session', async () => {
    const email = 'newcomer@plot-test.invalid';

    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mode: string; devMagicLinkUrl?: string };
    expect(body.mode).toBe('link_sent');
    expect(body.devMagicLinkUrl).toBeTruthy();
    // No session cookie handed out for an unverified email — instant login never applies here.
    expect(res.cookies.find((c) => c.name === 'plot_session')).toBeUndefined();

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
  });

  test('an existing but never-verified email still gets the link flow, not instant login', async () => {
    // Real distinction this proves: existing != verified. A user record can exist (e.g. someone
    // requested a link and never clicked it) without ever having proven inbox ownership —
    // instant login must not treat "has a row" as "has verified".
    const email = 'unverified@plot-test.invalid';
    const first = await app.inject({ method: 'POST', url: '/auth/login', payload: { email } });
    expect((first.json() as { mode: string }).mode).toBe('link_sent');

    const second = await app.inject({ method: 'POST', url: '/auth/login', payload: { email } });
    const body = second.json() as { mode: string };
    expect(body.mode).toBe('link_sent');
    expect(second.cookies.find((c) => c.name === 'plot_session')).toBeUndefined();
  });

  test('a returning, already-verified email logs straight in — no link, no token', async () => {
    const email = 'returning@plot-test.invalid';

    // First prove ownership the real way, exactly like a normal first sign-in.
    const linkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
    const { devMagicLinkUrl } = linkRes.json() as { devMagicLinkUrl: string };
    const token = new URL(devMagicLinkUrl).searchParams.get('token');
    const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
    expect(callbackRes.statusCode).toBe(200);

    // Now the pilot shortcut: email alone, no token in sight.
    const loginRes = await app.inject({ method: 'POST', url: '/auth/login', payload: { email } });
    expect(loginRes.statusCode).toBe(200);
    const body = loginRes.json() as { mode: string; user?: { email: string } };
    expect(body.mode).toBe('logged_in');
    expect(body.user?.email).toBe(email);

    const cookie = loginRes.cookies.find((c) => c.name === 'plot_session');
    expect(cookie).toBeTruthy();

    // The returned cookie is a real, working session — not just a response shape.
    const meRes = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `${cookie!.name}=${cookie!.value}` } });
    expect(meRes.statusCode).toBe(200);
    expect((meRes.json() as { user: { email: string } }).user.email).toBe(email);
  });

  test('a deactivated user does not get instant-logged in even if previously verified', async () => {
    const email = 'deactivated@plot-test.invalid';
    const linkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
    const { devMagicLinkUrl } = linkRes.json() as { devMagicLinkUrl: string };
    const token = new URL(devMagicLinkUrl).searchParams.get('token');
    await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });

    await prisma.user.update({ where: { email }, data: { status: 'DEACTIVATED' } });

    const loginRes = await app.inject({ method: 'POST', url: '/auth/login', payload: { email } });
    const body = loginRes.json() as { mode: string };
    // Falls through to the link flow rather than silently failing — same shape as a first-timer,
    // never a session for an account that isn't ACTIVE.
    expect(body.mode).toBe('link_sent');
    expect(loginRes.cookies.find((c) => c.name === 'plot_session')).toBeUndefined();
  });

  test('rejects a malformed email', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'not-an-email' } });
    expect(res.statusCode).toBe(400);
  });
});
