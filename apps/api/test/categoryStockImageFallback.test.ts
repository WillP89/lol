import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resetDatabase } from './helpers/resetDb';
import type { ProviderAdapter, RawListing, CanonicalListingInput } from '../src/providers/types';

/**
 * The real, explicit product directive this proves: "I don't want to see ANY events without a
 * real image." A listing whose provider has no photo AND whose name matches no Wikipedia article
 * (a generic "Quiz Night at The Anchor"-shaped listing — the exact case Wikipedia enrichment can
 * never help with) must still end up with a real, category-appropriate photograph, never left at
 * imageUrl: null (which would mean the web app's own generated category-art graphic is all that's
 * left to show for it). `enrichImageFromWikipedia` isn't mocked here — the real function is used,
 * and (as in this sandbox generally) its own outbound fetch fails/is blocked, which is exactly the
 * "no Wikipedia match" case this test needs.
 *
 * Both `getCategoryStockImage` (Commons) and `getPexelsStockImage` (Pexels) ARE mocked, the same
 * pattern imageResolutionFloor.test.ts already uses for isImageQualityBad — this test is about
 * syncProvider's own wiring/fallback ORDER across all four tiers, not about re-proving either
 * search's own logic (see test/unit/categoryStockImages.test.ts and
 * test/unit/pexelsStockImages.test.ts for that). Pexels exists as a genuinely separate,
 * independently-tried tier — not a hypothetical — because of a real, production-confirmed fact:
 * Wikimedia's own edge infrastructure returns a hard 403 to this app's real Render deployment,
 * which very likely defeats Commons search too even though it's a different endpoint on the same
 * domain family (see pexelsStockImages.ts's own header for the full story).
 */
vi.mock('../src/lib/categoryStockImages', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/categoryStockImages')>('../src/lib/categoryStockImages');
  return {
    ...actual,
    getCategoryStockImage: vi.fn(async (category: string) =>
      category === 'LIVE_MUSIC' ? { url: 'https://upload.wikimedia.org/real-concert-crowd.jpg', sourcePage: 'File:Concert crowd.jpg' } : null,
    ),
  };
});
vi.mock('../src/lib/pexelsStockImages', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/pexelsStockImages')>('../src/lib/pexelsStockImages');
  return {
    ...actual,
    getPexelsStockImage: vi.fn(async (category: string) =>
      category === 'RESTAURANT' ? { url: 'https://images.pexels.com/real-restaurant-interior.jpg', sourcePage: 'Restaurant interior' } : null,
    ),
  };
});

function noImageAdapter(category: 'LIVE_MUSIC' | 'RESTAURANT' | 'COMEDY', name: string): ProviderAdapter {
  return {
    id: 'no_image_test_adapter',
    displayName: 'No-image test adapter',
    categories: [category],
    isLive: true,
    async healthCheck() {
      return { status: 'ACTIVE' as const, checkedAt: new Date() };
    },
    async fetchListings(): Promise<RawListing[]> {
      return [{ externalId: 'ev-1', raw: {} }];
    },
    mapToCanonical(): CanonicalListingInput {
      return {
        name,
        description: 'A test listing with no provider image and no Wikipedia match.',
        category,
        subcategories: [],
        venueName: `${name} Venue`,
        latitude: 52.4862,
        longitude: -1.8904,
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        endsAt: null,
        timezone: 'Europe/London',
        priceMinMinor: null,
        priceMaxMinor: null,
        currency: 'GBP',
        bookingStatus: 'AVAILABLE',
        imageUrl: null,
        imageSource: null,
        tags: {},
        externalUrl: 'https://example.invalid/event/1',
        commissionEligible: false,
      };
    },
  } as ProviderAdapter;
}

describe('category-stock image fallback — no event left without a real photo', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('a listing with no provider image and no Wikipedia match gets a real photo from Commons (tier 1)', async () => {
    const { syncProvider } = await import('../src/services/inventorySync');
    const { getPexelsStockImage } = await import('../src/lib/pexelsStockImages');
    const { prisma } = await import('../src/lib/prisma');
    const params = { city: 'Category Stock Test City', fromDate: new Date(), toDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };

    await syncProvider(noImageAdapter('LIVE_MUSIC', 'Unknown Local Open Mic Night'), params);

    const experience = await prisma.experience.findFirst({ where: { name: 'Unknown Local Open Mic Night' } });
    expect(experience).not.toBeNull();
    expect(experience!.imageUrl).toBe('https://upload.wikimedia.org/real-concert-crowd.jpg');
    expect(experience!.imageSource).toBe('CATEGORY_STOCK');
    // Commons already answered — Pexels must never even be called (cost/latency: no point
    // querying a second real-photo source once the first one already found something).
    expect(getPexelsStockImage).not.toHaveBeenCalled();
  });

  test('a listing where Commons comes up empty falls through to a real photo from Pexels (tier 2)', async () => {
    const { syncProvider } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    const params = { city: 'Category Stock Test City 2', fromDate: new Date(), toDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };

    await syncProvider(noImageAdapter('RESTAURANT', 'Totally Unmatched Diner'), params);

    const experience = await prisma.experience.findFirst({ where: { name: 'Totally Unmatched Diner' } });
    expect(experience!.imageUrl).toBe('https://images.pexels.com/real-restaurant-interior.jpg');
    expect(experience!.imageSource).toBe('PEXELS_STOCK');
  });

  test('a listing where every real-photo tier comes up empty is left null, never a fabricated url', async () => {
    const { syncProvider } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');
    const params = { city: 'Category Stock Test City 3', fromDate: new Date(), toDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };

    await syncProvider(noImageAdapter('COMEDY', 'Totally Unmatched Comedy Night'), params);

    const experience = await prisma.experience.findFirst({ where: { name: 'Totally Unmatched Comedy Night' } });
    expect(experience!.imageUrl).toBeNull();
    expect(experience!.imageSource).toBeNull();
  });
});
