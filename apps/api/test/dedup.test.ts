import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * The actual reported bug: two "Jorja Smith DJ Set" cards, different dates, same venue family —
 * see services/entityResolution.ts#dedupeNearDuplicates for the root cause writeup. This proves
 * the fix at the level a user actually experiences it: real HTTP responses from "Find us
 * something" and Explore, not just the pure function in isolation (unit/entityResolution.test.ts
 * already covers that).
 */

const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
const STAFFORD = { city: 'Stafford', lat: 52.8062, lng: -2.1169 };

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

async function seedExperience(name: string, venueName: string, daysOut: number) {
  const startsAt = new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category: 'LIVE_MUSIC',
      venueName,
      city: STAFFORD.city,
      latitude: STAFFORD.lat,
      longitude: STAFFORD.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}-${daysOut}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience;
}

describe('event deduplication: the actual "Jorja Smith DJ Set" duplicate, end to end', () => {
  let crewId = '';
  let member: { userId: string; cookie: string };

  beforeAll(async () => {
    await resetDatabase();
    member = await loginByEmail('dedup-member@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: member.cookie },
      payload: { displayName: 'Dedup Tester', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/taste',
      headers: { cookie: member.cookie },
      payload: {
        swipes: [{ category: 'live_music', choice: 'yes' as const }],
        budget: { minMinor: 1000, maxMinor: 8000, currency: 'GBP' },
        travelRadiusMeters: 24000,
        energyPreference: 'MEDIUM',
      },
    });
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: member.cookie },
      payload: { name: 'Dedup Test Crew', defaultCity: STAFFORD.city },
    });
    crewId = (crewRes.json() as { crew: { id: string } }).crew.id;
    // "no events or things should be done on crew until preference set" — required before
    // find-us-something will do anything.
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crewId}/recommendation-settings`,
      headers: { cookie: member.cookie },
      payload: { categoryPreferences: ['BAR'] },
    });

    // The exact bug: same fictional artist, same venue name, genuinely different Experience
    // rows (different day, so a different canonicalKey — this does NOT collide on the DB
    // unique constraint, same as the real "Stafford" vs "Stone" city-alias case).
    await seedExperience('Jorja Smith DJ Set', 'Stafford County Showground', 5);
    await seedExperience('Jorja Smith DJ Set', 'Stafford County Showground', 6);
    // A genuinely different event stays a genuinely different option.
    await seedExperience('Bicep', 'Victoria Hall', 7);
  });

  test('"Find us something" never shows the same event twice', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/find-us-something`,
      headers: { cookie: member.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as { options: { experience: { name: string } }[] };
    const jorjaCount = options.filter((o) => o.experience.name === 'Jorja Smith DJ Set').length;
    expect(jorjaCount).toBeLessThanOrEqual(1);
  });

  test('Explore never shows the same event twice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/explore/experiences?city=${encodeURIComponent(STAFFORD.city)}`,
      headers: { cookie: member.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { experiences } = res.json() as { experiences: { name: string; listings?: { externalUrl: string }[] }[] };
    // Scoped to the two admin-seeded fixtures THIS test itself created (identified by their own
    // external URLs, both containing "Jorja%20Smith%20DJ%20Set-") rather than a blanket
    // system-wide name count. "This area" now correctly also covers real neighbouring-town
    // inventory (see services/inventorySync.ts#ensureLocalAreaInventory) — the Staffordshire
    // mock catalogue's own recurring "Jorja Smith DJ Set" template can legitimately surface a
    // genuinely separate real listing from a nearby town under that same generic name; that's a
    // distinct real event, not a duplicate of this test's own fixture pair, and conflating the
    // two would be testing something this test was never actually about.
    const seededJorjas = experiences.filter((e) => e.name === 'Jorja Smith DJ Set' && e.listings?.some((l) => l.externalUrl.includes('/Jorja%20Smith%20DJ%20Set-')));
    expect(seededJorjas).toHaveLength(1);
    // The genuinely different event is untouched.
    expect(experiences.filter((e) => e.name === 'Bicep')).toHaveLength(1);
  });
});
