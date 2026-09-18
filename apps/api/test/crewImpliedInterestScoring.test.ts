import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * Real, live-reported bug — a screenshot of the actual product: a Crew with preferences boxing/
 * MMA/street food/food festivals/wine bars, based near Birmingham (real inventory exists for at
 * least some of these categories there), got the honest "we don't have any... events" message
 * anyway. Root cause: `categoriesImpliedByInterests` (services/match.ts's own hard filter) WAS
 * correctly admitting a candidate into the pool the moment its category was implied by one of
 * the Crew's interest picks (e.g. RESTAURANT implied by `street_food`) — but the SEPARATE scoring
 * section right below it never attached a matching reason. `crew_interest_preference` only ever
 * fired on a LITERAL tag match (`matchedCrewInterest`); every other taste-signal reason
 * (`crew_preference`, `category_affinity`, `interest_match`) requires something else entirely
 * (a whole-category pick, or an individual member's own unrelated personal taste). So a candidate
 * that passed the hard filter ONLY via the implied-category widening scored zero taste-signal
 * reasons at all — `hasTasteSignal` (crewRecommendations.ts) never counted it as matched.
 *
 * Deliberately tested via the PERIODIC SWEEP (`POST /admin/recommendations/sweep`), not the
 * 1->2-member guaranteeFirst trigger — guaranteeFirst has its own honest last-resort fallback to
 * `inRadius` (any in-radius candidate at all) whenever `withTaste` is empty, which would mask
 * this exact gap the moment there's only one candidate in the whole pool (see
 * evaluateCrewEligibility's own comment on that fallback). The periodic sweep has no such
 * safety net — `withTaste` must be genuinely non-empty and clear the real confidence bar, so it's
 * the one path that actually proves the scoring reason, not just "something, anything, got sent."
 * Nothing is seeded before the Crew forms (guaranteeFirst finds nothing, honestly); the real
 * candidate is seeded afterwards and the sweep triggered manually — same isolation precedent as
 * crewCategoryPreferences.test.ts.
 *
 * P0-FINAL note: both fixtures below now carry one extra, real piece of evidence beyond "implied
 * category alone" — a genuine specialness signal for the restaurant (P0-FINAL-1, "The Hidden
 * Chef": an ordinary restaurant with no occasion signal is no longer plan-worthy on its own,
 * any source — ordinary "The Wellington" would now be excluded before scoring even ran, which
 * would prove nothing about THIS bug), and a real ticket for the sport fixture (P0-FINAL-2,
 * "quality beats proximity": the nearby-distance bonus this test used to lean on to clear the
 * confidence bar was deliberately shrunk so proximity alone can no longer rescue a weak match —
 * exactly the failure mode that constant now exists to prevent). Neither addition uses the
 * literal wording of the Crew's own interest picks ("street food"/"food festival"/"wine bar"/
 * "boxing"/"mma") — the implied-category mechanism this test actually proves is untouched.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
const TEST_CITY = { city: 'Truro', lat: 50.2632, lng: -5.051 }; // zero mock coverage — isolates this test's own proof from Birmingham's real mock restaurant/venue fixtures, which would otherwise independently satisfy guaranteeFirst before this test's own manual sweep call even runs

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

/** Seeded directly via prisma (bypassing /admin/experiences/manual, which always writes
 *  tags: {} — UNKNOWN source) so this fixture can carry a real EVENT_PROVIDER tag — a genuinely
 *  ticketed sport fixture, exactly as ordinary as a real boxing/MMA card actually is, and real
 *  evidence in its own right (P0-FINAL-2's ticketed-event scoring bonus), not literal
 *  "boxing"/"mma" wording. */
async function seedTicketedExperience(name: string, category: string, description?: string) {
  const venue = await prisma.venue.create({ data: { name: `${name} Venue`, city: TEST_CITY.city, latitude: TEST_CITY.lat, longitude: TEST_CITY.lng } });
  return prisma.experience.create({
    data: {
      canonicalKey: `test-implied-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${venue.id}`,
      name,
      description: description ?? `${name} — a real test fixture with enough description to pass quality scoring.`,
      category: category as never,
      subcategories: [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      qualityScore: 80,
      bookingStatus: 'AVAILABLE',
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      tags: { provider: 'skiddle' },
    },
  });
}

describe('a candidate admitted only via an implied Crew interest still gets a real, provable reason — proven on the real periodic sweep, not the guaranteeFirst safety net', () => {
  test('street food / food festivals / wine bars — a plain restaurant with no literal wording clears the real confidence bar', async () => {
    await resetDatabase();

    const owner = await loginByEmail('implied-scoring-owner@plot-test.invalid');
    const mate = await loginByEmail('implied-scoring-mate@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Food Crew', defaultCity: TEST_CITY.city, latitude: TEST_CITY.lat, longitude: TEST_CITY.lng },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { interestPreferences: ['street_food', 'food_festivals', 'wine_bars'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500)); // guaranteeFirst settles — honestly finds nothing yet

    // P0-FINAL-1: a real EVENT_PROVIDER-sourced occasion — an ordinary restaurant listing alone
    // no longer clears plan-worthiness, any source. P0-FINAL-2 ("quality beats proximity"): the
    // nearby-distance bonus this fixture used to lean on alone to clear the confidence bar was
    // deliberately shrunk, so a real ticket is what actually gets it there — still no literal
    // "street food"/"food festival"/"wine bar" wording, so this stays a true test of the
    // implied-category mechanism, not the specialness/ticketed gates.
    await seedTicketedExperience('The Wellington', 'RESTAURANT');

    const sweepRes = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId: crew.id } });
    expect((sweepRes.json() as { delivered: number }).delivered).toBe(1);

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes(' — /plans/'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('The Wellington');
  });

  test('boxing / mma — a plain sport fixture with no literal wording clears the real confidence bar', async () => {
    await resetDatabase();

    const owner = await loginByEmail('implied-scoring-sport-owner@plot-test.invalid');
    const mate = await loginByEmail('implied-scoring-sport-mate@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Fight Crew', defaultCity: TEST_CITY.city, latitude: TEST_CITY.lat, longitude: TEST_CITY.lng },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { interestPreferences: ['boxing', 'mma'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    // P0-FINAL-2 ("quality beats proximity"): the nearby-distance bonus this fixture used to lean
    // on alone to clear the confidence bar was deliberately shrunk (see match.ts's own
    // NEARBY_BONUS_CAP) so mere proximity can no longer rescue a weak-evidence match — a real
    // ticket (a genuinely ordinary thing for a real boxing/MMA card to have) is real evidence in
    // its own right, still no literal "boxing"/"mma" wording.
    await seedTicketedExperience('Ringside Fight Night', 'SPORT');

    const sweepRes = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId: crew.id } });
    expect((sweepRes.json() as { delivered: number }).delivered).toBe(1);

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes(' — /plans/'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('Ringside Fight Night');
  });
});
