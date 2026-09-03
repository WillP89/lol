import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real, live-reported bug this proves fixed: "Request to /users/me/avatar/preset failed" on
 * every single Plot avatar pick, no exceptions. Root cause — PlotAvatars.tsx (web) went through
 * a full character-set replacement ("SECOND FULL REPLACEMENT", its own header explains — the
 * first cartoon-animal set was rejected outright via direct live feedback), which changed every
 * preset's id (fox/owl/bear/... -> sparky/blink/gummy/...). The frontend picker was updated to
 * match; this route's own `z.enum` validator, the one thing that has to agree with it byte-for-
 * byte, was not — so every real request the (correct, current) picker could ever send failed
 * validation and 400'd. Zero prior test coverage on this endpoint is exactly why it went
 * unnoticed as long as it did.
 */
const app = buildApp();

async function loginByEmail(email: string): Promise<{ cookie: string }> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  return { cookie: `${cookie.name}=${cookie.value}` };
}

describe('POST /users/me/avatar/preset', () => {
  test('accepts every real id the current PlotAvatars.tsx picker can actually send', async () => {
    await resetDatabase();
    const { cookie } = await loginByEmail('avatar-preset@plot-test.invalid');

    // The full, current character set — see web/components/PlotAvatars.tsx's own id list.
    const currentPresetIds = ['sparky', 'blink', 'gummy', 'drift', 'nova', 'pip', 'zag', 'ember', 'lull', 'patch', 'puff', 'flare'];
    for (const presetId of currentPresetIds) {
      const res = await app.inject({ method: 'POST', url: '/users/me/avatar/preset', headers: { cookie }, payload: { presetId } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ avatarUrl: `plot-avatar:${presetId}` });
    }
  });

  test('rejects a retired first-generation id (fox/owl/bear/...) — never silently accepted as if it still existed', async () => {
    await resetDatabase();
    const { cookie } = await loginByEmail('avatar-preset-old@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: '/users/me/avatar/preset', headers: { cookie }, payload: { presetId: 'fox' } });
    expect(res.statusCode).toBe(400);
  });

  test('rejects a genuinely made-up id', async () => {
    await resetDatabase();
    const { cookie } = await loginByEmail('avatar-preset-bogus@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: '/users/me/avatar/preset', headers: { cookie }, payload: { presetId: 'not-a-real-avatar' } });
    expect(res.statusCode).toBe(400);
  });

  test('the stored marker actually persists onto the user row', async () => {
    await resetDatabase();
    const { cookie } = await loginByEmail('avatar-preset-persist@plot-test.invalid');
    await app.inject({ method: 'POST', url: '/users/me/avatar/preset', headers: { cookie }, payload: { presetId: 'patch' } });

    const meRes = await app.inject({ method: 'GET', url: '/users/me', headers: { cookie } });
    const { user } = meRes.json() as { user: { avatarUrl: string | null } };
    expect(user.avatarUrl).toBe('plot-avatar:patch');
  });
});
