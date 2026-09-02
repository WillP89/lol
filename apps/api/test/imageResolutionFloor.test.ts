import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resetDatabase } from './helpers/resetDb';
import type { ProviderAdapter, RawListing, CanonicalListingInput } from '../src/providers/types';

/**
 * "Still lots of stretched and distorted imagery" — the real gap this closes: Ticketmaster and
 * the Wikipedia enrichment path already reject a low-resolution image because both APIs report a
 * real declared width (see providers/live/ticketmaster.ts#bestImage and lib/imageEnrichment.ts).
 * Skiddle's own API reports NO image dimensions at all — the exact provider an existing code
 * comment already names as the source of "bright, busy, high-contrast flyer art" — so a
 * resolution floor that only trusts declared metadata can never catch a small Skiddle image.
 * `syncProvider` now probes the real bytes for exactly these untrusted sources (see
 * lib/imageDimensions.ts) and drops the image (falls back to the editorial art) when the real
 * pixel width can't clear the floor.
 */
vi.mock('../src/lib/imageDimensions', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/imageDimensions')>('../src/lib/imageDimensions');
  return {
    ...actual,
    // Deterministic stand-in for the real byte-probe — this test is about syncProvider's own
    // wiring (which sources get probed, what happens to the row on a miss), not about re-proving
    // the quality gate itself (see test/unit/imageDimensions.test.ts for that).
    isImageQualityBad: vi.fn(async (url: string) => url.includes('tiny')),
  };
});

function skiddleStyleAdapter(imageUrl: string): ProviderAdapter {
  return {
    id: 'skiddle',
    displayName: 'Skiddle',
    categories: ['LIVE_MUSIC'],
    isLive: true,
    async healthCheck() {
      return { status: 'ACTIVE' as const, checkedAt: new Date() };
    },
    async fetchListings(): Promise<RawListing[]> {
      return [{ externalId: 'ev-1', raw: {} }];
    },
    mapToCanonical(): CanonicalListingInput {
      return {
        name: 'Resolution Floor Test Night',
        description: 'A test listing.',
        category: 'LIVE_MUSIC',
        subcategories: [],
        venueName: 'Resolution Floor Test Venue',
        latitude: 52.8062,
        longitude: -2.1169,
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        endsAt: null,
        timezone: 'Europe/London',
        priceMinMinor: null,
        priceMaxMinor: null,
        currency: 'GBP',
        bookingStatus: 'AVAILABLE',
        imageUrl,
        imageSource: 'SKIDDLE',
        tags: {},
        externalUrl: 'https://skiddle.example/event/1',
        commissionEligible: false,
      };
    },
  } as ProviderAdapter;
}

describe('universal image resolution floor — unverified-metadata providers', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('a real Skiddle-shaped image below the floor is dropped, not kept and displayed small', async () => {
    const { syncProvider } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    const params = { city: 'Resolution Floor Test City', fromDate: new Date(), toDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };

    await syncProvider(skiddleStyleAdapter('https://img.example/tiny-flyer.jpg'), params);

    const experience = await prisma.experience.findFirst({ where: { name: 'Resolution Floor Test Night' } });
    expect(experience).not.toBeNull();
    expect(experience!.imageUrl).toBeNull();
    expect(experience!.imageSource).toBeNull();
  });

  test('a real Skiddle-shaped image that clears the floor is kept', async () => {
    const { syncProvider } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    const params = { city: 'Resolution Floor Test City 2', fromDate: new Date(), toDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };

    await syncProvider(skiddleStyleAdapter('https://img.example/hd-flyer.jpg'), params);

    const experience = await prisma.experience.findFirst({ where: { name: 'Resolution Floor Test Night' } });
    expect(experience!.imageUrl).toBe('https://img.example/hd-flyer.jpg');
    expect(experience!.imageSource).toBe('SKIDDLE');
  });
});
