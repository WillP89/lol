import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * GET /admin/experiences-near — the real gap this closes: neither `/inventory-probe` (what a
 * LIVE provider would return, bypassing the database entirely) nor `/providers` (aggregate DB
 * counts) answers "what does the automatic engine's own scorer actually see for this city right
 * now, and why did each nearby candidate pass or fail" — a sync completing cleanly (fetched >
 * 0, upserted > 0) proves listings exist somewhere, not that any of them are the right category,
 * within the recommendation date window, above the quality floor, or "plan-worthy" — every one
 * of which is a silent, separate way for a Crew to end up with a real "0 scored" outcome. This
 * mirrors `scoreExperiencesForCrew`'s own gates (services/match.ts) read-only, without needing a
 * live Crew id.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';

const STAFFORD = { lat: 52.8062, lng: -2.1169 };
const EDINBURGH = { lat: 55.9533, lng: -3.1883 };

async function createManualExperience(overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  const startsAt = new Date();
  startsAt.setDate(startsAt.getDate() + 10);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name: 'Test Sport Night',
      description: 'A real, specific fixture for a real venue.',
      category: 'SPORT',
      venueName: 'Test Stadium',
      city: 'Stafford',
      latitude: STAFFORD.lat,
      longitude: STAFFORD.lng,
      startsAt: startsAt.toISOString(),
      externalUrl: 'https://example.invalid/fixture',
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
}

describe('GET /admin/experiences-near', () => {
  test('requires the admin key, same as every other admin route', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/experiences-near?city=Stafford' });
    expect(res.statusCode).toBe(401);
  });

  test('finds a real nearby candidate and annotates it with every gate the real scorer applies', async () => {
    await resetDatabase();
    await createManualExperience();

    const res = await app.inject({ method: 'GET', url: '/admin/experiences-near?city=Stafford&radiusKm=50', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalWithinRadius: number;
      experiences: { name: string; category: string; distanceKm: number; passesQualityGate: boolean; passesDateWindow: boolean; passesBookingStatus: boolean; isPlanWorthy: boolean }[];
    };
    expect(body.totalWithinRadius).toBe(1);
    const match = body.experiences[0];
    expect(match.name).toBe('Test Sport Night');
    expect(match.category).toBe('SPORT');
    expect(match.distanceKm).toBeLessThan(1); // same coordinates as the search center
    expect(match.passesDateWindow).toBe(true); // 10 days out, well inside CANDIDATE_WINDOW_DAYS
    expect(match.passesBookingStatus).toBe(true); // manual entries default to AVAILABLE, never SOLD_OUT
    expect(match.isPlanWorthy).toBe(true); // a real, specific SPORT fixture, not a generic chain venue
  });

  test('a genuinely distant real venue is excluded by radius, not silently miscounted as local', async () => {
    await resetDatabase();
    await createManualExperience({ name: 'Distant Sport Night', venueName: 'Distant Arena', city: 'Edinburgh', latitude: EDINBURGH.lat, longitude: EDINBURGH.lng });

    const res = await app.inject({ method: 'GET', url: '/admin/experiences-near?city=Stafford&radiusKm=50', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { totalWithinRadius: number };
    expect(body.totalWithinRadius).toBe(0); // Edinburgh is genuinely ~500km from Stafford, well outside a 50km search
  });

  test('the category filter narrows the same way the real hard-filter does', async () => {
    await resetDatabase();
    await createManualExperience({ category: 'SPORT' });
    await createManualExperience({ name: 'Test Restaurant', venueName: 'Test Bistro', category: 'RESTAURANT' });

    const res = await app.inject({ method: 'GET', url: '/admin/experiences-near?city=Stafford&radiusKm=50&category=SPORT', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { totalWithinRadius: number; experiences: { category: string }[] };
    expect(body.totalWithinRadius).toBe(1);
    expect(body.experiences[0].category).toBe('SPORT');
  });
});
