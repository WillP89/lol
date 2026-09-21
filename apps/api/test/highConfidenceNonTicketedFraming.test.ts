import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * P0-URGENT SUPERSESSION: this file used to prove that a HIGH-confidence non-ticketed pick got
 * confident framing instead of the old ticketed-fallback hedge — real behaviour under the
 * previous "ticket preferred, non-ticketed fallback allowed" contract. Live founder testing of
 * the actual deployed product found that contract itself was the bug (an unticketed "Copper
 * Kettle"-class restaurant proactively sent, hedged or not — see crewRecommendations.ts's own
 * `isProactivelyEligible` comment). New absolute pilot rule: a real ticket is now a hard
 * eligibility gate, checked BEFORE quality/confidence ever matter. This file now proves the
 * opposite of what it used to: no amount of quality, specificity, or confidence rescues an
 * unticketed candidate — a ticket must never be optional, whatever else is true about the match.
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

describe('P0-URGENT: even a HIGH-confidence, genuinely strong non-ticketed pick is never sent proactively', () => {
  test('a real, strongly-matched restaurant (place-provider, never ticketed) is excluded outright — quality never rescues UNTICKETED', async () => {
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
    // Under the old contract this genuinely reached HIGH confidence and was delivered — proving
    // the ticket gate is what's excluding it now, not some other unrelated gap (plan-worthiness,
    // taste-signal, radius) that would make this test pass for the wrong reason.
    expect(delivered).toBeNull();

    const messages = await prisma.crewMessage.findMany({ where: { crewId: crew.id }, orderBy: { createdAt: 'asc' } });
    expect(messages.some((m) => m.body.includes('Kissho'))).toBe(false);
    const honestMessage = messages.find((m) => m.body.includes("don't have any"));
    expect(honestMessage).toBeDefined();
  });
});
