import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real gap this closes: a Crew whose creation flow was abandoned between the mandatory taste
 * step and "Invite" (closed the tab, backgrounded the app) is a real, joinable DB row with no
 * preference ever saved — evaluateCrewEligibility silently returns `preferences_not_set`
 * forever, and until this fix the only prompt for that lived inside the "Find us something"
 * sheet, never shown just from opening the Crew. GET /crews/:id now exposes `preferencesSet` so
 * the Crew page itself can show a persistent, honest banner instead of a Crew that silently
 * never says anything.
 */
const app = buildApp();

async function loginByEmail(email: string): Promise<string> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('no session cookie');
  return `${cookie.name}=${cookie.value}`;
}

describe('GET /crews/:id exposes preferencesSet', () => {
  test('a brand-new Crew with no settings row at all reports preferencesSet: false, preferencesSource: null', async () => {
    await resetDatabase();
    const owner = await loginByEmail('prefs-flag-owner1@plot-test.invalid');
    const createRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner }, payload: { name: 'Abandoned Onboarding Crew' } });
    const { crew } = createRes.json() as { crew: { id: string } };

    const res = await app.inject({ method: 'GET', url: `/crews/${crew.id}`, headers: { cookie: owner } });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { crew: { preferencesSet: boolean; preferencesSource: string | null } }).crew;
    expect(body.preferencesSet).toBe(false);
    expect(body.preferencesSource).toBeNull();
  });

  test('a Crew that completed the taste step reports preferencesSet: true, preferencesSource: EXPLICIT', async () => {
    await resetDatabase();
    const owner = await loginByEmail('prefs-flag-owner2@plot-test.invalid');
    const createRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner }, payload: { name: 'Set Up Crew' } });
    const { crew } = createRes.json() as { crew: { id: string } };
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner },
      payload: { interestPreferences: ['rock'] },
    });

    const res = await app.inject({ method: 'GET', url: `/crews/${crew.id}`, headers: { cookie: owner } });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { crew: { preferencesSet: boolean; preferencesSource: string | null } }).crew;
    expect(body.preferencesSet).toBe(true);
    expect(body.preferencesSource).toBe('EXPLICIT');
  });

  test('a Crew whose taste was safely inferred from real member overlap reports preferencesSet: true, preferencesSource: DERIVED', async () => {
    await resetDatabase();
    const owner = await loginByEmail('prefs-flag-owner3@plot-test.invalid');
    await app.inject({ method: 'POST', url: '/users/me/taste/interests', headers: { cookie: owner }, payload: { updates: [{ interestId: 'rock', strength: 'love' }] } });
    const createRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner }, payload: { name: 'Derived Crew' } });
    const { crew } = createRes.json() as { crew: { id: string } };
    // Sweeping runs tryDeriveAndApplyCrewPreferences before evaluating eligibility — the same
    // real trigger a periodic sweep or a manual "Find us something" would hit.
    await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': 'dev_admin_key_change_me' }, payload: { crewId: crew.id } });

    const res = await app.inject({ method: 'GET', url: `/crews/${crew.id}`, headers: { cookie: owner } });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { crew: { preferencesSet: boolean; preferencesSource: string | null } }).crew;
    expect(body.preferencesSet).toBe(true);
    expect(body.preferencesSource).toBe('DERIVED');
  });
});
