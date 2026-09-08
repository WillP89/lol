import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * GET /admin/crews/:id/explain-recommendation — real gap this closes: every doc/code comment
 * referencing this exact route (services/match.ts, services/crewRecommendations.ts,
 * services/opportunityIntent.ts, docs/DECISIONS.md) described a route that was never actually
 * registered; `explainCrewRecommendation` only ever ran embedded inside `/admin/users/lookup`,
 * one Crew at a time, keyed by a member's email. This is the direct, single-Crew version — no
 * email lookup needed when you already have a Crew id (e.g. from its URL).
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';

async function loginByEmail(email: string): Promise<string> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  return `${cookie.name}=${cookie.value}`;
}

describe('GET /admin/crews/:id/explain-recommendation', () => {
  test('requires the admin key, same as every other /admin/* route', async () => {
    await resetDatabase();
    const owner = await loginByEmail('explain-owner1@plot-test.invalid');
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner }, payload: { name: 'Explain Test Crew' } });
    const { crew } = crewRes.json() as { crew: { id: string } };

    const noKeyRes = await app.inject({ method: 'GET', url: `/admin/crews/${crew.id}/explain-recommendation` });
    expect(noKeyRes.statusCode).toBe(401);

    const wrongKeyRes = await app.inject({ method: 'GET', url: `/admin/crews/${crew.id}/explain-recommendation`, headers: { 'x-admin-key': 'wrong' } });
    expect(wrongKeyRes.statusCode).toBe(401);
  });

  test('accepts the key as a query param too, so the whole thing can be pasted straight into a browser', async () => {
    await resetDatabase();
    const owner = await loginByEmail('explain-owner2@plot-test.invalid');
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner }, payload: { name: 'Explain Test Crew 2' } });
    const { crew } = crewRes.json() as { crew: { id: string } };

    const res = await app.inject({ method: 'GET', url: `/admin/crews/${crew.id}/explain-recommendation?key=${ADMIN_KEY}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { crewId: string; crewName: string; outcome: string };
    expect(body.crewId).toBe(crew.id);
    expect(body.crewName).toBe('Explain Test Crew 2');
    // A one-member Crew with no location/preferences set yet hits the very first real gate.
    expect(body.outcome).toBe('preferences_not_set');
  });

  test('a Crew id that does not exist is a clean 404, never a raw 500', async () => {
    await resetDatabase();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/crews/00000000-0000-0000-0000-000000000000/explain-recommendation',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  test('reads exactly the same live outcome the automatic engine would act on', async () => {
    await resetDatabase();
    const owner = await loginByEmail('explain-owner3@plot-test.invalid');
    const mate = await loginByEmail('explain-mate3@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner },
      payload: { name: 'Explain Test Crew 3', defaultCity: 'Explain Test City', latitude: 52.8062, longitude: -2.1169 },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner },
      payload: { categoryPreferences: ['RESTAURANT'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500)); // let the real join-triggered guaranteeFirst check land

    const res = await app.inject({ method: 'GET', url: `/admin/crews/${crew.id}/explain-recommendation`, headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { outcome: string };
    // No real inventory was seeded for this city — the honest, real outcome, not preferences_not_set
    // (preferences ARE set) and not a fabricated eligible/delivered.
    expect(body.outcome).toBe('no_eligible_candidate');

    const rec = await prisma.crewRecommendation.findFirst({ where: { crewId: crew.id } });
    expect(rec).toBeNull(); // the debug call itself never sends anything
  });
});
