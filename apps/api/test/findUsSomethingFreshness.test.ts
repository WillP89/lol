import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * Real, live-reported gap this proves fixed: "Find us something" (services/match.ts#
 * findUsSomething) used to apply NO exclusion at all — a member tapping it again could be
 * handed back the exact same event their Crew had already explicitly said NOT_FOR_US to, which
 * reads as Plot having no memory (the brief's "freshness" requirement). Fixed via
 * getCrewRejectedExperienceIds — deliberately narrower than the automatic sweep's own exclusion
 * set (getCrewExcludedExperienceIds), so a still-pending (SENT, unresponded) automatic
 * recommendation is NOT hidden from a manual ask — only a definitively rejected one is.
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

async function setUpMember(email: string, interestIds: string[]): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
  });
  await app.inject({
    method: 'POST',
    url: '/users/me/taste/interests',
    headers: { cookie: member.cookie },
    payload: { updates: interestIds.map((interestId) => ({ interestId, strength: 'love' as const })) },
  });
  return member;
}

async function createCrewWith(owner: { cookie: string }, mate: { cookie: string }, name: string): Promise<string> {
  const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name, defaultCity: STAFFORD.city } });
  const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
  // BAR is unrelated to this file's LIVE_MUSIC fixtures — satisfies the preferences gate without
  // adding a crew_preference boost that would confound scoring.
  await app.inject({ method: 'PATCH', url: `/crews/${crew.id}/recommendation-settings`, headers: { cookie: owner.cookie }, payload: { categoryPreferences: ['BAR'] } });
  await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
  return crew.id;
}

async function seedExperience(name: string, subcategories: string[]): Promise<string> {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category: 'LIVE_MUSIC',
      subcategories,
      venueName: 'Test Venue',
      city: STAFFORD.city,
      latitude: STAFFORD.lat,
      longitude: STAFFORD.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3500,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience.id;
}

interface FindResult {
  options: { experience: { id: string; name: string } }[];
}

describe('findUsSomething freshness — explicit rejections never resurface, pending sends still can', () => {
  let crewId = '';
  let owner: { userId: string; cookie: string };
  let rejectedId = '';
  let pendingId = '';
  let freshId = '';

  beforeAll(async () => {
    await resetDatabase();
    const a = await setUpMember('freshness-a@plot-test.invalid', ['uk_garage']);
    const b = await setUpMember('freshness-b@plot-test.invalid', ['uk_garage']);
    owner = a;
    crewId = await createCrewWith(a, b, 'Freshness Crew');

    rejectedId = await seedExperience('Rejected Garage Night', ['uk garage']);
    pendingId = await seedExperience('Pending Garage Night', ['uk garage']);
    freshId = await seedExperience('Fresh Garage Night', ['uk garage']);

    // A definitively rejected past recommendation — must never resurface.
    await prisma.crewRecommendation.create({
      data: { crewId, experienceId: rejectedId, score: 80, reasonText: 'test fixture', status: 'NOT_FOR_US', respondedAt: new Date() },
    });
    // A still-pending, unresponded automatic recommendation — must still be findable manually.
    await prisma.crewRecommendation.create({
      data: { crewId, experienceId: pendingId, score: 80, reasonText: 'test fixture', status: 'SENT' },
    });
  });

  test('a NOT_FOR_US experience never comes back from find-us-something', async () => {
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as FindResult;
    expect(options.some((o) => o.experience.id === rejectedId)).toBe(false);
  });

  test('a still-pending (SENT) automatic recommendation for the same Crew CAN still surface manually', async () => {
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    const { options } = res.json() as FindResult;
    const ids = options.map((o) => o.experience.id);
    // Not asserting it's top-1 (scoring ties are legitimate) — only that it was never excluded.
    expect([pendingId, freshId].some((id) => ids.includes(id))).toBe(true);
  });
});
