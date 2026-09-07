import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * Real, live-reported product requirement, stated plainly: "I need ticketed only events...
 * don't think we need to include or focus on unpaid, no ticket events. This kills the app a bit
 * for me." A real ticket is now the PRIMARY criterion for Plot's own automatic Crew
 * recommendation — proven two ways:
 *
 *  1. When a real ticketed candidate exists alongside a non-ticketed one (both otherwise
 *     eligible), the ticketed one wins, with the normal confident "Plot found something" framing
 *     — never the fallback caveat when a real ticket genuinely was available.
 *  2. When NOTHING ticketed clears the Crew's own eligibility bar, Plot still sends its best
 *     available (non-ticketed) match — never silence — but honestly prefaces it: "There's not
 *     much in your area right now, so how about this" (product spec's own exact wording),
 *     applied to both the chat announcement AND the stored `reasonText` explanation.
 *
 * Uses direct Prisma seeding with `tags.provider` set exactly as a real adapter would (see
 * services/opportunityIntent.ts's own EVENT_PROVIDER_IDS/PLACE_PROVIDER_IDS), so
 * deriveSourceKind/isTicketedEvent classify these fixtures exactly as they would the real thing.
 */
const app = buildApp();
// A real Stafford lat/lng, an invented city label with zero mock-provider coverage — same
// isolation precedent as crewRecommendationHardGates.test.ts's own STAFFORD constant.
const STAFFORD = { city: 'Stafford Ticketed-First Test City', lat: 52.8062, lng: -2.1169 };
const STONE = { lat: 52.9046, lng: -2.1548 }; // ~7 real miles from Stafford — unambiguously in-radius
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

async function seedExperience(opts: {
  name: string;
  category: string;
  lat: number;
  lng: number;
  provider: string; // real adapter id (ticketed) or place-provider id (never ticketed)
  priceMinMinor: number | null;
}) {
  const venue = await prisma.venue.create({ data: { name: opts.name, city: 'Stone', latitude: opts.lat, longitude: opts.lng } });
  return prisma.experience.create({
    data: {
      canonicalKey: `test-ticketed-first-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${venue.id}`,
      name: opts.name,
      description: `${opts.name} — a real test fixture with enough description to pass quality scoring.`,
      category: opts.category as never,
      subcategories: [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      qualityScore: 80,
      bookingStatus: 'AVAILABLE',
      priceMinMinor: opts.priceMinMinor,
      priceMaxMinor: opts.priceMinMinor !== null ? opts.priceMinMinor + 1500 : null,
      tags: { provider: opts.provider },
    },
  });
}

async function createStaffordCrew(ownerEmail: string, mateEmail: string, categoryPreferences: string[]): Promise<string> {
  const owner = await loginByEmail(ownerEmail);
  const mate = await loginByEmail(mateEmail);
  const crewRes = await app.inject({
    method: 'POST',
    url: '/crews',
    headers: { cookie: owner.cookie },
    payload: { name: 'Ticketed-First Test Crew', defaultCity: STAFFORD.city, latitude: STAFFORD.lat, longitude: STAFFORD.lng },
  });
  const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
  await app.inject({
    method: 'PATCH',
    url: `/crews/${crew.id}/recommendation-settings`,
    headers: { cookie: owner.cookie },
    payload: { categoryPreferences, travelRadiusMeters: RADIUS_METERS },
  });
  await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  return crew.id;
}

describe('a real ticketed event beats a non-ticketed one, always', () => {
  test('given both a ticketed LIVE_MUSIC candidate and a non-ticketed one, Plot sends the ticketed one, with the normal confident framing', async () => {
    await resetDatabase();
    await seedExperience({ name: 'Stone Food Festival', category: 'RESTAURANT', lat: STONE.lat, lng: STONE.lng, provider: 'openstreetmap', priceMinMinor: null });
    await seedExperience({ name: 'Stone Live Music Night', category: 'LIVE_MUSIC', lat: STONE.lat, lng: STONE.lng, provider: 'ticketmaster', priceMinMinor: 2000 });

    const crewId = await createStaffordCrew('ticketed-owner1@plot-test.invalid', 'ticketed-mate1@plot-test.invalid', ['RESTAURANT', 'LIVE_MUSIC']);

    const delivered = await prisma.crewRecommendation.findFirst({ where: { crewId }, include: { experience: true } });
    expect(delivered).not.toBeNull();
    expect(delivered!.experience!.name).toBe('Stone Live Music Night');
    expect(delivered!.reasonText).not.toContain("There's not much in your area right now");

    const messages = await prisma.crewMessage.findMany({ where: { crewId }, orderBy: { createdAt: 'asc' } });
    const announcement = messages.find((m) => m.body.includes(' — /plans/'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('Plot found something your Crew might like');
    expect(announcement!.body).toContain('Stone Live Music Night');
  });
});

describe('no ticketed event available: Plot still sends its best match, honestly prefaced', () => {
  test('only a non-ticketed (place-provider) candidate exists — Plot sends it, prefaced "There\'s not much in your area right now, so how about this"', async () => {
    await resetDatabase();
    await seedExperience({ name: 'Stone Food Festival', category: 'RESTAURANT', lat: STONE.lat, lng: STONE.lng, provider: 'openstreetmap', priceMinMinor: null });

    const crewId = await createStaffordCrew('ticketed-owner2@plot-test.invalid', 'ticketed-mate2@plot-test.invalid', ['RESTAURANT']);

    const delivered = await prisma.crewRecommendation.findFirst({ where: { crewId }, include: { experience: true } });
    expect(delivered).not.toBeNull();
    expect(delivered!.experience!.name).toBe('Stone Food Festival');
    expect(delivered!.reasonText).toContain("There's not much in your area right now, so how about this");

    const messages = await prisma.crewMessage.findMany({ where: { crewId }, orderBy: { createdAt: 'asc' } });
    const announcement = messages.find((m) => m.body.includes(' — /plans/'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toMatch(/^There's not much in your area right now, so how about this: "Stone Food Festival"/);
    expect(announcement!.body).not.toContain('Plot found something your Crew might like');
  });
});
