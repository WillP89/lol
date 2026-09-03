import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real, live-reported bug this proves fixed: "The avatar section for the crews is still not
 * right... change them to match the profile avatars now!" — a Crew's own mark used to be one of
 * 8 abstract themed-poster icons (night_out/festival/pub/...), a genuinely different id space
 * from the redrawn Plot Character collection personal identity picks from. web/components/
 * IdentityPicker.tsx now offers a Crew the exact same character set as a person's own identity —
 * this route's own `z.enum` validator, the one thing that has to agree with the web picker
 * byte-for-byte, was updated in the same commit specifically to avoid the exact bug class already
 * proven out (and fixed) in avatarPreset.test.ts: a picker sending real, current ids that a stale
 * backend enum doesn't recognise, silently 400ing on every real request. Zero prior test
 * coverage on this endpoint at all — exactly why that class of bug reaches production twice.
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

async function createCrew(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/crews', headers: { cookie }, payload: { name } });
  const { crew } = res.json() as { crew: { id: string } };
  return crew.id;
}

describe('POST /crews/:id/image/preset', () => {
  test('accepts every real id the current IdentityPicker.tsx picker can actually send for a Crew', async () => {
    await resetDatabase();
    const { cookie } = await loginByEmail('crewart-preset@plot-test.invalid');
    const crewId = await createCrew(cookie, 'Crew Art Preset Test');

    // The full, current character set — the same one PLOT_AVATARS (web/components/
    // PlotAvatars.tsx) offers, since IdentityPicker.tsx now shares it between kind: 'avatar' and
    // kind: 'crew'.
    const currentThemeIds = ['sparky', 'blink', 'gummy', 'drift', 'nova', 'pip', 'zag', 'ember', 'lull', 'patch', 'puff', 'flare'];
    for (const themeId of currentThemeIds) {
      const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/image/preset`, headers: { cookie }, payload: { themeId } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ imageUrl: `plot-crew-art:${themeId}` });
    }
  });

  test('rejects a retired first-generation theme id (night_out/pub/...) — never silently accepted as if it still existed', async () => {
    await resetDatabase();
    const { cookie } = await loginByEmail('crewart-preset-old@plot-test.invalid');
    const crewId = await createCrew(cookie, 'Crew Art Preset Old Test');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/image/preset`, headers: { cookie }, payload: { themeId: 'pub' } });
    expect(res.statusCode).toBe(400);
  });

  test('rejects a genuinely made-up id', async () => {
    await resetDatabase();
    const { cookie } = await loginByEmail('crewart-preset-bogus@plot-test.invalid');
    const crewId = await createCrew(cookie, 'Crew Art Preset Bogus Test');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/image/preset`, headers: { cookie }, payload: { themeId: 'not-a-real-character' } });
    expect(res.statusCode).toBe(400);
  });

  test('the stored marker actually persists onto the Crew row', async () => {
    await resetDatabase();
    const { cookie } = await loginByEmail('crewart-preset-persist@plot-test.invalid');
    const crewId = await createCrew(cookie, 'Crew Art Preset Persist Test');
    await app.inject({ method: 'POST', url: `/crews/${crewId}/image/preset`, headers: { cookie }, payload: { themeId: 'patch' } });

    const crewRes = await app.inject({ method: 'GET', url: `/crews/${crewId}`, headers: { cookie } });
    const { crew } = crewRes.json() as { crew: { imageUrl: string | null } };
    expect(crew.imageUrl).toBe('plot-crew-art:patch');
  });

  test('a non-member of the Crew cannot set its art', async () => {
    await resetDatabase();
    const owner = await loginByEmail('crewart-preset-owner@plot-test.invalid');
    const crewId = await createCrew(owner.cookie, 'Crew Art Preset Auth Test');
    const outsider = await loginByEmail('crewart-preset-outsider@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/image/preset`, headers: { cookie: outsider.cookie }, payload: { themeId: 'sparky' } });
    expect(res.statusCode).toBe(403);
  });
});
