import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * Real bug this closes, found running a controlled 5-Crew baseline audit: `usedTicketedFallback`
 * is a SUPPLY-TYPE signal ("this pick isn't itself a ticketed/dated event"), not a QUALITY
 * signal — but it used to unconditionally override confidence-based copy, so a genuinely
 * excellent, HIGH-confidence match that simply happened to be a restaurant/bar/market (real
 * FHRS/OSM/Google Places/Foursquare inventory — most of what those sources ARE is inherently
 * non-ticketed) got the SAME hedging "There's not much in your area right now" preface as a
 * genuine last-resort compromise. That directly undercuts "Plot found this because it
 * understands us" even when the match is genuinely strong. See crewTicketedFirstRecommendation
 * .test.ts's own second test for the case this must NOT change: a genuinely MEDIUM/weak
 * non-ticketed pick still gets the honest hedge.
 */
const app = buildApp();
const STAFFORD = { city: 'High Confidence Framing Test City', lat: 52.8062, lng: -2.1169 };
const STONE = { lat: 52.9046, lng: -2.1548 };
const RADIUS_METERS = Math.round(25 * 1609.34);

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

describe('a HIGH-confidence non-ticketed pick gets honest, confident framing — never the ticketed-fallback hedge', () => {
  test('a real, strongly-matched restaurant (place-provider, never ticketed) is framed as a great fit, not a compromise', async () => {
    await resetDatabase();
    const venue = await prisma.venue.create({ data: { name: 'Kissho', city: 'Stone', latitude: STONE.lat, longitude: STONE.lng } });
    await prisma.experience.create({
      data: {
        canonicalKey: 'test-high-confidence-kissho',
        name: 'Kissho: Japanese Supper Club',
        // P0-FINAL-1 ("The Hidden Chef" fix): an ordinary restaurant is no longer plan-worthy on
        // its own, any source — this fixture needs a genuine specialness signal (a one-off supper
        // club event, not a permanent menu) to reach HIGH plan-worthiness, exactly the same as a
        // real live listing would need to clear the bar this test is actually about (confident,
        // un-hedged framing for a genuinely strong non-ticketed pick).
        description: 'A real, specific Japanese supper club test fixture — a one-off tasting menu event, with enough description to pass quality scoring.',
        category: 'RESTAURANT',
        subcategories: ['japanese', 'sushi'],
        venueId: venue.id,
        startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        qualityScore: 80,
        bookingStatus: 'AVAILABLE',
        priceMinMinor: 2000,
        priceMaxMinor: 3500,
        tags: { provider: 'openstreetmap' }, // a real place-provider source — never ticketed
      },
    });

    const owner = await loginByEmail('high-conf-owner@plot-test.invalid');
    const mate = await loginByEmail('high-conf-mate@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'High Confidence Test Crew', defaultCity: STAFFORD.city, latitude: STAFFORD.lat, longitude: STAFFORD.lng },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['RESTAURANT'], interestPreferences: ['japanese'], travelRadiusMeters: RADIUS_METERS },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const delivered = await prisma.crewRecommendation.findFirst({ where: { crewId: crew.id }, include: { experience: true } });
    expect(delivered).not.toBeNull();
    expect(delivered!.experience!.name).toBe('Kissho: Japanese Supper Club');
    // The real regression this proves fixed: confirms the setup actually reached HIGH first —
    // otherwise this test would trivially pass for the wrong reason.
    expect(delivered!.confidence).toBe('HIGH');
    expect(delivered!.reasonText).not.toContain("There's not much in your area right now");

    const messages = await prisma.crewMessage.findMany({ where: { crewId: crew.id }, orderBy: { createdAt: 'asc' } });
    const announcement = messages.find((m) => m.body.includes(' — /plans/'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).not.toContain("There's not much in your area right now");
    // The real, honest, confident framing this fix restores for a genuinely great match.
    expect(announcement!.body).toContain('We think this is a great fit for your Crew');
  });
});
