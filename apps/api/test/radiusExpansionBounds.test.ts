import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * P0-FINAL re-audit — "do not assume that multiplying radius is automatically the correct
 * product behaviour." The mission's own explicit requirement: quality/relevance can justify
 * travelling further, but Plot must still respect realistic Crew travel tolerance — a 50-mile
 * preferred radius must NOT blindly become a 150-mile recommendation just because a flat `3x`
 * multiplier says so, and a candidate that merely sits within a wide search radius (with no real
 * evidence it's worth the extra distance) must not get to use that allowance for free.
 *
 * Proves services/crewRecommendations.ts#computeSensibleExpansionMiles's three independent bounds
 * (relative cap, additive cap, absolute HARD_MAXIMUM_RADIUS_MILES ceiling) and the
 * `isSignificantOpportunity` gate against the real pipeline, not just the pure function in
 * isolation.
 */
const app = buildApp();
const CITY = { city: 'Radius Bounds Test City', lat: 52.8062, lng: -2.1169 };
const MILE_IN_DEGREES_LAT = 1 / 69;

function milesNorth(miles: number): { lat: number; lng: number } {
  return { lat: CITY.lat + miles * MILE_IN_DEGREES_LAT, lng: CITY.lng };
}

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

async function setUpMember(email: string): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: CITY.city, homeLat: CITY.lat, homeLng: CITY.lng },
  });
  return member;
}

async function createCrew(ownerCookie: string, name: string): Promise<{ id: string; inviteCode: string }> {
  const res = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: ownerCookie }, payload: { name, defaultCity: CITY.city } });
  return (res.json() as { crew: { id: string; inviteCode: string } }).crew;
}

async function setCrewPreferences(crewId: string, cookie: string, interestPreferences: string[], travelRadiusMeters: number) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/crews/${crewId}/recommendation-settings`,
    headers: { cookie },
    payload: { interestPreferences, travelRadiusMeters },
  });
  expect(res.statusCode).toBe(200);
}

async function joinCrew(inviteCode: string, cookie: string) {
  const res = await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie }, payload: { inviteCode } });
  expect(res.statusCode).toBe(200);
}

async function seedExperience(opts: {
  name: string;
  category: 'RESTAURANT' | 'LIVE_MUSIC' | 'COMEDY';
  subcategories?: string[];
  description: string;
  milesAway: number;
  priceMinMinor?: number | null;
  eventProvider?: string;
}) {
  const { lat, lng } = milesNorth(opts.milesAway);
  const venue = await prisma.venue.create({ data: { name: `${opts.name} Venue`, city: CITY.city, latitude: lat, longitude: lng } });
  return prisma.experience.create({
    data: {
      canonicalKey: `radius-bounds-${opts.name}-${venue.id}`,
      name: opts.name,
      description: opts.description,
      category: opts.category,
      subcategories: opts.subcategories ?? [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      qualityScore: 80,
      bookingStatus: 'AVAILABLE',
      priceMinMinor: opts.priceMinMinor ?? null,
      priceMaxMinor: opts.priceMinMinor ? opts.priceMinMinor + 1000 : null,
      tags: opts.eventProvider ? { provider: opts.eventProvider } : {},
    },
  });
}

async function deliveredRecommendation(crewId: string) {
  const rec = await prisma.crewRecommendation.findFirst({
    where: { crewId },
    orderBy: { createdAt: 'desc' },
    include: { experience: { select: { name: true } } },
  });
  return rec ? { experienceName: rec.experience.name, score: rec.score, reasonText: rec.reasonText } : null;
}

describe('Radius expansion respects realistic Crew travel tolerance, not a blind multiplier', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('a 50-mile preferred radius does NOT blindly expand to 150 miles (3x) — a genuinely significant but 90-mile-away opportunity is still out of reach', async () => {
    const suffix = Date.now();
    // A real ticketed festival — maximally "significant" by every signal this file recognises —
    // still 90 miles away. Under the OLD flat `3x` multiplier this would have been in-reach
    // (150mi ceiling); under the new bounded model it must not be.
    await seedExperience({
      name: `Distant Ticketed Festival ${suffix}`,
      category: 'RESTAURANT',
      description: 'A real ticketed food festival, one day only.',
      milesAway: 90,
      priceMinMinor: 2000,
      eventProvider: 'skiddle',
      subcategories: ['italian'],
    });

    const owner = await setUpMember(`bounds-a-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`bounds-a-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Bounds A Crew ${suffix}`);
    // 50 real miles — the RADIUS_CHIPS "Up to 50mi" tier in the real Crew settings UI.
    await setCrewPreferences(crew.id, owner.cookie, ['food_festivals', 'italian'], Math.round(50 * 1609.34));
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    // Nothing should have been delivered — a 90-mile trip was never sensible for a 50-mile
    // preference, however strong the candidate. "SEND NOTHING" is the correct, honest outcome.
    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered).toBeNull();
  });

  test('a 10-mile preferred radius can sensibly stretch to a genuinely strong ~25-mile match', async () => {
    const suffix = Date.now();
    await seedExperience({
      name: `Nearby Weak Gig ${suffix}`,
      category: 'LIVE_MUSIC',
      description: 'A regular live music night at a local venue.',
      milesAway: 3,
    });
    await seedExperience({
      name: `Strong Rock Gig ${suffix}`,
      category: 'LIVE_MUSIC',
      description: 'A real alternative rock gig, touring band.',
      milesAway: 24,
      subcategories: ['alternative'],
    });

    const owner = await setUpMember(`bounds-b-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`bounds-b-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Bounds B Crew ${suffix}`);
    // 10 real miles — the RADIUS_CHIPS "Up to 10mi" tier.
    await setCrewPreferences(crew.id, owner.cookie, ['live_gigs', 'alternative'], Math.round(10 * 1609.34));
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered?.experienceName).toBe(`Strong Rock Gig ${suffix}`);
    expect(delivered?.reasonText).toMatch(/worth the extra \d+ miles?/i);
  });

  test('a candidate with no real significance evidence cannot use the wider search allowance just because it sits inside it', async () => {
    const suffix = Date.now();
    // Ordinary, untagged, no subcategory match to the Crew's own picks, not ticketed — the
    // ONLY thing going for it is that it happens to be inside the widened search radius.
    await seedExperience({
      name: `Ordinary Distant Gig ${suffix}`,
      category: 'LIVE_MUSIC',
      description: 'A regular live music night at a venue further out.',
      milesAway: 22, // beyond the ~standard sensible band for an 8-mile base, well within the widest search tier
    });

    const owner = await setUpMember(`bounds-c-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`bounds-c-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Bounds C Crew ${suffix}`);
    await setCrewPreferences(crew.id, owner.cookie, ['live_gigs'], Math.round(8 * 1609.34));
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    // No significance evidence (not ticketed, not VERY_HIGH, no confirmed genre match) — must not
    // be delivered just for sitting inside the widened search tier.
    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered).toBeNull();
  });
});
