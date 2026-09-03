import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetDatabase } from './helpers/resetDb';

/**
 * THE RETROACTIVE HALF of the real-image directive ("I don't want to see ANY events without a
 * real image") — mirrors imageQualityBackfill.test.ts's own reasoning exactly, for "has no image
 * at all" instead of "has a bad one": a row already sitting in the database from before the
 * Wikipedia/TheSportsDB/categoryStockImages enrichment chain existed (or grew a new tier) keeps
 * `imageUrl: null` indefinitely on a pilot-scale app with sparse traffic. backfillMissingImages
 * re-runs the full chain against every existing null-image row instead of waiting for that.
 */
vi.mock('../src/lib/imageEnrichment', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/imageEnrichment')>('../src/lib/imageEnrichment');
  return {
    ...actual,
    enrichImageFromTheSportsDb: vi.fn(async () => null),
    enrichImageFromWikipedia: vi.fn(async (name: string) => (name.includes('Wikipedia Match') ? { url: 'https://upload.wikimedia.org/matched.jpg', sourcePage: name } : null)),
  };
});
vi.mock('../src/lib/categoryStockImages', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/categoryStockImages')>('../src/lib/categoryStockImages');
  return {
    ...actual,
    getCategoryStockImage: vi.fn(async (category: string) => (category === 'RESTAURANT' ? null : { url: 'https://upload.wikimedia.org/category-stock.jpg', sourcePage: 'File:Stock.jpg' })),
  };
});

async function seedExperience(name: string, category: 'LIVE_MUSIC' | 'RESTAURANT' = 'LIVE_MUSIC') {
  const { prisma } = await import('../src/lib/prisma');
  const venue = await prisma.venue.create({
    data: { name: `${name} Venue`, latitude: 52.8062, longitude: -2.1169, city: 'Missing Image Backfill Test City' },
  });
  return prisma.experience.create({
    data: {
      canonicalKey: `missing-image-backfill::${name.toLowerCase().replace(/\s+/g, '-')}`,
      name,
      description: 'A test listing.',
      category,
      subcategories: [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      timezone: 'Europe/London',
      currency: 'GBP',
      bookingStatus: 'AVAILABLE',
      imageUrl: null,
      imageSource: null,
      tags: {},
      qualityScore: 80,
    },
  });
}

describe('backfillMissingImages — retroactive real-image fill for already-synced rows', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('fills an existing null-image row via Wikipedia enrichment when its name matches', async () => {
    const { backfillMissingImages } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    await seedExperience('A Real Wikipedia Match Gig');

    const result = await backfillMissingImages();
    expect(result.filled).toBeGreaterThanOrEqual(1);

    const row = await prisma.experience.findFirst({ where: { name: 'A Real Wikipedia Match Gig' } });
    expect(row!.imageUrl).toBe('https://upload.wikimedia.org/matched.jpg');
    expect(row!.imageSource).toBe('WIKIPEDIA');
  });

  test('falls through to a real category-stock photo when no artist/venue match exists', async () => {
    const { backfillMissingImages } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    await seedExperience('Some Unknown Local Open Mic Night');

    await backfillMissingImages();

    const row = await prisma.experience.findFirst({ where: { name: 'Some Unknown Local Open Mic Night' } });
    expect(row!.imageUrl).toBe('https://upload.wikimedia.org/category-stock.jpg');
    expect(row!.imageSource).toBe('CATEGORY_STOCK');
  });

  test('a row where even the category-stock search comes up empty is left null, never fabricated', async () => {
    const { backfillMissingImages } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    await seedExperience('Totally Unmatched Diner', 'RESTAURANT');

    await backfillMissingImages();

    const row = await prisma.experience.findFirst({ where: { name: 'Totally Unmatched Diner' } });
    expect(row!.imageUrl).toBeNull();
    expect(row!.imageSource).toBeNull();
  });

  test('never touches a row that already has a real image', async () => {
    const { backfillMissingImages } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    const existing = await seedExperience('Already Has A Photo');
    await prisma.experience.update({ where: { id: existing.id }, data: { imageUrl: 'https://real.example/photo.jpg', imageSource: 'MANUAL' } });

    const result = await backfillMissingImages();

    const row = await prisma.experience.findFirst({ where: { name: 'Already Has A Photo' } });
    expect(row!.imageUrl).toBe('https://real.example/photo.jpg');
    expect(row!.imageSource).toBe('MANUAL');
    // Not counted as "checked" either — the query only ever targets imageUrl: null rows.
    expect(result.checked).toBe(0);
  });

  test('checks and fills EVERY matching row, not just a capped subset', async () => {
    const { backfillMissingImages } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    const total = 40;
    for (let i = 0; i < total; i++) {
      await seedExperience(`Bulk Unknown Night ${i}`);
    }

    const result = await backfillMissingImages();
    expect(result.checked).toBe(total);
    expect(result.filled).toBe(total);

    const stillMissing = await prisma.experience.count({ where: { name: { startsWith: 'Bulk Unknown Night' }, imageUrl: null } });
    expect(stillMissing).toBe(0);
  }, 30_000);

  test('maxToCheck caps the total rows checked, for the admin ad-hoc endpoint — never used by the boot/periodic callers', async () => {
    const { backfillMissingImages } = await import('../src/services/inventorySync');
    for (let i = 0; i < 10; i++) {
      await seedExperience(`Cap Test Night ${i}`);
    }

    const result = await backfillMissingImages(4);
    expect(result.checked).toBe(4);
    expect(result.filled).toBe(4);
  });
});

/**
 * The DB-backed due-scheduler for the backfill (services/inventorySync.ts
 * #runMissingImageBackfillIfDue) — same claim mechanics already proven for the image-quality
 * backfill and the recommendation sweep, applied to a genuinely separate SchedulerState row.
 */
describe('runMissingImageBackfillIfDue: database-backed, restart/race safe, separate from the other backfill jobs', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  test('a due run runs, and immediately calling again with the same interval does NOT run a second time', async () => {
    const { runMissingImageBackfillIfDue } = await import('../src/services/inventorySync');
    const first = await runMissingImageBackfillIfDue(6 * 60 * 60 * 1000);
    expect(first.ran).toBe(true);

    const second = await runMissingImageBackfillIfDue(6 * 60 * 60 * 1000);
    expect(second.ran).toBe(false);
  });

  test('a run older than the interval is claimed as due again', async () => {
    const { prisma } = await import('../src/lib/prisma');
    const { runMissingImageBackfillIfDue, MISSING_IMAGE_BACKFILL_JOB_NAME } = await import('../src/services/inventorySync');

    await prisma.schedulerState.update({
      where: { jobName: MISSING_IMAGE_BACKFILL_JOB_NAME },
      data: { lastClaimedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) },
    });

    const outcome = await runMissingImageBackfillIfDue(6 * 60 * 60 * 1000);
    expect(outcome.ran).toBe(true);
  });

  test('uses its own SchedulerState row, entirely separate from the image-quality backfill\'s', async () => {
    const { runMissingImageBackfillIfDue, MISSING_IMAGE_BACKFILL_JOB_NAME, IMAGE_QUALITY_BACKFILL_JOB_NAME } = await import('../src/services/inventorySync');
    expect(MISSING_IMAGE_BACKFILL_JOB_NAME).not.toBe(IMAGE_QUALITY_BACKFILL_JOB_NAME);

    await runMissingImageBackfillIfDue(6 * 60 * 60 * 1000);
    const { prisma } = await import('../src/lib/prisma');
    const missingImageState = await prisma.schedulerState.findUnique({ where: { jobName: MISSING_IMAGE_BACKFILL_JOB_NAME } });
    const qualityState = await prisma.schedulerState.findUnique({ where: { jobName: IMAGE_QUALITY_BACKFILL_JOB_NAME } });
    expect(missingImageState).not.toBeNull();
    expect(qualityState).toBeNull(); // never ran here — proves the two really are independent rows
  });
});
