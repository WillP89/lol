import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resetDatabase } from './helpers/resetDb';
import type { ProviderAdapter, RawListing, CanonicalListingInput } from '../src/providers/types';

/**
 * The actual live bug this proves fixed: a real user reported the Discover page loading with no
 * results AND the "send a recommendation the moment a Crew hits 2 members" trigger going silent
 * — both regressions from the exact same root cause. `ensureInventory`'s periodic-resync rewrite
 * (see the file's own comments) meant an ordinary request could be the one that happens to
 * trigger a real resync, and ANYTHING unexpected during that resync (a transient DB hiccup, a
 * provider adapter bug) used to propagate straight out of `ensureInventory` — turning "this
 * city's resync had a bad day" into "the whole request fails", which for Explore meant a 500
 * (rendering as an empty page) and for the Crew-join trigger meant silently delivering nothing
 * (it's fired with a bare `.catch()` that only logs).
 *
 * `providerRegistry` is mocked here with a single adapter whose `displayName` is `null` — Prisma
 * requires `Provider.name` to be a non-null string, so `prisma.provider.upsert` (the very first
 * thing `syncProvider` does, BEFORE its own try/catch, which only wraps `adapter.fetchListings()`
 * and each individual listing) throws a real client-side validation error immediately, with no
 * DB round-trip needed. That's a genuinely UNCAUGHT failure escaping `syncProvider` itself — the
 * real shape of "something unexpected happens during sync" (a provider adapter bug, a bad
 * migration, anything not already individually handled), not a contrived one.
 */
vi.mock('../src/providers/registry', () => ({
  providerRegistry: [
    {
      id: 'throwing_test_adapter',
      displayName: null,
      categories: ['LIVE_MUSIC'],
      isLive: true,
      async healthCheck() {
        return { status: 'ACTIVE' as const, checkedAt: new Date() };
      },
      async fetchListings(): Promise<RawListing[]> {
        return [{ externalId: 'irrelevant', raw: {} }];
      },
      mapToCanonical(): CanonicalListingInput {
        throw new Error('should never be reached — provider.upsert fails before any listing is mapped');
      },
    } as unknown as ProviderAdapter,
  ],
  hasLiveProvider: false,
  hasLiveTicketedProvider: false,
  getProvider: () => undefined,
}));

describe('ensureInventory resilience: a failed sync must never fail the request that triggered it', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('ensureInventoryProduction resolves (does not throw) even when every registered provider fails to sync', async () => {
    const { ensureInventoryProduction } = await import('../src/services/inventorySync');
    // The real guarantee: this call must resolve normally. Before the fix, the mocked adapter's
    // bad `categories` value made `prisma.provider.upsert` throw inside `syncProvider`, which
    // propagated all the way out here — exactly what broke Explore and the Crew-join trigger.
    await expect(ensureInventoryProduction('Resilience Test City')).resolves.toBeUndefined();
  });

  test('a page that reads Experience data right after a failed sync still gets a normal, empty result — never an error', async () => {
    const { ensureInventoryProduction } = await import('../src/services/inventorySync');
    const { prisma } = await import('../src/lib/prisma');

    await ensureInventoryProduction('Resilience Test City');
    // The sync failed and produced nothing — but reading afterwards must behave exactly like
    // "this city just has no inventory yet", not throw or hang.
    await expect(prisma.experience.count({ where: { venue: { city: 'Resilience Test City' } } })).resolves.toBe(0);
  });
});
