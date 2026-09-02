import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetDatabase } from './helpers/resetDb';

/**
 * THE RETROACTIVE HALF of the image-quality floor — real live bug this proves fixed: a resolution
 * gate added to syncProvider only protects a row from the moment it's next (re)synced. A row
 * already sitting in the database from before the gate existed keeps its stale, ungated imageUrl
 * indefinitely on a pilot-scale app with sparse traffic (no guarantee its city gets resynced any
 * time soon) — exactly the "still looks stretched and distorted" report that came in minutes
 * after the sync-time gate itself had already shipped and deployed. backfillImageQuality re-probes
 * every EXISTING row instead of waiting for that.
 */
vi.mock('../src/lib/imageDimensions', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/imageDimensions')>('../src/lib/imageDimensions');
  return {
    ...actual,
    isImageQualityBad: vi.fn(async (url: string) => url.includes('tiny')),
  };
});

async function seedExperience(overrides: { name: string; imageUrl: string | null; imageSource: 'SKIDDLE' | 'TICKETMASTER' | 'MANUAL' | null }) {
  const { prisma } = await import('../src/lib/prisma');
  const venue = await prisma.venue.create({
    data: { name: `${overrides.name} Venue`, latitude: 52.8062, longitude: -2.1169, city: 'Backfill Test City' },
  });
  return prisma.experience.create({
    data: {
      canonicalKey: `backfill::${overrides.name.toLowerCase().replace(/\s+/g, '-')}`,
      name: overrides.name,
      description: 'A test listing.',
      category: 'LIVE_MUSIC',
      subcategories: [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      timezone: 'Europe/London',
      currency: 'GBP',
      bookingStatus: 'AVAILABLE',
      imageUrl: overrides.imageUrl,
      imageSource: overrides.imageSource,
      tags: {},
      qualityScore: 80,
    },
  });
}

describe('backfillImageQuality — retroactive quality gate for already-synced rows', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('clears an existing row whose image fails the floor, kept from before the gate existed', async () => {
    const { backfillImageQuality } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    await seedExperience({ name: 'Stale Small Skiddle Flyer', imageUrl: 'https://img.example/tiny-flyer.jpg', imageSource: 'SKIDDLE' });

    const result = await backfillImageQuality();
    expect(result.cleared).toBeGreaterThanOrEqual(1);

    const row = await prisma.experience.findFirst({ where: { name: 'Stale Small Skiddle Flyer' } });
    expect(row!.imageUrl).toBeNull();
    expect(row!.imageSource).toBeNull();
  });

  test('leaves a real, high-resolution existing image untouched', async () => {
    const { backfillImageQuality } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    await seedExperience({ name: 'Good HD Ticketmaster Photo', imageUrl: 'https://img.example/hd-photo.jpg', imageSource: 'TICKETMASTER' });

    await backfillImageQuality();

    const row = await prisma.experience.findFirst({ where: { name: 'Good HD Ticketmaster Photo' } });
    expect(row!.imageUrl).toBe('https://img.example/hd-photo.jpg');
  });

  test('never touches a MANUAL (operator-uploaded) image, regardless of its dimensions', async () => {
    const { backfillImageQuality } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    await seedExperience({ name: 'Operator Uploaded Tiny Photo', imageUrl: 'https://img.example/tiny-manual.jpg', imageSource: 'MANUAL' });

    await backfillImageQuality();

    const row = await prisma.experience.findFirst({ where: { name: 'Operator Uploaded Tiny Photo' } });
    expect(row!.imageUrl).toBe('https://img.example/tiny-manual.jpg');
    expect(row!.imageSource).toBe('MANUAL');
  });

  /**
   * TWO real bugs, found in sequence, both with exactly this symptom ("still seeing a bad image
   * after every fix"): (1) the original version selected `orderBy: updatedAt desc, take: 300` —
   * the 300 MOST RECENTLY updated rows, every single call, forever. A row that stops being
   * touched by any resync never rises back into that window — permanently skipped, no matter how
   * many times the process reboots. (2) fixing that with a cursor-paginated loop introduced a
   * SECOND, subtler bug: the loop's own WHERE clause (`imageUrl: { not: null }`) is exactly the
   * field the loop itself clears as it goes, and Prisma's cursor+skip needs the cursor row to
   * still satisfy that WHERE to skip correctly — whenever a page boundary landed on a row that
   * had just been cleared, the next page silently dropped one real, unprocessed row. This test
   * seeds a set large enough to prove BOTH: more rows than any plausible single-page/top-N cap,
   * with the bad ones deliberately mixed in (not all clustered at one end, since PostgreSQL's
   * ordering of random UUIDs already does this) so the run only passes if every single one is
   * actually found and cleared, not just "most of them".
   */
  test('checks and clears EVERY matching row, not just a capped/paginated subset — the real fix for the recurring "same bad image" reports', async () => {
    const { backfillImageQuality } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');

    // Comfortably larger than any plausible single-page cap this function has ever used (300,
    // then 200) — large enough that a regression to either bug above would show up as a mismatch.
    const totalBad = 320;
    for (let i = 0; i < totalBad; i++) {
      await seedExperience({ name: `Old Stale Bad Photo ${i}`, imageUrl: `https://img.example/tiny-${i}.jpg`, imageSource: 'SKIDDLE' });
    }
    for (let i = 0; i < 20; i++) {
      await seedExperience({ name: `Newer Good Photo ${i}`, imageUrl: `https://img.example/hd-${i}.jpg`, imageSource: 'TICKETMASTER' });
    }

    const result = await backfillImageQuality();
    expect(result.checked).toBe(totalBad + 20);
    expect(result.cleared).toBe(totalBad);

    const stillBad = await prisma.experience.count({ where: { name: { startsWith: 'Old Stale Bad Photo' }, imageUrl: { not: null } } });
    expect(stillBad).toBe(0);
    const untouchedGood = await prisma.experience.count({ where: { name: { startsWith: 'Newer Good Photo' }, imageUrl: { not: null } } });
    expect(untouchedGood).toBe(20);
  }, 30_000);

  test('maxToCheck caps the TOTAL rows checked across pages, for the admin ad-hoc endpoint — never used by the boot/periodic callers', async () => {
    const { backfillImageQuality } = await import('../src/services/inventorySync');
    for (let i = 0; i < 10; i++) {
      await seedExperience({ name: `Cap Test Photo ${i}`, imageUrl: `https://img.example/tiny-cap-${i}.jpg`, imageSource: 'SKIDDLE' });
    }

    const result = await backfillImageQuality(4);
    expect(result.checked).toBe(4);
    expect(result.cleared).toBe(4);
  });
});

/**
 * The DB-backed due-scheduler for the backfill (services/inventorySync.ts
 * #runImageQualityBackfillIfDue) — the fix for the OTHER half of "runs once at boot and hopes
 * that was enough": on hosting that sleeps/restarts/scales, a one-shot boot call is never enough
 * on its own. Same claim mechanics already proven for the recommendation sweep in
 * crewRecommendations.test.ts, applied to a genuinely separate SchedulerState row.
 */
describe('runImageQualityBackfillIfDue: database-backed, restart/race safe, separate from the recommendation sweep', () => {
  // beforeAll, not beforeEach — deliberately, same as crewRecommendations.test.ts's own
  // "recommendation sweep scheduling" describe block: later tests here rely on the
  // SchedulerState row an earlier test in this same block already created.
  beforeAll(async () => {
    await resetDatabase();
  });

  test('a due run runs, and immediately calling again with the same interval does NOT run a second time', async () => {
    const { runImageQualityBackfillIfDue } = await import('../src/services/inventorySync');
    const first = await runImageQualityBackfillIfDue(6 * 60 * 60 * 1000);
    expect(first.ran).toBe(true);

    const second = await runImageQualityBackfillIfDue(6 * 60 * 60 * 1000);
    expect(second.ran).toBe(false);
  });

  test('a run older than the interval is claimed as due again', async () => {
    const { prisma } = await import('../src/lib/prisma');
    const { runImageQualityBackfillIfDue, IMAGE_QUALITY_BACKFILL_JOB_NAME } = await import('../src/services/inventorySync');

    await prisma.schedulerState.update({
      where: { jobName: IMAGE_QUALITY_BACKFILL_JOB_NAME },
      data: { lastClaimedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) },
    });

    const outcome = await runImageQualityBackfillIfDue(6 * 60 * 60 * 1000);
    expect(outcome.ran).toBe(true);
  });

  test('uses its own SchedulerState row, entirely separate from the recommendation sweep\'s', async () => {
    const { runImageQualityBackfillIfDue, IMAGE_QUALITY_BACKFILL_JOB_NAME } = await import('../src/services/inventorySync');
    const { SWEEP_JOB_NAME } = await import('../src/services/crewRecommendations');
    expect(IMAGE_QUALITY_BACKFILL_JOB_NAME).not.toBe(SWEEP_JOB_NAME);

    await runImageQualityBackfillIfDue(6 * 60 * 60 * 1000);
    const { prisma } = await import('../src/lib/prisma');
    const backfillState = await prisma.schedulerState.findUnique({ where: { jobName: IMAGE_QUALITY_BACKFILL_JOB_NAME } });
    const sweepState = await prisma.schedulerState.findUnique({ where: { jobName: SWEEP_JOB_NAME } });
    expect(backfillState).not.toBeNull();
    expect(sweepState).toBeNull(); // never ran here — proves the two really are independent rows
  });
});
