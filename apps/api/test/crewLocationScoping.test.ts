import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real, live-reported bug: "ran the same test with a new crew and it's come back to say can't
 * find any events in London, why? honestly no food event in London? find that very hard to
 * believe" — correctly so. Root cause: services/match.ts#scoreExperiencesForCrew used to pull a
 * bare `take: 50` slice of the WHOLE Experience table, every city this pilot has ever synced
 * inventory for combined, with no location scoping and no explicit ordering at all. As that
 * table accumulates real cities beyond wherever a given Crew actually is, an arbitrary,
 * database-order-dependent slice of 50 rows can land entirely on OTHER cities' events, missing a
 * Crew's own city's genuinely relevant inventory completely — reproduced here by flooding the
 * table with far more "elsewhere" candidates than the old cap, then proving the genuinely
 * relevant, nearby one is still found.
 *
 * The second half of the same live request: "one of the key parts of creating a group should be
 * setting the location and the distance from said location... to ensure it's finding events in
 * the right location" — Crew.latitude/.longitude (set via POST /crews at creation or PATCH
 * /crews/:id/location afterwards) is the feature this proves end-to-end: a Crew's own explicit
 * location, with zero members actually living there, is enough on its own to find real inventory
 * near it.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
// Genuinely distant from London (390+ miles) — real coordinates, an invented city label so
// ensureInventory's own mock-provider city lookups have zero real coverage to contaminate this
// test with, same isolation precedent as crewCategoryPreferences.test.ts's own use of Truro.
const FAR_AWAY = { city: 'Farflung Test City', lat: 57.1497, lng: -2.0943 };
const LONDON = { lat: 51.5072, lng: -0.1276 };
// The take:50 cap this bug lived in — flooding well past it proves the fix, not just "50 still
// happens to be enough".
const FLOOD_COUNT = 80;

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

async function setUpMemberNoTaste(email: string): Promise<{ userId: string; cookie: string }> {
  // Deliberately no home location set at all — this Crew's ability to find anything near London
  // must come entirely from its own explicit location, never a member's.
  return loginByEmail(email);
}

async function seedExperience(name: string, category: string, venueName: string, lat: number, lng: number) {
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
      city: FAR_AWAY.city,
      latitude: lat,
      longitude: lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience;
}

describe('a Crew\'s own explicit location finds real inventory near it, however deep the table is', () => {
  test('POST /crews accepts an explicit location, reflected straight back', async () => {
    await resetDatabase();
    const owner = await loginByEmail('crewloc-create-owner@plot-test.invalid');
    const res = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Location At Creation', defaultCity: 'London', latitude: LONDON.lat, longitude: LONDON.lng },
    });
    expect(res.statusCode).toBe(201);
    const { crew } = res.json() as { crew: { defaultCity: string | null; latitude: number | null; longitude: number | null } };
    expect(crew.defaultCity).toBe('London');
    expect(crew.latitude).toBeCloseTo(LONDON.lat, 3);
    expect(crew.longitude).toBeCloseTo(LONDON.lng, 3);
  });

  test('PATCH /crews/:id/location sets it after creation, and null explicitly clears it', async () => {
    await resetDatabase();
    const owner = await loginByEmail('crewloc-patch-owner@plot-test.invalid');
    const createRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Patch Location Crew' } });
    const { crew } = createRes.json() as { crew: { id: string; latitude: number | null } };
    expect(crew.latitude).toBeNull(); // never set at creation this time

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/location`,
      headers: { cookie: owner.cookie },
      payload: { defaultCity: 'London', latitude: LONDON.lat, longitude: LONDON.lng },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((patchRes.json() as { crew: { latitude: number | null } }).crew.latitude).toBeCloseTo(LONDON.lat, 3);

    const clearRes = await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/location`,
      headers: { cookie: owner.cookie },
      payload: { defaultCity: null, latitude: null, longitude: null },
    });
    expect(clearRes.statusCode).toBe(200);
    const cleared = (clearRes.json() as { crew: { defaultCity: string | null; latitude: number | null; longitude: number | null } }).crew;
    expect(cleared.defaultCity).toBeNull();
    expect(cleared.latitude).toBeNull();
    expect(cleared.longitude).toBeNull();
  });

  test('a genuinely relevant event near the Crew\'s own explicit London location is found, even flooded by 80 unrelated far-away rows', async () => {
    await resetDatabase();
    // Flood the table with real, quality-passing, in-window candidates that have nothing to do
    // with this Crew — the exact "other cities' inventory dominates an unordered take:50" bug.
    for (let i = 0; i < FLOOD_COUNT; i++) {
      await seedExperience(`Farflung Restaurant Night ${i}`, 'RESTAURANT', `Farflung Venue ${i}`, FAR_AWAY.lat, FAR_AWAY.lng);
    }
    // The one genuinely relevant candidate, seeded LAST — under the old bare `take: 50` with no
    // ordering, a row seeded after 80 others is exactly the shape of row an arbitrary/insertion-
    // order-leaning cap would miss.
    await seedExperience('Real London Street Food Market', 'RESTAURANT', 'Borough Market', LONDON.lat, LONDON.lng);

    const owner = await setUpMemberNoTaste('crewloc-owner@plot-test.invalid');
    const mate = await setUpMemberNoTaste('crewloc-mate@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Real London Crew', defaultCity: 'London', latitude: LONDON.lat, longitude: LONDON.lng },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['RESTAURANT'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes(' — /plans/'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('Real London Street Food Market');
    // Never the honest-empty message either — real inventory genuinely exists here.
    expect(messages.some((m) => m.body.includes("don't have any"))).toBe(false);
  });
});
