import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real, live-reported bug — the exact incident that shipped this fix: two fresh Crews in
 * Stafford (one SPORT-preference, one CLUBBING/LIVE_MUSIC-preference) both showed a genuine
 * "0 scored / 0 in radius" outcome, even after confirming real inventory existed. Root cause,
 * found via the admin `/admin/experiences-near` diagnostic added alongside this fix:
 * services/match.ts#scoreExperiencesForCrew's proximity query selected the 50 NEAREST rows
 * across EVERY category first, and only filtered down to the Crew's own explicit category/
 * interest preference AFTER that cut. Stafford's real FHRS feed (a food-hygiene register, not an
 * events source) had ~130 RESTAURANT/BAR rows sitting essentially on top of the town centre — a
 * genuinely relevant SPORT event 15-20km out, still well inside the Crew's own travel radius,
 * never had a chance to be one of the 50 candidates considered, however deep that inventory
 * actually was. This reproduces the exact shape: flood a Crew's own city with far more
 * same-point RESTAURANT rows than the take-50 cap, category-preference the Crew to SPORT only,
 * and prove the one genuinely relevant, farther-out SPORT event still gets found.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
// Real Stafford town-centre coordinates — same reference point the live incident used.
const TOWN_CENTRE = { city: 'Density Test City', lat: 52.8062, lng: -2.1169 };
// ~18km out — comfortably inside a 40km Crew radius, but far enough that a naive nearest-50-
// across-every-category cut, flooded with 0km rows, would never reach it.
const NEARBY_STADIUM = { lat: 52.9436, lng: -2.0913 };
// The take:50 proximity cap this bug lived in — well past it proves the fix, not just "50 still
// happens to be enough" (same discipline as crewLocationScoping.test.ts's own FLOOD_COUNT).
const FLOOD_COUNT = 70;

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

async function seedExperience(name: string, category: string, venueName: string, lat: number, lng: number): Promise<void> {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category,
      venueName,
      city: TOWN_CENTRE.city,
      latitude: lat,
      longitude: lng,
      startsAt,
      priceMinMinor: 1000,
      priceMaxMinor: 2500,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
}

describe('a category-preferred Crew finds real inventory even when a dense, unrelated local cluster would otherwise crowd it out', () => {
  test('the one real, farther-out SPORT event still reaches a SPORT-only Crew, despite 70 nearer RESTAURANT rows', async () => {
    await resetDatabase();
    // The dense, irrelevant local cluster — same shape as Stafford's real FHRS restaurant/bar
    // flood, all essentially on top of the Crew's own reference point.
    for (let i = 0; i < FLOOD_COUNT; i++) {
      await seedExperience(`Local Restaurant ${i}`, 'RESTAURANT', `Local Venue ${i}`, TOWN_CENTRE.lat, TOWN_CENTRE.lng);
    }
    // The one genuinely relevant candidate — seeded last, farther out, real SPORT inventory.
    await seedExperience('Real Local Derby Match', 'SPORT', 'Nearby Stadium', NEARBY_STADIUM.lat, NEARBY_STADIUM.lng);

    const owner = await loginByEmail('density-owner@plot-test.invalid');
    const mate = await loginByEmail('density-mate@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Density Test Crew', defaultCity: TOWN_CENTRE.city, latitude: TOWN_CENTRE.lat, longitude: TOWN_CENTRE.lng },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['SPORT'], travelRadiusMeters: 40000 },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500)); // let the real join-triggered guaranteeFirst check land

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes(' — /plans/'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('Real Local Derby Match');
    // Never the honest-empty message — real, in-radius, on-category inventory genuinely exists.
    expect(messages.some((m) => m.body.includes("don't have any"))).toBe(false);
  });
});
