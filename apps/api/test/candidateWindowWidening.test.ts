import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real, live-reported ask: "would it not be better to widen the date range... if users can't see
 * events near them in 90 days?" Investigating it surfaced a real, concrete gap: inventorySync.ts
 * already fetches and stores a full 60 days of real provider inventory on every sync (see
 * `syncAllProviders`'s own `toDate.setDate(toDate.getDate() + 60)`) — but match.ts's own
 * CANDIDATE_WINDOW_DAYS (and explore.ts's identical EXPLORE_WINDOW_DAYS) only ever considered the
 * first 21 of those 60 already-ingested days eligible. For an infrequent real category (a
 * once-a-month boxing card, a seasonal festival), the actual event could be sitting in the
 * database the whole time, 25-40 days out, silently excluded — no product rationale for "21"
 * ever existed, it was an unexamined technical default. Widened to 45 (leaving real margin under
 * the 60-day sync window). This test proves a real event 35 days out — genuinely too far for the
 * OLD window, comfortably inside the new one — now clears real Crew matching end-to-end.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
const TEST_CITY = { city: 'Truro', lat: 50.2632, lng: -5.051 }; // zero mock coverage — isolates this proof

async function loginByEmail(email: string): Promise<{ userId: string; cookie: string }> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  const { user } = callbackRes.json() as { user: { id: string } };
  return { userId: user.id, cookie: `${cookie.name}=${cookie.value}` };
}

async function seedExperience(name: string, daysAhead: number) {
  const startsAt = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category: 'FESTIVAL',
      subcategories: ['food festivals'],
      venueName: 'Candidate Window Test Venue',
      city: TEST_CITY.city,
      latitude: TEST_CITY.lat,
      longitude: TEST_CITY.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience;
}

describe('CANDIDATE_WINDOW_DAYS widened to 45 — a real event 35 days out now clears Crew matching', () => {
  test('a food festival 35 days out is found by Find Us Something (outside the old 21-day window, inside the new 45-day one)', async () => {
    await resetDatabase();
    await seedExperience('Cornwall Street Food Festival', 35);

    const owner = await loginByEmail('window-widen-owner@plot-test.invalid');
    const mate = await loginByEmail('window-widen-mate@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Festival Crew', defaultCity: TEST_CITY.city, latitude: TEST_CITY.lat, longitude: TEST_CITY.lng },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['FESTIVAL'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });

    const res = await app.inject({ method: 'POST', url: `/crews/${crew.id}/find-us-something`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as { options: { experience: { name: string } }[] };
    expect(options.some((o) => o.experience.name === 'Cornwall Street Food Festival')).toBe(true);
  });
});
