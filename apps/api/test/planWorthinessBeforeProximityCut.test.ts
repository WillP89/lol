import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * Real gap this closes, found in a follow-up gate audit run right after the "Caffè Nero in
 * London" plan-worthiness fix shipped: `isPlanWorthyForCrew` used to run only AFTER the
 * nearest-50-by-distance cut in services/match.ts — the EXACT same bug shape as the earlier,
 * already-fixed `passesPreferenceGate`-after-the-cut incident (a dense local FHRS restaurant
 * cluster crowding out a farther-but-real SPORT candidate). Here the density is chains, not
 * category: a town centre saturated with 55 generic coffee/fast-food chains (all closer than a
 * genuine independent restaurant, all force-floored to VERY_LOW by isGenericChainName) used to
 * fill the entire top-50 distance slice before the one real, non-chain restaurant — sitting
 * farther out but still comfortably inside the Crew's own travel radius — ever got the chance to
 * be scored at all. Moving `isPlanWorthyForCrew` to run at the same early stage as
 * `passesPreferenceGate` (before the nearest-50 cut, not after) fixes this the same way.
 */
const app = buildApp();
const CITY = { city: 'Chain-Saturated Test City', lat: 52.8062, lng: -2.1169 };
const RADIUS_MILES = 25;
const RADIUS_METERS = Math.round(RADIUS_MILES * 1609.34);

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

async function seedPlaceProviderExperience(opts: { name: string; lat: number; lng: number; description?: string }) {
  const venue = await prisma.venue.create({ data: { name: opts.name, city: CITY.city, latitude: opts.lat, longitude: opts.lng } });
  return prisma.experience.create({
    data: {
      canonicalKey: `test-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${venue.id}`,
      name: opts.name,
      description: opts.description ?? `${opts.name} — a real test fixture with enough description to pass quality scoring, in ${CITY.city}.`,
      category: 'RESTAURANT',
      subcategories: [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      qualityScore: 80,
      bookingStatus: 'AVAILABLE',
      priceMinMinor: null,
      priceMaxMinor: null,
      tags: { provider: 'openstreetmap' },
    },
  });
}

describe('isPlanWorthyForCrew runs before, not after, the nearest-50 proximity cut', () => {
  test('55 nearer chain venues never crowd out a genuine independent restaurant sitting farther out but still in-radius', async () => {
    await resetDatabase();
    const owner = await loginByEmail('chain-density-owner@plot-test.invalid');
    const mate = await loginByEmail('chain-density-mate@plot-test.invalid');

    // 55 generic chain venues, all within ~1-2 miles of the Crew (closer than the genuine
    // independent restaurant below) — real UK chain names isGenericChainName already recognises.
    const CHAIN_NAMES = ['Caffè Nero', 'Costa Coffee', "McDonald's", 'Greggs', 'Starbucks', 'KFC', 'Subway', 'Pret A Manger', 'Burger King', 'Wetherspoon'];
    const seeds = Array.from({ length: 55 }, (_, i) => {
      const angle = (i / 55) * 2 * Math.PI;
      const offsetDeg = 0.01 + (i % 5) * 0.002; // ~1-2 miles, always nearer than the independent below
      return seedPlaceProviderExperience({
        name: `${CHAIN_NAMES[i % CHAIN_NAMES.length]} #${i}`,
        lat: CITY.lat + offsetDeg * Math.cos(angle),
        lng: CITY.lng + offsetDeg * Math.sin(angle),
      });
    });
    await Promise.all(seeds);

    // The one genuine, non-chain, independent restaurant — deliberately farther out (~8 miles,
    // well outside the chain cluster) but still comfortably inside the Crew's 25-mile radius.
    // P0-FINAL-1 ("The Hidden Chef" fix): an ordinary restaurant no longer clears the plan-
    // worthiness bar on its own, any source — this fixture needs a genuine specialness signal (a
    // one-off supper club/tasting event, not a permanent menu) to stay eligible, so this test can
    // still prove its actual point (the early gate runs before the nearest-50 cut) without
    // depending on behaviour the product now deliberately no longer has.
    await seedPlaceProviderExperience({
      name: 'The Old Mill Bistro',
      lat: CITY.lat + 0.12,
      lng: CITY.lng + 0.05,
      description: 'The Old Mill Bistro — a one-off supper club tasting menu event, with enough description to pass quality scoring.',
    });

    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Chain Density Test Crew', defaultCity: CITY.city, latitude: CITY.lat, longitude: CITY.lng },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['RESTAURANT'], travelRadiusMeters: RADIUS_METERS },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 700));

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes(' — /plans/'));
    expect(announcement).toBeDefined();
    // The real regression this proves fixed: before the fix, 55 nearer chains would have
    // entirely filled the nearest-50 slice, the genuine independent restaurant would never even
    // have been scored, and this Crew would have gotten the honest "nothing yet" message instead.
    expect(announcement!.body).toContain('The Old Mill Bistro');
    expect(messages.some((m) => CHAIN_NAMES.some((chain) => m.body.includes(chain)))).toBe(false);
  });
});
