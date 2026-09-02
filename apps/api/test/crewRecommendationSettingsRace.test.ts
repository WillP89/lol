import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { getOrCreateSettings } from '../src/services/crewRecommendations';

/**
 * Real bug found operating this in production for the first time: two truly concurrent calls to
 * getOrCreateSettings for the SAME brand-new (never-before-touched) Crew raced each other's
 * upsert — both saw "no row yet", both attempted CREATE, the loser crashed with a raw Prisma
 * P2002 unique-constraint error instead of getting the settings row it asked for. This is
 * reproducible in the real, deployed shape of the bug (a Crew that has genuinely never had its
 * settings row touched before, hit by two simultaneous readers), not a synthetic case.
 */
const app = buildApp();

async function loginByEmail(email: string): Promise<string> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  return `${cookie.name}=${cookie.value}`;
}

describe('getOrCreateSettings: concurrent first-read race on a brand-new Crew', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  test('two simultaneous callers both get the same settings row, neither throws', async () => {
    const cookie = await loginByEmail('settings-race-owner@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie },
      payload: { name: 'Settings Race Crew', defaultCity: 'Stafford' },
    });
    const { crew } = crewRes.json() as { crew: { id: string } };

    // This Crew's CrewRecommendationSettings row has never been created — exactly the state
    // that reproduced the crash. Fire two calls at the exact same instant.
    const [a, b] = await Promise.all([getOrCreateSettings(crew.id), getOrCreateSettings(crew.id)]);

    expect(a).toEqual({ enabled: true, maxPerWeek: 2, travelRadiusMeters: null, categoryPreferences: [], interestPreferences: [], preferencesSetAt: null });
    expect(b).toEqual(a);
  });

  test('a genuinely concurrent burst of 5 callers on one new Crew all succeed', async () => {
    const cookie = await loginByEmail('settings-race-owner2@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie },
      payload: { name: 'Settings Race Crew 2', defaultCity: 'Stafford' },
    });
    const { crew } = crewRes.json() as { crew: { id: string } };

    const results = await Promise.all(Array.from({ length: 5 }, () => getOrCreateSettings(crew.id)));
    for (const r of results) expect(r).toEqual({ enabled: true, maxPerWeek: 2, travelRadiusMeters: null, categoryPreferences: [], interestPreferences: [], preferencesSetAt: null });
  });
});
