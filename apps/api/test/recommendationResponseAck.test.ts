import { describe, expect, test } from 'vitest';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';
import { recordRecommendationResponse, RecommendationResponseError, computeCrewLearningBias } from '../src/services/recommendationLearning';

/**
 * THE single write path for a member's response to a Crew recommendation
 * (recordRecommendationResponse) — proves it writes the real per-member signal AND the natural,
 * Plot-voiced acknowledgment copy, and that situational reasons never cool future taste scoring
 * while genuine "not our thing" ones do (see recommendationLearning.ts#deltaFor's own header).
 */

async function seedFixture() {
  const owner = await prisma.user.create({ data: { email: `ack-owner-${Date.now()}@plot-test.invalid`, displayName: 'Owner', status: 'ACTIVE', emailVerifiedAt: new Date() } });
  const crew = await prisma.crew.create({ data: { name: 'Ack Test Crew', createdById: owner.id } });
  await prisma.crewMember.create({ data: { crewId: crew.id, userId: owner.id, status: 'ACTIVE' } });
  const venue = await prisma.venue.create({ data: { name: 'Ack Venue', city: 'Ack City', latitude: 52.8, longitude: -2.1 } });
  const experience = await prisma.experience.create({
    data: {
      canonicalKey: `test-ack-${venue.id}`,
      name: 'Ack Test Experience',
      description: 'A real test fixture with enough description to pass quality scoring.',
      category: 'RESTAURANT',
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
  const recommendation = await prisma.crewRecommendation.create({
    data: { crewId: crew.id, experienceId: experience.id, score: 60, reasonText: 'fixture', status: 'SENT' },
  });
  return { crewId: crew.id, userId: owner.id, recommendationId: recommendation.id };
}

describe('recordRecommendationResponse', () => {
  test('MORE_LIKE_THIS writes a per-member row, updates the aggregate status, and returns a natural ack', async () => {
    await resetDatabase();
    const { crewId, userId, recommendationId } = await seedFixture();

    const { recommendation, ack } = await recordRecommendationResponse(crewId, recommendationId, userId, 'more_like_this');
    expect(recommendation.status).toBe('MORE_LIKE_THIS');
    expect(ack.toLowerCase()).toContain('more like this');
    expect(ack).not.toMatch(/vector|score|\d+%/i); // never technical/AI-sounding copy

    const stored = await prisma.recommendationResponse.findUnique({
      where: { crewRecommendationId_userId: { crewRecommendationId: recommendationId, userId } },
    });
    expect(stored).not.toBeNull();
    expect(stored!.action).toBe('MORE_LIKE_THIS');
  });

  test('NOT_FOR_US with a situational reason ("too_far") produces a matching ack but contributes zero taste bias', async () => {
    await resetDatabase();
    const { crewId, userId, recommendationId } = await seedFixture();

    const { ack } = await recordRecommendationResponse(crewId, recommendationId, userId, 'not_for_us', 'too_far');
    expect(ack.toLowerCase()).toContain('closer');

    const bias = await computeCrewLearningBias(crewId);
    expect(bias.category.get('RESTAURANT') ?? 0).toBe(0); // situational reason — never read as "wrong taste"
  });

  test('NOT_FOR_US with no reason (or a genuine taste reason) DOES cool future category scoring', async () => {
    await resetDatabase();
    const { crewId, userId, recommendationId } = await seedFixture();

    const { ack } = await recordRecommendationResponse(crewId, recommendationId, userId, 'not_for_us');
    expect(ack.toLowerCase()).toContain('less of this');

    const bias = await computeCrewLearningBias(crewId);
    expect(bias.category.get('RESTAURANT') ?? 0).toBeLessThan(0);
  });

  test('responding twice to the same recommendation upserts (one row per member, latest action wins), never duplicates', async () => {
    await resetDatabase();
    const { crewId, userId, recommendationId } = await seedFixture();

    await recordRecommendationResponse(crewId, recommendationId, userId, 'too_far');
    await recordRecommendationResponse(crewId, recommendationId, userId, 'more_like_this');

    const rows = await prisma.recommendationResponse.findMany({ where: { crewRecommendationId: recommendationId, userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('MORE_LIKE_THIS');
  });

  test('a recommendation id that does not belong to this Crew is rejected as not_found, never leaking cross-Crew data', async () => {
    await resetDatabase();
    const { recommendationId } = await seedFixture();
    const otherOwner = await prisma.user.create({ data: { email: `ack-other-${Date.now()}@plot-test.invalid`, displayName: 'Other', status: 'ACTIVE', emailVerifiedAt: new Date() } });
    const otherCrew = await prisma.crew.create({ data: { name: 'Other Crew', createdById: otherOwner.id } });

    await expect(recordRecommendationResponse(otherCrew.id, recommendationId, otherOwner.id, 'more_like_this')).rejects.toThrow(RecommendationResponseError);
  });
});
