import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

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

async function seedExperience(name: string, category: string) {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      // Deliberately generic — no literal "street food"/"food festival"/"wine bar" wording
      // anywhere, matching the real-world shape (a normal restaurant listing, not one that
      // happens to use Plot's own taxonomy vocabulary).
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category,
      venueName: 'Implied Interest Scoring Test Venue',
      city: TEST_CITY.city,
      latitude: TEST_CITY.lat,
      longitude: TEST_CITY.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience;
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

    await seedExperience('The Wellington', 'RESTAURANT');

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

    await seedExperience('Ringside Fight Night', 'SPORT');

    const sweepRes = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId: crew.id } });
    expect((sweepRes.json() as { delivered: number }).delivered).toBe(1);

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes(' — /plans/'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('Ringside Fight Night');
  });
});
