import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * P0-FINAL-2 — "QUALITY MUST BEAT PROXIMITY": a real, live-reported failure. Plot was sending
 * whatever cleared the bar CLOSEST, never asking whether something genuinely stronger existed a
 * bit further out. This is the mission's own three worked cases, proven live against the real
 * scoring/eligibility pipeline (services/crewRecommendations.ts#evaluateCrewEligibility's radius-
 * expansion head-to-head): a weak-but-technically-in-radius candidate must never beat a strong,
 * genuinely taste-matched one that's a reasonable stretch further away — and when the distant one
 * wins, the delivery must say so honestly, never present it as local.
 *
 * Every candidate is seeded directly via prisma (not the /admin/experiences/manual endpoint,
 * which always writes `tags: {}` — UNKNOWN source) so the "ticketed" cases can carry a real
 * EVENT_PROVIDER tag, exactly like a live Ticketmaster/Skiddle row would.
 */
const app = buildApp();
const CITY = { city: 'Quality Proximity City', lat: 52.8062, lng: -2.1169 };
const MILE_IN_DEGREES_LAT = 1 / 69; // rough, good enough at these magnitudes — see haversineMiles for the real distance the app itself computes

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

/** Seeds a real Venue+Experience row directly, bypassing the manual-curation endpoint (which
 *  always writes tags: {}) so a candidate can carry a real EVENT_PROVIDER source when the test
 *  needs a genuinely ticketed one. */
async function seedExperience(opts: {
  name: string;
  category: 'RESTAURANT' | 'LIVE_MUSIC' | 'COMEDY';
  subcategories?: string[];
  description: string;
  milesAway: number;
  priceMinMinor?: number | null;
  eventProvider?: string; // real EVENT_PROVIDER id (e.g. 'skiddle') — omit for UNKNOWN source
}) {
  const { lat, lng } = milesNorth(opts.milesAway);
  const venue = await prisma.venue.create({ data: { name: `${opts.name} Venue`, city: CITY.city, latitude: lat, longitude: lng } });
  return prisma.experience.create({
    data: {
      canonicalKey: `qbp-${opts.name}-${venue.id}`,
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

/** The immediate post-join trigger (guaranteeFirst) races any follow-up `explain-recommendation`
 *  call — by the time a diagnostic re-evaluation runs, the real delivery has often already
 *  happened and cadence-gates the diagnostic to `too_soon` (same documented race this session's
 *  earlier P0 acceptance test hit). Reading the actual delivered `CrewRecommendation` row
 *  directly is what a real Crew member would actually see, and is immune to that race. */
async function deliveredRecommendation(crewId: string) {
  const rec = await prisma.crewRecommendation.findFirst({
    where: { crewId },
    orderBy: { createdAt: 'desc' },
    include: { experience: { select: { name: true } } },
  });
  return rec ? { experienceName: rec.experience.name, score: rec.score, reasonText: rec.reasonText } : null;
}

describe('Quality beats proximity — the three mission-specified cases', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('CASE A: a ticketed Italian food festival 22 miles away beats an ordinary weak restaurant 3 miles away', async () => {
    const suffix = Date.now();
    // Weak, 3 miles away — an ordinary independent restaurant, no occasion signal at all. Under
    // the P0-FINAL-1 fix this is LOW plan-worthiness and never even reaches eligibility, whatever
    // its distance — the real, structural half of "quality beats proximity" for this case.
    await seedExperience({ name: `Nearby Trattoria ${suffix}`, category: 'RESTAURANT', description: 'An Italian restaurant.', milesAway: 3, subcategories: ['italian'] });
    // Strong, 22 miles away — a real, ticketed, dated food festival with genuine Italian/street-
    // food signal in its own text, sourced from a real EVENT_PROVIDER.
    await seedExperience({
      name: `Italian Street Food Festival ${suffix}`,
      category: 'RESTAURANT',
      description: 'A real Italian street food festival, ticketed, one day only.',
      milesAway: 22,
      priceMinMinor: 1200,
      eventProvider: 'skiddle',
      subcategories: ['italian'],
    });

    const owner = await setUpMember(`case-a-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`case-a-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Case A Crew ${suffix}`);
    await setCrewPreferences(crew.id, owner.cookie, ['food_festivals', 'street_food', 'italian'], 12875);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    // Read the real delivered CrewRecommendation directly — see deliveredRecommendation's own
    // comment on why this is more reliable than a follow-up explain-recommendation call, which
    // races the immediate post-join trigger's own delivery and can read `too_soon`.
    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered?.experienceName).toBe(`Italian Street Food Festival ${suffix}`);
    // Honest distance acknowledgment — never presented as if it were local.
    expect(delivered?.reasonText).toMatch(/worth the extra \d+ miles?/i);
  });

  test('CASE B: a strong alternative-rock gig 25 miles away beats a generic untagged live-music night 5 miles away', async () => {
    const suffix = Date.now();
    await seedExperience({ name: `Generic Live Music Night ${suffix}`, category: 'LIVE_MUSIC', description: 'A regular live music night at a local venue.', milesAway: 5 });
    await seedExperience({
      name: `Alt Rock Showcase ${suffix}`,
      category: 'LIVE_MUSIC',
      description: 'A real alternative rock gig, touring band.',
      milesAway: 20,
      subcategories: ['alternative'],
      priceMinMinor: 1600,
      eventProvider: 'skiddle',
    });

    const owner = await setUpMember(`case-b-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`case-b-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Case B Crew ${suffix}`);
    await setCrewPreferences(crew.id, owner.cookie, ['live_gigs', 'alternative'], 12875);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered?.experienceName).toBe(`Alt Rock Showcase ${suffix}`);
    expect(delivered?.reasonText).toMatch(/worth the extra \d+ miles?/i);
  });

  test('CASE C: a real ticketed stand-up show 20 miles away beats a generic pub comedy night with weak metadata 4 miles away', async () => {
    const suffix = Date.now();
    await seedExperience({ name: `Pub Comedy Night ${suffix}`, category: 'COMEDY', description: 'A comedy night at a local pub.', milesAway: 4 });
    await seedExperience({
      name: `Stand-Up Comedy Tour ${suffix}`,
      category: 'COMEDY',
      description: 'A real ticketed stand-up comedy show, touring headline act.',
      milesAway: 20,
      priceMinMinor: 1800,
      eventProvider: 'ticketmaster',
      subcategories: ['stand_up'],
    });

    const owner = await setUpMember(`case-c-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`case-c-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Case C Crew ${suffix}`);
    await setCrewPreferences(crew.id, owner.cookie, ['stand_up'], 12875);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered?.experienceName).toBe(`Stand-Up Comedy Tour ${suffix}`);
    expect(delivered?.reasonText).toMatch(/worth the extra \d+ miles?/i);
  });

  test('a strong LOCAL match is never displaced by a merely-comparable distant one — expansion only wins on genuine, real superiority', async () => {
    const suffix = Date.now();
    // A strong, ticketed, exactly-matching LOCAL candidate — nothing distant should beat this.
    await seedExperience({
      name: `Local Ticketed Comedy Show ${suffix}`,
      category: 'COMEDY',
      description: 'A real ticketed stand-up comedy show, right in town.',
      milesAway: 2,
      priceMinMinor: 1800,
      eventProvider: 'ticketmaster',
      subcategories: ['stand_up'],
    });
    // A weaker distant candidate that would ordinarily need expansion to even be reached.
    await seedExperience({ name: `Distant Pub Comedy ${suffix}`, category: 'COMEDY', description: 'A comedy night at a pub.', milesAway: 25 });

    const owner = await setUpMember(`case-local-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`case-local-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Local Wins Crew ${suffix}`);
    await setCrewPreferences(crew.id, owner.cookie, ['stand_up'], 12875);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered?.experienceName).toBe(`Local Ticketed Comedy Show ${suffix}`);
    expect(delivered?.reasonText).not.toMatch(/worth the extra/i);
  });
});
