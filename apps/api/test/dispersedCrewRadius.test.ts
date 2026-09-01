import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * The actual reported bug: a real Crew whose two members live in Birmingham and London (a
 * completely normal case for a real friend group, not an edge case) got zero eligible
 * candidates from the automatic recommendation engine, forever — `withinRadius` was false for
 * literally every candidate. Root cause: distance was averaged across all members' homes, and
 * the average of two ~100-mile-apart points is never close to any single real venue, even one
 * sitting right next to one of them. Fixed in services/match.ts to use the nearest member's
 * distance instead. This proves the fix with the exact same geography as the production report.
 */
const app = buildApp();
const BIRMINGHAM = { city: 'Birmingham', lat: 52.4862, lng: -1.8904 };
const LONDON = { city: 'London', lat: 51.5072, lng: -0.1276 };

async function loginByEmail(email: string): Promise<string> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  return `${cookie.name}=${cookie.value}`;
}

describe('geographically dispersed Crews are not silently excluded from every recommendation', () => {
  let crewId = '';
  let ownerCookie = '';

  beforeAll(async () => {
    await resetDatabase();
    ownerCookie = await loginByEmail('dispersed-bham@plot-test.invalid');
    const londonerCookie = await loginByEmail('dispersed-ldn@plot-test.invalid');

    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: ownerCookie },
      payload: { displayName: 'Bham', homeCity: BIRMINGHAM.city, homeLat: BIRMINGHAM.lat, homeLng: BIRMINGHAM.lng },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: londonerCookie },
      payload: { displayName: 'Ldn', homeCity: LONDON.city, homeLat: LONDON.lat, homeLng: LONDON.lng },
    });

    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: ownerCookie },
      payload: { name: 'Dispersed Crew' },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    crewId = crew.id;
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: londonerCookie }, payload: { inviteCode: crew.inviteCode } });
  });

  test('at least one real candidate is recognised as within radius, not zero', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/find-us-something`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as { options: { withinRadius: boolean | null }[] };
    expect(options.length).toBeGreaterThan(0);
    // Before the fix, this was guaranteed false for every single option, for every dispersed
    // Crew, permanently — the exact failure mode reported in production.
    expect(options.some((o) => o.withinRadius === true)).toBe(true);
  });
});
