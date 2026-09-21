import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * `CrewRecommendationEvaluated` (packages/shared/src/analytics.ts) closes a real gap: every
 * non-delivered sweep outcome (too_soon, no_eligible_candidate, preferences_not_set, ...) used to
 * be logged only via pino, never persisted as an IntentSignal row — making "insufficient-inventory
 * rate" and "suppression rate by reason" (both explicitly requested for the pilot scorecard)
 * uncomputable from the database alone. This proves the event actually lands, with the right
 * `outcome`, for a representative spread of the real RecommendationOutcome union — not just that
 * the pino log line still fires (that was never in doubt).
 *
 * Reads "did this outcome ever fire for this Crew", not "was it the LATEST one" — a Crew's very
 * first sweep can legitimately trigger more than one internal evaluation in quick succession (the
 * self-healing preference-derivation path and the 1->2-member join trigger can both land within
 * milliseconds — see generateRecommendationForCrew's own inFlightGenerations comment), so a
 * strict last-event check is a real source of test flakiness, not a stronger assertion.
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

async function setUpMemberWithTaste(email: string, categories: string[]): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
  });
  await app.inject({
    method: 'POST',
    url: '/users/me/taste',
    headers: { cookie: member.cookie },
    payload: {
      swipes: categories.map((category) => ({ category, choice: 'yes' as const })),
      budget: { minMinor: 1000, maxMinor: 8000, currency: 'GBP' },
      travelRadiusMeters: 24000,
      energyPreference: 'MEDIUM',
    },
  });
  return member;
}

/** Deliberately no `/users/me/taste` call — no personal TasteProfile at all, so
 *  tryDeriveAndApplyCrewPreferences (crewTasteDerivation.ts) has zero affinity to derive from and
 *  the Crew's own `preferences_not_set` gate stays genuinely open, not silently self-healed. */
async function setUpMemberWithNoTaste(email: string): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
  });
  return member;
}

async function createCrew(ownerCookie: string, name: string, city: string = STAFFORD.city): Promise<{ id: string; inviteCode: string }> {
  const res = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: ownerCookie }, payload: { name, defaultCity: city } });
  return (res.json() as { crew: { id: string; inviteCode: string } }).crew;
}

async function joinCrew(inviteCode: string, cookie: string) {
  const res = await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie }, payload: { inviteCode } });
  expect(res.statusCode).toBe(200);
}

async function setExplicitTaste(crewId: string, cookie: string, categoryPreferences: string[], interestPreferences: string[] = []) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/crews/${crewId}/recommendation-settings`,
    headers: { cookie },
    payload: { categoryPreferences, interestPreferences },
  });
  expect(res.statusCode).toBe(200);
}

async function seedExperience(name: string, category: string, interestTag: string) {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category,
      subcategories: [interestTag],
      venueName: `${name} Venue`,
      city: STAFFORD.city,
      latitude: STAFFORD.lat,
      longitude: STAFFORD.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  // P0-URGENT: proactive Plot Found This now hard-requires a real ticket — see
  // crewRecommendations.ts's own isProactivelyEligible comment. This file is about analytics
  // event recording, not the ticket gate itself.
  const experienceId = (res.json() as { experience: { id: string } }).experience.id;
  await prisma.experience.update({ where: { id: experienceId }, data: { tags: { provider: 'skiddle' } } });
}

async function sweep(crewId: string) {
  return app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId } });
}

/** Every `CrewRecommendationEvaluated` IntentSignal row ever written for this Crew — the durable
 *  record this suite exists to prove actually gets written, not just logged to pino. */
async function evaluatedOutcomesFor(crewId: string): Promise<string[]> {
  const rows = await prisma.intentSignal.findMany({ where: { name: 'CrewRecommendationEvaluated', crewId } });
  return rows.map((r) => (r.payload as { outcome: string }).outcome);
}

describe('CrewRecommendationEvaluated analytics event', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('preferences_not_set: sweeping a solo Crew with no taste signal at all records the outcome', async () => {
    const owner = await setUpMemberWithNoTaste('analytics-prefs-owner@plot-test.invalid');
    const crew = await createCrew(owner.cookie, 'No Prefs Crew');

    const res = await sweep(crew.id);
    expect(res.statusCode).toBe(200);

    const outcomes = await evaluatedOutcomesFor(crew.id);
    expect(outcomes).toContain('preferences_not_set');
  });

  test('no_eligible_candidate: real explicit preferences, but a city with no synced inventory', async () => {
    // A city name unique to this test, never seeded by ensureInventory's own mock catalog — the
    // same technique test/adminExplainRecommendation.test.ts uses for the identical, real,
    // honest "nothing eligible right now" outcome.
    const city = 'Analytics Empty City';
    const owner = await loginByEmail('analytics-empty-owner@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: owner.cookie },
      payload: { displayName: 'analytics-empty-owner', homeCity: city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    const mate = await loginByEmail('analytics-empty-mate@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: mate.cookie },
      payload: { displayName: 'analytics-empty-mate', homeCity: city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    const crew = await createCrew(owner.cookie, 'Empty City Crew', city);
    await setExplicitTaste(crew.id, owner.cookie, ['RESTAURANT'], []);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await sweep(crew.id);

    const outcomes = await evaluatedOutcomesFor(crew.id);
    expect(outcomes).toContain('no_eligible_candidate');
  });

  test('delivered: a real match records the delivered outcome with crewId context', async () => {
    await seedExperience('Analytics Comedy Night', 'COMEDY', 'comedy');
    const owner = await setUpMemberWithTaste('analytics-delivered-owner@plot-test.invalid', ['comedy']);
    const mate = await setUpMemberWithTaste('analytics-delivered-mate@plot-test.invalid', ['comedy']);
    const crew = await createCrew(owner.cookie, 'Delivered Crew');
    await setExplicitTaste(crew.id, owner.cookie, ['COMEDY'], ['comedy']);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const rows = await prisma.intentSignal.findMany({ where: { name: 'CrewRecommendationEvaluated', crewId: crew.id } });
    const outcomes = rows.map((r) => (r.payload as { outcome: string }).outcome);
    expect(outcomes).toContain('delivered');
    expect(rows.every((r) => r.crewId === crew.id)).toBe(true);
  });

  test('too_soon: sweeping again immediately after a delivery records the cadence outcome', async () => {
    await seedExperience('Analytics Comedy Night 2', 'COMEDY', 'comedy');
    const owner = await setUpMemberWithTaste('analytics-toosoon-owner@plot-test.invalid', ['comedy']);
    const mate = await setUpMemberWithTaste('analytics-toosoon-mate@plot-test.invalid', ['comedy']);
    const crew = await createCrew(owner.cookie, 'Too Soon Crew');
    await setExplicitTaste(crew.id, owner.cookie, ['COMEDY'], ['comedy']);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // First delivery already happened via the join trigger above; a second, explicit sweep right
    // after must hit the cadence floor, not deliver again.
    await sweep(crew.id);

    const outcomes = await evaluatedOutcomesFor(crew.id);
    expect(outcomes).toContain('delivered');
    expect(outcomes).toContain('too_soon');
  });
});

describe('CrewPreferencesSet analytics event', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function preferencesSetEventsFor(crewId: string) {
    const rows = await prisma.intentSignal.findMany({ where: { name: 'CrewPreferencesSet', crewId } });
    return rows.map((r) => r.payload as { source: string; categoryPreferences: string[]; interestPreferences: string[] });
  }

  test('EXPLICIT: a human setting real Crew preferences for the first time records the source', async () => {
    const owner = await setUpMemberWithTaste('analytics-explicit-owner@plot-test.invalid', ['comedy']);
    const crew = await createCrew(owner.cookie, 'Explicit Prefs Crew');

    await setExplicitTaste(crew.id, owner.cookie, ['COMEDY'], ['comedy']);

    const events = await preferencesSetEventsFor(crew.id);
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('EXPLICIT');
    expect(events[0].categoryPreferences).toEqual(['COMEDY']);

    // Re-tuning an already-EXPLICIT Crew must never re-fire the first-value event again.
    await setExplicitTaste(crew.id, owner.cookie, ['SPORT'], []);
    expect(await preferencesSetEventsFor(crew.id)).toHaveLength(1);
  });

  test('DERIVED: a solo Crew safely deriving taste from its own creator records the source, never EXPLICIT', async () => {
    const owner = await loginByEmail('analytics-derived-owner@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: owner.cookie },
      payload: { displayName: 'analytics-derived-owner', homeCity: 'Analytics Derivation City', homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie: owner.cookie },
      payload: { updates: [{ interestId: 'rock', strength: 'love' }, { interestId: 'live_gigs', strength: 'love' }] },
    });
    const crew = await createCrew(owner.cookie, 'Derived Prefs Crew', 'Analytics Derivation City');

    await sweep(crew.id); // too_few_members, but derivation runs before that gate

    const events = await preferencesSetEventsFor(crew.id);
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('DERIVED');
    expect(new Set(events[0].interestPreferences)).toEqual(new Set(['rock', 'live_gigs']));
  });
});
