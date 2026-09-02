import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resetDatabase } from './helpers/resetDb';
import type { ProviderAdapter, RawListing, CanonicalListingInput } from '../src/providers/types';

/**
 * The actual live bug this proves fixed: Discover felt permanently stuck loading because
 * `ensureInventoryProduction` blocked EVERY caller on a due resync finishing, even when the
 * city already had a full, real catalogue to show right now. See inventorySync.ts's own comment
 * on `ensureInventoryProduction` for the fix — a city with existing content no longer waits for
 * its due sync; the sync still runs, just in the background, and the next request picks up its
 * results. A genuinely empty city (nothing to show yet at all) is the one case that still waits
 * — proven separately by ensureInventoryResilience.test.ts's own tests against a fresh city.
 *
 * The mocked adapter's `fetchListings` blocks on a gate this test controls directly, rather than
 * a real delay — deterministic, and proves the fix by construction: if
 * `ensureInventoryProduction` still awaited the sync (the pre-fix behaviour), this test would
 * hang until Vitest's own timeout killed it, never resolving on its own.
 */
let releaseFetch: (() => void) | null = null;

vi.mock('../src/providers/registry', () => ({
  providerRegistry: [
    {
      id: 'slow_test_adapter',
      displayName: 'Slow Test Adapter',
      categories: ['LIVE_MUSIC'],
      isLive: true,
      async healthCheck() {
        return { status: 'ACTIVE' as const, checkedAt: new Date() };
      },
      async fetchListings(): Promise<RawListing[]> {
        await new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        return [];
      },
      mapToCanonical(): CanonicalListingInput {
        throw new Error('unused — fetchListings always returns an empty array in this test');
      },
    } as unknown as ProviderAdapter,
  ],
  hasLiveProvider: true,
  hasLiveTicketedProvider: true,
  getProvider: () => undefined,
}));

describe('ensureInventoryProduction: an already-seeded city must not block on its due resync', () => {
  beforeEach(async () => {
    await resetDatabase();
    releaseFetch = null;
  });

  test('resolves immediately even while the due sync is still genuinely in flight', async () => {
    const { ensureInventoryProduction } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');

    const venue = await prisma.venue.create({
      data: { name: 'Existing Venue', latitude: 52.8062, longitude: -2.1169, city: 'Already Seeded City' },
    });
    await prisma.experience.create({
      data: {
        canonicalKey: 'existing-seed-1',
        name: 'Existing Event',
        description: 'Real content already here before this sync started.',
        category: 'LIVE_MUSIC',
        subcategories: [],
        venueId: venue.id,
        startsAt: new Date(),
        tags: {},
      },
    });

    // The gate is never released before this — proves the call didn't wait for it.
    await expect(ensureInventoryProduction('Already Seeded City')).resolves.toBeUndefined();

    // The read that triggered this must see the content that was already there, immediately.
    await expect(prisma.experience.count({ where: { venue: { city: 'Already Seeded City' } } })).resolves.toBe(1);

    // Clean up the still-pending background sync so it doesn't leak into a later test.
    releaseFetch?.();
  });
});
