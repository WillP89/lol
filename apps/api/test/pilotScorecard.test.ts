import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * GET /admin/pilot-scorecard — proves the operator report's every section is computed from real
 * rows (never a fabricated number) and that `?days=` genuinely bounds the window, not just
 * defaults to one. Seeds fixtures directly via prisma (same pattern as
 * recommendationResponseAck.test.ts) rather than driving the full sweep/vote/lock UI flow for
 * every branch — the report itself is a pure read over these tables, so the fixtures only need to
 * match their real shape, not be produced by the live pipeline.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';

async function makeUser(email: string, status: 'ACTIVE' | 'DEACTIVATED' = 'ACTIVE') {
  return prisma.user.create({ data: { email, displayName: email.split('@')[0], status, emailVerifiedAt: new Date() } });
}

async function makeCrew(ownerId: string, name: string, createdAt: Date) {
  return prisma.crew.create({ data: { name, createdById: ownerId, createdAt } });
}

async function makeExperience(name: string, category: 'COMEDY' | 'RESTAURANT') {
  const venue = await prisma.venue.create({ data: { name: `${name} Venue`, city: 'Stafford', latitude: 52.8, longitude: -2.1 } });
  return prisma.experience.create({
    data: {
      canonicalKey: `test-scorecard-${venue.id}`,
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category,
      subcategories: [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      qualityScore: 80,
      bookingStatus: 'AVAILABLE',
      priceMinMinor: 2000,
      priceMaxMinor: 3000,
      tags: {},
    },
  });
}

async function fetchScorecard(query = '') {
  return app.inject({ method: 'GET', url: `/admin/pilot-scorecard${query}`, headers: { 'x-admin-key': ADMIN_KEY } });
}

describe('GET /admin/pilot-scorecard', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('requires the admin key, same as every other admin route', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/pilot-scorecard' });
    expect(res.statusCode).toBe(401);
  });

  test('rejects an out-of-range days value rather than silently clamping it', async () => {
    const res = await fetchScorecard('?days=9999');
    expect(res.statusCode).toBe(400);
  });

  test('reports a coherent scorecard across every section from real seeded rows', async () => {
    const owner = await makeUser('scorecard-owner@plot-test.invalid');
    const mate = await makeUser('scorecard-mate@plot-test.invalid');
    await makeUser('scorecard-deactivated@plot-test.invalid', 'DEACTIVATED'); // never counted — status filter is ACTIVE only

    const now = new Date();
    const crew = await makeCrew(owner.id, 'Scorecard Crew', now);

    // --- First value: EXPLICIT, set 30 minutes after Crew creation ---
    await prisma.crewRecommendationSettings.create({
      data: {
        crewId: crew.id,
        enabled: true,
        preferencesSetAt: new Date(now.getTime() + 30 * 60_000),
        preferencesSource: 'EXPLICIT',
      },
    });
    await prisma.intentSignal.create({
      data: { name: 'CrewPreferencesSet', crewId: crew.id, payload: { source: 'EXPLICIT' } },
    });

    // --- Recommendation funnel: one delivered, one no_eligible_candidate ---
    await prisma.intentSignal.create({ data: { name: 'CrewRecommendationEvaluated', crewId: crew.id, payload: { outcome: 'delivered' } } });
    await prisma.intentSignal.create({ data: { name: 'CrewRecommendationEvaluated', crewId: crew.id, payload: { outcome: 'no_eligible_candidate' } } });

    // --- A delivered recommendation, locked into a Plan, with a real provider listing ---
    const experience = await makeExperience('Scorecard Comedy Night', 'COMEDY');
    const provider = await prisma.provider.create({ data: { id: 'scorecard_test_provider', name: 'Scorecard Test Provider', categories: ['COMEDY'] } });
    await prisma.providerListing.create({
      data: { providerId: provider.id, providerListingId: 'scorecard-listing-1', experienceId: experience.id, externalUrl: 'https://example.invalid/scorecard-1', rawPayload: {} },
    });
    const plan = await prisma.plan.create({
      data: { crewId: crew.id, experienceId: experience.id, title: 'Scorecard Comedy Night', status: 'LOCKED', proposedByUserId: owner.id },
    });
    const recommendation = await prisma.crewRecommendation.create({
      data: { crewId: crew.id, experienceId: experience.id, planId: plan.id, score: 70, reasonText: 'fixture', status: 'SENT' },
    });

    // --- Votes on that Plan ---
    await prisma.planVote.create({ data: { planId: plan.id, userId: owner.id, vote: 'IN' } });
    await prisma.planVote.create({ data: { planId: plan.id, userId: mate.id, vote: 'MAYBE' } });

    // --- A pass response with a structured reason, on a second, unlocked recommendation ---
    const experience2 = await makeExperience('Scorecard Restaurant', 'RESTAURANT');
    const plan2 = await prisma.plan.create({
      data: { crewId: crew.id, experienceId: experience2.id, title: 'Scorecard Restaurant', status: 'IDEA', proposedByUserId: owner.id },
    });
    const recommendation2 = await prisma.crewRecommendation.create({
      data: { crewId: crew.id, experienceId: experience2.id, planId: plan2.id, score: 40, reasonText: 'fixture', status: 'NOT_FOR_US' },
    });
    await prisma.recommendationResponse.create({
      data: { crewRecommendationId: recommendation2.id, userId: mate.id, action: 'NOT_FOR_US', reasonCode: 'too_far' },
    });

    const res = await fetchScorecard();
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;

    expect(body.users.total).toBe(2); // pending user excluded
    expect(body.crews.total).toBe(1);

    expect(body.firstValue.crewsCreatedInWindow).toBe(1);
    expect(body.firstValue.crewsReachingFirstValue).toBe(1);
    expect(body.firstValue.rate).toBe(1);
    expect(body.firstValue.medianMinutesToFirstValue).toBeCloseTo(30, 0);
    expect(body.firstValue.bySource).toEqual({ EXPLICIT: 1, DERIVED: 0 });
    expect(body.firstValue.preferencesSetEventCount).toBe(1);

    expect(body.recommendationFunnel.totalEvaluated).toBe(2);
    expect(body.recommendationFunnel.byOutcome).toEqual({ delivered: 1, no_eligible_candidate: 1 });
    expect(body.recommendationFunnel.deliveredRate).toBe(0.5);
    expect(body.recommendationFunnel.insufficientInventoryRate).toBe(0.5);

    expect(body.responseRates.totalVotes).toBe(2);
    expect(body.responseRates.in).toBe(1);
    expect(body.responseRates.maybe).toBe(1);
    expect(body.responseRates.pass).toBe(0);

    expect(body.topPassReasons).toEqual([{ reasonCode: 'too_far', count: 1 }]);

    // Two CrewRecommendations created this window, both attached to a Plan.
    expect(body.recToPlanRate).toBe(1);
    expect(body.lockRate.recommendationPlans).toBe(2);
    expect(body.lockRate.locked).toBe(1);
    expect(body.lockRate.rate).toBe(0.5);

    const comedyRow = body.categoryPerformance.find((r: any) => r.category === 'COMEDY');
    expect(comedyRow).toEqual({ category: 'COMEDY', delivered: 1, locked: 1, lockRate: 1 });
    const restaurantRow = body.categoryPerformance.find((r: any) => r.category === 'RESTAURANT');
    expect(restaurantRow).toEqual({ category: 'RESTAURANT', delivered: 1, locked: 0, lockRate: 0 });

    const providerRow = body.providerPerformance.find((r: any) => r.providerId === provider.id);
    expect(providerRow).toEqual({ providerId: provider.id, delivered: 1, locked: 1, lockRate: 1 });
    // experience2 has no ProviderListing row at all — falls back to the honest 'manual_or_unknown' bucket.
    const fallbackRow = body.providerPerformance.find((r: any) => r.providerId === 'manual_or_unknown');
    expect(fallbackRow).toEqual({ providerId: 'manual_or_unknown', delivered: 1, locked: 0, lockRate: 0 });

    expect(body.deadCrews).toEqual([]); // this Crew delivered at least once — not stuck
    void recommendation;
  });

  test('a Crew that is enabled, has taste set, and was evaluated but never delivered shows up as a dead crew with its most common blocking outcome', async () => {
    const owner = await makeUser('deadcrew-owner@plot-test.invalid');
    const crew = await makeCrew(owner.id, 'Stuck Crew', new Date());
    await prisma.crewRecommendationSettings.create({
      data: { crewId: crew.id, enabled: true, preferencesSetAt: new Date(), preferencesSource: 'EXPLICIT' },
    });
    await prisma.intentSignal.create({ data: { name: 'CrewRecommendationEvaluated', crewId: crew.id, payload: { outcome: 'no_eligible_candidate' } } });
    await prisma.intentSignal.create({ data: { name: 'CrewRecommendationEvaluated', crewId: crew.id, payload: { outcome: 'no_eligible_candidate' } } });
    await prisma.intentSignal.create({ data: { name: 'CrewRecommendationEvaluated', crewId: crew.id, payload: { outcome: 'too_soon' } } });

    const res = await fetchScorecard();
    const body = res.json() as any;
    expect(body.deadCrews).toEqual([{ crewId: crew.id, name: 'Stuck Crew', evaluations: 3, mostCommonOutcome: 'no_eligible_candidate' }]);
  });

  test('a Crew with recommendations disabled, or with no taste set yet, is never reported as a dead crew', async () => {
    const owner = await makeUser('notdead-owner@plot-test.invalid');
    const disabledCrew = await makeCrew(owner.id, 'Disabled Crew', new Date());
    await prisma.crewRecommendationSettings.create({ data: { crewId: disabledCrew.id, enabled: false, preferencesSetAt: new Date(), preferencesSource: 'EXPLICIT' } });
    await prisma.intentSignal.create({ data: { name: 'CrewRecommendationEvaluated', crewId: disabledCrew.id, payload: { outcome: 'no_eligible_candidate' } } });

    const noPrefsCrew = await makeCrew(owner.id, 'No Prefs Crew', new Date());
    await prisma.crewRecommendationSettings.create({ data: { crewId: noPrefsCrew.id, enabled: true, preferencesSetAt: null } });
    await prisma.intentSignal.create({ data: { name: 'CrewRecommendationEvaluated', crewId: noPrefsCrew.id, payload: { outcome: 'preferences_not_set' } } });

    const res = await fetchScorecard();
    const body = res.json() as any;
    expect(body.deadCrews).toEqual([]);
  });

  test('?days= genuinely bounds the window — activity from before it is excluded from every rate', async () => {
    const owner = await makeUser('window-owner@plot-test.invalid');
    const oldCrew = await makeCrew(owner.id, 'Old Crew', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000));
    await prisma.crewRecommendationSettings.create({
      data: { crewId: oldCrew.id, enabled: true, preferencesSetAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000 + 60_000), preferencesSource: 'EXPLICIT' },
    });
    // An old evaluated event, well outside any reasonable window.
    await prisma.intentSignal.create({
      data: { name: 'CrewRecommendationEvaluated', crewId: oldCrew.id, payload: { outcome: 'delivered' }, occurredAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    });

    const withinDefaultWindow = await fetchScorecard(); // default days=30
    const body30 = withinDefaultWindow.json() as any;
    expect(body30.firstValue.crewsCreatedInWindow).toBe(0); // Crew itself created 60 days ago
    expect(body30.recommendationFunnel.totalEvaluated).toBe(0); // event 60 days ago, outside the 30-day window

    const wideWindow = await fetchScorecard('?days=90');
    const body90 = wideWindow.json() as any;
    expect(body90.firstValue.crewsCreatedInWindow).toBe(1);
    expect(body90.recommendationFunnel.totalEvaluated).toBe(1);
    expect(body90.recommendationFunnel.byOutcome).toEqual({ delivered: 1 });
  });

  test('an empty window reports honest nulls for every rate, never NaN or a fabricated zero-denominator division', async () => {
    const res = await fetchScorecard('?days=1');
    const body = res.json() as any;
    expect(body.users.total).toBe(0);
    expect(body.firstValue.rate).toBeNull();
    expect(body.firstValue.medianMinutesToFirstValue).toBeNull();
    expect(body.recommendationFunnel.deliveredRate).toBeNull();
    expect(body.recommendationFunnel.insufficientInventoryRate).toBeNull();
    expect(body.responseRates.inRate).toBeNull();
    expect(body.recToPlanRate).toBeNull();
    expect(body.lockRate.rate).toBeNull();
    expect(body.topPassReasons).toEqual([]);
    expect(body.deadCrews).toEqual([]);
  });
});
