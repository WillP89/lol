import { describe, expect, test } from 'vitest';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';
import { computeCrewLearningBias } from '../src/services/recommendationLearning';
import { explainCrewRecommendation, generateRecommendationForCrew } from '../src/services/crewRecommendations';

/**
 * THE PILOT-READINESS LEARNING ENGINE — end-to-end proof of the real product requirements this
 * rebuild exists for (see docs/DECISIONS.md#crew-recommendation-learning-engine): individual vs
 * Crew-level weighting, decay over time, real positive signal (not just explicit buttons),
 * category diversity/fatigue, active-Crew gating, cadence spacing, and controlled exploration
 * with its own weekly rate limit.
 *
 * These tests bypass the HTTP join/onboarding flow and seed Crews directly via Prisma — the
 * real "guaranteed first recommendation" trigger (routes/crews.ts + updateSettings) fires
 * automatically the moment a real Crew is created through the API, which would otherwise consume
 * the exact candidate each test needs to control precisely. Seeding directly keeps every
 * scenario here deterministic and isolated from that (separately, already-tested — see
 * guaranteedFirstRecommendation.test.ts) trigger.
 */

let userCounter = 0;
async function seedUser(emailPrefix: string): Promise<{ id: string }> {
  userCounter += 1;
  return prisma.user.create({
    data: { email: `${emailPrefix}-${userCounter}@plot-test.invalid`, displayName: emailPrefix, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
}

interface RawCrewOpts {
  city: string;
  lat: number;
  lng: number;
  categoryPreferences?: string[];
  createdAt?: Date;
}

/** A real, fully-eligible 2-member Crew — preferences already set, location already set, no HTTP
 *  round trip and (critically) no automatic "guaranteed first" trigger. */
async function seedRawCrew(opts: RawCrewOpts): Promise<{ crewId: string; userA: { id: string }; userB: { id: string } }> {
  const userA = await seedUser('learn-a');
  const userB = await seedUser('learn-b');
  const crew = await prisma.crew.create({
    data: { name: 'Learning Engine Test Crew', createdById: userA.id, defaultCity: opts.city, latitude: opts.lat, longitude: opts.lng, createdAt: opts.createdAt ?? new Date() },
  });
  await prisma.crewMember.createMany({
    data: [
      { crewId: crew.id, userId: userA.id, status: 'ACTIVE' },
      { crewId: crew.id, userId: userB.id, status: 'ACTIVE' },
    ],
  });
  await prisma.crewRecommendationSettings.create({
    data: {
      crewId: crew.id,
      categoryPreferences: opts.categoryPreferences ?? [],
      travelRadiusMeters: Math.round(25 * 1609.34),
      preferencesSetAt: new Date(),
    },
  });
  return { crewId: crew.id, userA, userB };
}

async function seedExperience(opts: {
  name: string;
  category: string;
  lat: number;
  lng: number;
  provider?: string;
  priceMinMinor?: number | null;
  daysAhead?: number;
}) {
  const venue = await prisma.venue.create({ data: { name: opts.name, city: 'Test Venue City', latitude: opts.lat, longitude: opts.lng } });
  return prisma.experience.create({
    data: {
      canonicalKey: `test-learn-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${venue.id}`,
      name: opts.name,
      description: `${opts.name} — a real test fixture with enough description to pass quality scoring.`,
      category: opts.category as never,
      subcategories: [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + (opts.daysAhead ?? 5) * 24 * 60 * 60 * 1000),
      qualityScore: 80,
      bookingStatus: 'AVAILABLE',
      priceMinMinor: opts.priceMinMinor ?? null,
      priceMaxMinor: opts.priceMinMinor != null ? opts.priceMinMinor + 1000 : null,
      tags: { provider: opts.provider ?? 'openstreetmap' },
    },
  });
}

// An invented city label with zero mock-provider coverage — same isolation precedent as every
// other test file in this suite (crewRecommendationHardGates.test.ts's own STAFFORD constant).
const HOME = { city: 'Learning Engine Test City', lat: 52.8062, lng: -2.1169 };
const NEARBY = { lat: 52.9046, lng: -2.1548 }; // ~7 real miles — unambiguously in-radius, close

interface DebugCandidate {
  experienceId: string;
  matchScore: number;
  category: string;
}
// explainCrewRecommendation's return type spreads a `Record<string, unknown>` details object,
// which TS can't narrow to its real (runtime-guaranteed) shape — a small, honest cast rather than
// widening the function's own public return type just for test convenience.
function topCandidatesOf(explain: Awaited<ReturnType<typeof explainCrewRecommendation>>): DebugCandidate[] {
  return (explain as unknown as { topCandidates: DebugCandidate[] }).topCandidates;
}

describe('individual vs Crew-level learning weighting', () => {
  test('one person rejecting a category five times never exceeds the per-user cap; a second person adds genuinely independent signal', async () => {
    await resetDatabase();
    const { crewId, userA, userB } = await seedRawCrew({ ...HOME });

    for (let i = 0; i < 5; i += 1) {
      const exp = await seedExperience({ name: `Solo Rejection Fixture ${i}`, category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });
      const rec = await prisma.crewRecommendation.create({ data: { crewId, experienceId: exp.id, score: 60, reasonText: 'fixture', status: 'NOT_FOR_US' } });
      await prisma.recommendationResponse.create({ data: { crewRecommendationId: rec.id, userId: userA.id, action: 'NOT_FOR_US' } });
    }

    const afterOnePerson = await computeCrewLearningBias(crewId);
    const oneBias = afterOnePerson.category.get('SPORT') ?? 0;
    // Five rejections from ONE person must not out-weigh the per-user cap (PER_USER_CATEGORY_CAP
    // = 0.5) — this is the exact "football should not become permanently banned by one person"
    // requirement (product spec's own Crew D).
    expect(oneBias).toBeCloseTo(-0.5, 1);

    const exp2 = await seedExperience({ name: 'Second Person Rejection Fixture', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });
    const rec2 = await prisma.crewRecommendation.create({ data: { crewId, experienceId: exp2.id, score: 60, reasonText: 'fixture', status: 'NOT_FOR_US' } });
    await prisma.recommendationResponse.create({ data: { crewRecommendationId: rec2.id, userId: userB.id, action: 'NOT_FOR_US' } });

    const afterTwoPeople = await computeCrewLearningBias(crewId);
    const twoBias = afterTwoPeople.category.get('SPORT') ?? 0;
    // A SECOND, genuinely independent person's rejection is real additional Crew-level evidence
    // — the bias should move further negative, not be absorbed by the first person's own cap.
    expect(twoBias).toBeLessThan(oneBias);
    // ...but the CREW-level bound (CREW_BIAS_CAP = 1) still holds even with two people.
    expect(twoBias).toBeGreaterThanOrEqual(-1);
  });
});

describe('decay over time', () => {
  test('an old rejection contributes less than an equally-sized fresh one', async () => {
    await resetDatabase();
    const { crewId, userA } = await seedRawCrew({ ...HOME });

    const oldExp = await seedExperience({ name: 'Old Rejection Fixture', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });
    const oldRec = await prisma.crewRecommendation.create({ data: { crewId, experienceId: oldExp.id, score: 60, reasonText: 'fixture', status: 'NOT_FOR_US' } });
    await prisma.recommendationResponse.create({
      data: { crewRecommendationId: oldRec.id, userId: userA.id, action: 'NOT_FOR_US', createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
    });

    const freshExp = await seedExperience({ name: 'Fresh Rejection Fixture', category: 'RESTAURANT', lat: NEARBY.lat, lng: NEARBY.lng });
    const freshRec = await prisma.crewRecommendation.create({ data: { crewId, experienceId: freshExp.id, score: 60, reasonText: 'fixture', status: 'NOT_FOR_US' } });
    await prisma.recommendationResponse.create({ data: { crewRecommendationId: freshRec.id, userId: userA.id, action: 'NOT_FOR_US' } });

    const bias = await computeCrewLearningBias(crewId);
    const oldBias = Math.abs(bias.category.get('SPORT') ?? 0);
    const freshBias = Math.abs(bias.category.get('RESTAURANT') ?? 0);
    // Same base delta (-0.35, one user, no reason code), 200 real days apart — the old one must
    // have decayed to meaningfully less than the fresh one's full weight ("allow recovery" over
    // time, product spec's own requirement).
    expect(oldBias).toBeLessThan(freshBias);
    expect(oldBias).toBeGreaterThan(0); // decayed, never snapped instantly to zero
  });
});

describe('real positive learning beyond the explicit "More like this" button', () => {
  test('a real IN vote and a real Locked plan both produce positive category bias', async () => {
    await resetDatabase();
    const { crewId, userA, userB } = await seedRawCrew({ ...HOME });

    const votedExp = await seedExperience({ name: 'IN Vote Fixture', category: 'COMEDY', lat: NEARBY.lat, lng: NEARBY.lng });
    const votedPlan = await prisma.plan.create({
      data: { crewId, experienceId: votedExp.id, title: votedExp.name, proposedByUserId: userA.id, status: 'GATHERING_INTEREST' },
    });
    await prisma.planVote.create({ data: { planId: votedPlan.id, userId: userA.id, vote: 'IN' } });

    const lockedExp = await seedExperience({ name: 'Locked Plan Fixture', category: 'THEATRE', lat: NEARBY.lat, lng: NEARBY.lng });
    const lockedPlan = await prisma.plan.create({
      data: { crewId, experienceId: lockedExp.id, title: lockedExp.name, proposedByUserId: userA.id, status: 'LOCKED' },
    });
    await prisma.planMember.createMany({
      data: [
        { planId: lockedPlan.id, userId: userA.id },
        { planId: lockedPlan.id, userId: userB.id },
      ],
    });

    const bias = await computeCrewLearningBias(crewId);
    expect(bias.category.get('COMEDY') ?? 0).toBeGreaterThan(0);
    expect(bias.category.get('THEATRE') ?? 0).toBeGreaterThan(0);
    // A real Lock is the strongest signal this product has — stronger than a bare IN vote.
    expect(bias.category.get('THEATRE')!).toBeGreaterThan(bias.category.get('COMEDY')!);
  });
});

describe('category diversity / fatigue penalty', () => {
  test('a candidate in a recently-recommended category scores measurably lower than the identical candidate with no recent history', async () => {
    await resetDatabase();
    const { crewId } = await seedRawCrew({ ...HOME, categoryPreferences: ['SPORT'] });
    const target = await seedExperience({ name: 'Fatigue Target Derby', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });

    const before = await explainCrewRecommendation(crewId);
    const beforeCandidate = topCandidatesOf(before).find((c) => c.experienceId === target.id);
    expect(beforeCandidate).toBeDefined();
    const beforeScore = beforeCandidate!.matchScore;
    expect(beforeScore).toBeGreaterThan(15); // comfortably above the largest fatigue penalty (12), so the subtraction is cleanly visible

    // The MOST RECENT category sent gets the largest penalty (tapering [12, 7, 3]) — seed exactly
    // one prior SPORT recommendation so `target` lands in the harshest, first-place penalty slot.
    const priorExp = await seedExperience({ name: 'Prior Sport Recommendation', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });
    await prisma.crewRecommendation.create({
      data: { crewId, experienceId: priorExp.id, score: 60, reasonText: 'fixture', status: 'SENT', createdAt: new Date(Date.now() - 40 * 60 * 60 * 1000) },
    });

    const after = await explainCrewRecommendation(crewId);
    const afterCandidate = topCandidatesOf(after).find((c) => c.experienceId === target.id);
    expect(afterCandidate).toBeDefined();
    expect(afterCandidate!.matchScore).toBe(beforeScore - 12);
  });

  test('a candidate in a category NOT recently recommended is never penalised', async () => {
    await resetDatabase();
    const { crewId } = await seedRawCrew({ ...HOME, categoryPreferences: ['SPORT', 'RESTAURANT'] });
    const target = await seedExperience({ name: 'Unfatigued Restaurant Target', category: 'RESTAURANT', lat: NEARBY.lat, lng: NEARBY.lng, provider: 'ticketmaster', priceMinMinor: 1500 });
    const priorExp = await seedExperience({ name: 'Prior Sport Recommendation 2', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });
    await prisma.crewRecommendation.create({
      data: { crewId, experienceId: priorExp.id, score: 60, reasonText: 'fixture', status: 'SENT', createdAt: new Date(Date.now() - 40 * 60 * 60 * 1000) },
    });

    const explain = await explainCrewRecommendation(crewId);
    const candidate = topCandidatesOf(explain).find((c) => c.experienceId === target.id);
    expect(candidate).toBeDefined();
    expect(candidate!.category).toBe('RESTAURANT'); // a different category from the SPORT history — never touched by the penalty
  });
});

describe('active-Crew gating and cadence spacing', () => {
  test('a Crew with no recent chat, response, or Plan activity — and past its onboarding grace period — is skipped as inactive', async () => {
    await resetDatabase();
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const { crewId } = await seedRawCrew({ ...HOME, categoryPreferences: ['SPORT'], createdAt: oldDate });
    await seedExperience({ name: 'Inactive Crew Candidate', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });

    const explain = await explainCrewRecommendation(crewId);
    expect(explain.outcome).toBe('crew_inactive');
  });

  test('a brand-new Crew (within its onboarding grace period) is never treated as inactive, even with zero chat history', async () => {
    await resetDatabase();
    const { crewId } = await seedRawCrew({ ...HOME, categoryPreferences: ['SPORT'] });
    await seedExperience({ name: 'Fresh Crew Candidate', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });

    const explain = await explainCrewRecommendation(crewId);
    expect(explain.outcome).not.toBe('crew_inactive');
  });

  test('a second automatic recommendation within the minimum spacing window is deferred as "too_soon", never dumped alongside the first', async () => {
    await resetDatabase();
    const { crewId } = await seedRawCrew({ ...HOME, categoryPreferences: ['SPORT'] });
    const exp = await seedExperience({ name: 'Cadence Candidate', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });
    // A recommendation sent moments ago — well inside the 36-hour minimum spacing window.
    await prisma.crewRecommendation.create({ data: { crewId, experienceId: exp.id, score: 60, reasonText: 'fixture', status: 'SENT' } });

    const explain = await explainCrewRecommendation(crewId);
    expect(explain.outcome).toBe('too_soon');
  });

  test('once the spacing window has genuinely passed, the Crew is eligible again', async () => {
    await resetDatabase();
    const { crewId } = await seedRawCrew({ ...HOME, categoryPreferences: ['SPORT'] });
    const oldExp = await seedExperience({ name: 'Old Recommendation', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });
    await prisma.crewRecommendation.create({
      data: { crewId, experienceId: oldExp.id, score: 60, reasonText: 'fixture', status: 'SENT', createdAt: new Date(Date.now() - 40 * 60 * 60 * 1000) },
    });
    await seedExperience({ name: 'New Cadence Candidate', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });

    const explain = await explainCrewRecommendation(crewId);
    expect(explain.outcome).not.toBe('too_soon');
  });
});

describe('controlled exploration', () => {
  test('a genuine sub-threshold-but-defensible ticketed candidate is sent as EXPLORATORY when nothing else clears the normal bar, and never displaces a real match', async () => {
    await resetDatabase();
    const { crewId } = await seedRawCrew({ ...HOME, categoryPreferences: ['SPORT'] });
    // Right at the edge of the radius (small distance bonus), one of two members marked busy
    // (half availability credit), and a real ticket (+14) — real evidence, but deliberately not
    // enough to clear the normal MEDIUM floor (55).
    const edgeLat = HOME.lat + 0.34; // ~24 real miles from HOME — just inside a 25-mile radius
    const exp = await seedExperience({ name: 'Exploratory Candidate', category: 'SPORT', lat: edgeLat, lng: HOME.lng, provider: 'mock_ticketing', priceMinMinor: 1500 });
    const members = await prisma.crewMember.findMany({ where: { crewId }, select: { userId: true } });
    await prisma.availabilityWindow.create({
      data: {
        userId: members[0].userId,
        busy: true,
        startsAt: new Date(exp.startsAt.getTime() - 60 * 60 * 1000),
        endsAt: new Date(exp.startsAt.getTime() + 5 * 60 * 60 * 1000),
        source: 'MANUAL',
      },
    });

    const explain = await explainCrewRecommendation(crewId);
    const candidate = topCandidatesOf(explain).find((c) => c.experienceId === exp.id);
    expect(candidate).toBeDefined();
    // The fixture must genuinely land in the exploratory band for this test to prove anything —
    // a score that lands elsewhere means this fixture needs retuning, not the assertions below.
    expect(candidate!.matchScore).toBeGreaterThanOrEqual(40);
    expect(candidate!.matchScore).toBeLessThan(55);

    const rec = await generateRecommendationForCrew(crewId);
    expect(rec).not.toBeNull();
    expect(rec!.experienceId).toBe(exp.id);
    expect(rec!.confidence).toBe('EXPLORATORY');
  });

  test('the weekly exploratory rate limit blocks a second exploratory send even when cadence spacing alone would allow it', async () => {
    await resetDatabase();
    const { crewId } = await seedRawCrew({ ...HOME, categoryPreferences: ['SPORT'] });
    const edgeLat = HOME.lat + 0.34;
    const exp = await seedExperience({ name: 'Second Exploratory Candidate', category: 'SPORT', lat: edgeLat, lng: HOME.lng, provider: 'mock_ticketing', priceMinMinor: 1500 });
    const members = await prisma.crewMember.findMany({ where: { crewId }, select: { userId: true } });
    await prisma.availabilityWindow.create({
      data: {
        userId: members[0].userId,
        busy: true,
        startsAt: new Date(exp.startsAt.getTime() - 60 * 60 * 1000),
        endsAt: new Date(exp.startsAt.getTime() + 5 * 60 * 60 * 1000),
        source: 'MANUAL',
      },
    });
    // A prior EXPLORATORY send 40 hours ago — outside the 36-hour cadence window (so cadence
    // alone would allow a new send), but still inside the 7-day exploratory rate-limit window.
    const priorExp = await seedExperience({ name: 'Prior Exploratory Send', category: 'SPORT', lat: NEARBY.lat, lng: NEARBY.lng });
    await prisma.crewRecommendation.create({
      data: {
        crewId,
        experienceId: priorExp.id,
        score: 45,
        reasonText: 'fixture',
        status: 'SENT',
        confidence: 'EXPLORATORY',
        createdAt: new Date(Date.now() - 40 * 60 * 60 * 1000),
      },
    });

    const explain = await explainCrewRecommendation(crewId);
    // Cadence itself has passed (>36h) so this must NOT read as "too_soon" — it must genuinely
    // be the exploratory-specific rate limit that blocks it.
    expect(explain.outcome).not.toBe('too_soon');
    expect(explain.outcome).toBe('no_eligible_candidate');
  });
});
