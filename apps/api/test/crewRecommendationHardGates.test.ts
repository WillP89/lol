import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';
import { generateRecommendationForCrew } from '../src/services/crewRecommendations';

/**
 * THE regression test for the live-reported failure this whole rebuild traces back to: "Crew:
 * STAFFORD, 25-MILE RADIUS, SPECIFIC CREW PREFERENCES — Plot sent CAFFÈ NERO IN LONDON." Two
 * independent, deliberately isolated failures, proven separately (product spec's own Part 27):
 *
 *  1. LOCATION must be an absolute, hard eligibility gate — a candidate outside the Crew's own
 *     radius, from its own explicit location, can never be recommended, whatever else about it
 *     scores well. Proven with a real distance-precision case too (Stafford -> Birmingham centre
 *     is genuinely ~24 miles — just inside a 25-mile radius), not just an obviously-far one.
 *  2. PLAN-WORTHINESS must independently gate a generic chain venue out of the Crew engine even
 *     when it IS in radius — "a coffee chain exists nearby" is never a reason a friend group
 *     plans a night out.
 *
 * Uses direct Prisma seeding (not a live provider adapter — this sandbox's egress is blocked)
 * with `tags.provider` set exactly as each real adapter would, so services/opportunityIntent.ts
 * classifies these fixtures exactly as it would classify the real thing.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
// A real Stafford lat/lng, but an INVENTED city label with zero mock-provider coverage — same
// isolation precedent as crewSportCrossSuggestion.test.ts's Truro and crewLocationScoping.
// test.ts's "Farflung Test City": `ensureInventory` syncs mock provider fixtures keyed by this
// city STRING, not by lat/lng, so a real "Stafford" label would otherwise flood the candidate
// pool with mock Staffordshire restaurants/festivals that outscore (and crowd the top-3 "Find us
// something" window ahead of) this file's own deliberately-planted fixtures. Distance is computed
// from the real lat/lng below regardless of the label.
const STAFFORD = { city: 'Stafford Hard-Gate Test City', lat: 52.8062, lng: -2.1169 };
const LONDON = { lat: 51.5072, lng: -0.1276 };
const BIRMINGHAM_CENTRE = { lat: 52.4862, lng: -1.8904 }; // ~24 real miles from Stafford — deliberately just inside a 25-mile radius
const STONE = { lat: 52.9046, lng: -2.1548 }; // ~7 real miles from Stafford — unambiguously in-radius
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

/** Seeds an Experience exactly as a real adapter's `mapToCanonical` would leave it — never via
 * the manual-curation endpoint (which always writes `tags: {}`), so `deriveSourceKind` classifies
 * it correctly. */
async function seedPlaceProviderExperience(opts: {
  name: string;
  city: string;
  lat: number;
  lng: number;
  category?: string;
  provider?: string;
  daysAhead?: number;
}) {
  const venue = await prisma.venue.create({ data: { name: opts.name, city: opts.city, latitude: opts.lat, longitude: opts.lng } });
  return prisma.experience.create({
    data: {
      canonicalKey: `test-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${venue.id}`,
      name: opts.name,
      description: `${opts.name} — a real test fixture with enough description to pass quality scoring, in ${opts.city}.`,
      category: (opts.category ?? 'RESTAURANT') as never,
      subcategories: [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + (opts.daysAhead ?? 5) * 24 * 60 * 60 * 1000),
      qualityScore: 80,
      bookingStatus: 'AVAILABLE',
      priceMinMinor: null,
      priceMaxMinor: null,
      tags: { provider: opts.provider ?? 'openstreetmap' },
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
    payload: { name: 'Stafford Test Crew', defaultCity: STAFFORD.city, latitude: STAFFORD.lat, longitude: STAFFORD.lng },
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

interface FindResult {
  options: { experience: { id: string; name: string }; distanceMiles: number | null; withinRadius: boolean | null }[];
}

describe('Part 27 acceptance test: a Stafford Crew, 25-mile radius, never gets Caffè Nero in London', () => {
  test('an OpenStreetMap-sourced Caffè Nero in London never appears in "Find us something" results — rejected on sight, whatever the exact reason', async () => {
    await resetDatabase();
    await seedPlaceProviderExperience({ name: 'Caffè Nero', city: 'London', lat: LONDON.lat, lng: LONDON.lng, provider: 'openstreetmap' });

    const crewId = await createStaffordCrew('gate-owner1@plot-test.invalid', 'gate-mate1@plot-test.invalid', ['RESTAURANT']);
    const owner = await loginByEmail('gate-owner1@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as FindResult;
    expect(options.find((o) => o.experience.name === 'Caffè Nero')).toBeUndefined();
  });

  test('the LOCATION gate specifically, isolated from plan-worthiness: a genuinely plan-worthy candidate (a real festival, HIGH plan-worthiness on its own merits) is still rejected purely for being in London, and the debugger names the exact reason', async () => {
    await resetDatabase();
    await seedPlaceProviderExperience({ name: 'London Street Food Festival', city: 'London', lat: LONDON.lat, lng: LONDON.lng, provider: 'openstreetmap' });

    const crewId = await createStaffordCrew('gate-loc-owner@plot-test.invalid', 'gate-loc-mate@plot-test.invalid', ['RESTAURANT']);
    const owner = await loginByEmail('gate-loc-owner@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    const { options } = res.json() as FindResult;
    // Never in the actual results — the manual flow's soft ranking still surfaces it for browsing
    // in principle (see match.ts's own withinRadius comment), but the automatic engine's hard
    // gate is what this half of the test proves, via the debugger below.
    expect(options.find((o) => o.experience.name === 'London Street Food Festival')?.withinRadius).toBe(false);

    // The debugger (product spec Part 30) names the exact rejection reason — this candidate
    // clears plan-worthiness on its own real merits (a real festival), so its ONLY rejection
    // reason is the location gate, proving that gate independently of plan-worthiness.
    const lookupRes = await app.inject({ method: 'GET', url: `/admin/users/lookup?email=gate-loc-owner@plot-test.invalid`, headers: { 'x-admin-key': ADMIN_KEY } });
    expect(lookupRes.statusCode).toBe(200);
    interface DebugCandidate { title: string; distanceMiles: number | null; rejectionReasons: string[]; eligible: boolean; planWorthiness: string }
    const { crews } = lookupRes.json() as { crews: { crewId: string; rightNow: { topCandidates?: DebugCandidate[] } }[] };
    const crewDebug = crews.find((c) => c.crewId === crewId)!;
    const debug = crewDebug.rightNow.topCandidates?.find((c) => c.title === 'London Street Food Festival');
    expect(debug).toBeDefined();
    expect(debug!.eligible).toBe(false);
    expect(debug!.rejectionReasons).toContain('OUTSIDE_CREW_RADIUS');
    expect(debug!.distanceMiles).toBeGreaterThan(100); // genuinely ~120+ real miles, never rounded away
    expect(debug!.planWorthiness).not.toBe('LOW'); // clears plan-worthiness on its own real merits — proves this rejection is location, not genericness
    expect(debug!.planWorthiness).not.toBe('VERY_LOW');
  });

  test('the automatic engine (generateRecommendationForCrew) also never sends Caffè Nero — never just the manual flow', async () => {
    await resetDatabase();
    await seedPlaceProviderExperience({ name: 'Caffè Nero', city: 'London', lat: LONDON.lat, lng: LONDON.lng, provider: 'openstreetmap' });
    // A second, genuinely plan-worthy AND in-radius candidate must exist too, so this proves
    // Caffè Nero specifically was rejected — not that the whole pipeline came up empty.
    await seedPlaceProviderExperience({ name: 'Stone Street Food Market', city: 'Stone', lat: STONE.lat, lng: STONE.lng, provider: 'openstreetmap' });

    // createStaffordCrew's own member-join already fires the real 1->2-member guaranteeFirst
    // trigger (routes/crews.ts) — the exact automatic path a real Crew's first moment runs
    // through, no second manual call needed (a second call here would just find the same
    // candidate ALREADY_RECOMMENDED and correctly decline, which would prove nothing new).
    const crewId = await createStaffordCrew('gate-owner2@plot-test.invalid', 'gate-mate2@plot-test.invalid', ['RESTAURANT']);
    const delivered = await prisma.crewRecommendation.findFirst({ where: { crewId }, include: { experience: true } });
    expect(delivered).not.toBeNull();
    expect(delivered!.experience!.name).not.toBe('Caffè Nero');
    expect(delivered!.experience!.name).toBe('Stone Street Food Market');
  });

  test('real distance precision: Birmingham centre (~24 real miles from Stafford) is correctly evaluated as inside a 25-mile radius', async () => {
    await resetDatabase();
    await seedPlaceProviderExperience({ name: 'Birmingham Street Food Market', city: 'Birmingham', lat: BIRMINGHAM_CENTRE.lat, lng: BIRMINGHAM_CENTRE.lng, provider: 'openstreetmap' });

    const crewId = await createStaffordCrew('gate-owner3@plot-test.invalid', 'gate-mate3@plot-test.invalid', ['RESTAURANT']);
    const owner = await loginByEmail('gate-owner3@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    const { options } = res.json() as FindResult;
    const match = options.find((o) => o.experience.name === 'Birmingham Street Food Market');
    expect(match).toBeDefined();
    expect(match!.withinRadius).toBe(true);
    // Real, computed haversine distance — not a fixed/rounded stand-in — genuinely close to 24 miles.
    expect(match!.distanceMiles).toBeGreaterThan(20);
    expect(match!.distanceMiles).toBeLessThan(28);
  });

  test('a genuinely nearby Staffordshire venue (Stone, ~7 miles) is eligible', async () => {
    await resetDatabase();
    await seedPlaceProviderExperience({ name: 'Stone Wine Tasting', city: 'Stone', lat: STONE.lat, lng: STONE.lng, provider: 'openstreetmap' });

    const crewId = await createStaffordCrew('gate-owner4@plot-test.invalid', 'gate-mate4@plot-test.invalid', ['RESTAURANT']);
    const owner = await loginByEmail('gate-owner4@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    const { options } = res.json() as FindResult;
    const match = options.find((o) => o.experience.name === 'Stone Wine Tasting');
    expect(match).toBeDefined();
    expect(match!.withinRadius).toBe(true);
    expect(match!.distanceMiles).toBeLessThan(12);
  });
});

describe('Part 27 second test: plan-worthiness independently gates a generic chain venue, even fully in-radius', () => {
  test('a Caffè Nero genuinely inside the Crew\'s own radius is STILL excluded from the primary Crew recommendation engine, while a real specialness-flagged candidate the same distance away is not', async () => {
    await resetDatabase();
    // Both seeded in Stone — a few miles from the Crew's Stafford location, well inside 25 miles.
    // Isolates plan-worthiness from location: if Caffè Nero is missing here, it's not because it
    // was out of radius (it wasn't) — it's because it's a generic chain.
    await seedPlaceProviderExperience({ name: 'Caffè Nero', city: 'Stone', lat: STONE.lat, lng: STONE.lng, provider: 'openstreetmap' });
    await seedPlaceProviderExperience({ name: 'Stone Food Festival', city: 'Stone', lat: STONE.lat, lng: STONE.lng, provider: 'openstreetmap' });

    const crewId = await createStaffordCrew('worth-owner1@plot-test.invalid', 'worth-mate1@plot-test.invalid', ['RESTAURANT']);
    const owner = await loginByEmail('worth-owner1@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    const { options } = res.json() as FindResult;
    expect(options.find((o) => o.experience.name === 'Caffè Nero')).toBeUndefined();
    expect(options.find((o) => o.experience.name === 'Stone Food Festival')).toBeDefined();
  });
});

describe('a Crew with genuinely no location signal at all never gets an automatic recommendation', () => {
  test('generateRecommendationForCrew declines — never falls back to scoring with an unknown location', async () => {
    await resetDatabase();
    await seedPlaceProviderExperience({ name: 'Some Real Festival', city: 'Stone', lat: STONE.lat, lng: STONE.lng, provider: 'openstreetmap', category: 'FESTIVAL' });

    // Deliberately: no Crew.latitude/longitude, and neither member ever sets a home location.
    const owner = await loginByEmail('nolocation-owner@plot-test.invalid');
    const mate = await loginByEmail('nolocation-mate@plot-test.invalid');
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'No Location Crew' } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['FESTIVAL'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const recommendation = await generateRecommendationForCrew(crew.id, { guaranteeFirst: true });
    expect(recommendation).toBeNull();
  });
});
