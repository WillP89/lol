import { beforeEach, describe, expect, test, vi } from 'vitest';
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
});
