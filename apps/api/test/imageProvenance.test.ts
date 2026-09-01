import { beforeEach, describe, expect, test } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { resetDatabase } from './helpers/resetDb';
import { syncProvider } from '../src/services/inventorySync';
import type { ProviderAdapter, CanonicalListingInput } from '../src/providers/types';

/**
 * Real, live-caught bug this proves fixed: spot-checking the actual dev database against this
 * exact session's own new OpenStreetMap/Wikipedia work turned up Experience rows still carrying
 * a `picsum.photos` stock-photo URL from a since-removed code path (see
 * providers/mock/ticketingProvider.ts's own comment on why that was dropped) — `imageUrl` was
 * create-only, so once a row existed with that URL, nothing could ever clear it, including a
 * resync from the now-honest provider correctly mapping to `imageUrl: null`. This is the fix,
 * tested directly against `syncProvider` with a fake adapter under full control of what two
 * consecutive syncs return — not dependent on any real provider's non-deterministic mock data.
 */
function fakeAdapter(canonical: () => CanonicalListingInput): ProviderAdapter {
  return {
    id: 'fake_test_adapter',
    displayName: 'Fake test adapter',
    categories: ['RESTAURANT'],
    isLive: true,
    async healthCheck() {
      return { status: 'ACTIVE' as const, checkedAt: new Date() };
    },
    async fetchListings() {
      return [{ externalId: 'fake-1', raw: {} }];
    },
    mapToCanonical: canonical,
  };
}

const BASE: CanonicalListingInput = {
  name: 'Stale Image Test Diner',
  description: 'A place.',
  category: 'RESTAURANT',
  subcategories: [],
  venueName: 'Stale Image Test Diner',
  latitude: 52.4862,
  longitude: -1.8904,
  startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  endsAt: null,
  timezone: 'Europe/London',
  priceMinMinor: null,
  priceMaxMinor: null,
  currency: 'GBP',
  bookingStatus: 'AVAILABLE',
  imageUrl: 'https://picsum.photos/seed/stale/640/480',
  imageSource: null,
  tags: {},
  externalUrl: 'https://example.invalid',
  commissionEligible: false,
};

describe('inventorySync: stale/stock image provenance', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('a second sync that maps to no image clears a previously-stored stock/stale imageUrl', async () => {
    await syncProvider(fakeAdapter(() => ({ ...BASE })), { city: 'Birmingham', fromDate: new Date(), toDate: new Date() });
    const afterFirst = await prisma.experience.findFirst({ where: { name: 'Stale Image Test Diner' } });
    expect(afterFirst?.imageUrl).toBe('https://picsum.photos/seed/stale/640/480');

    // Second sync: the (now-honest) provider maps to no image at all.
    await syncProvider(fakeAdapter(() => ({ ...BASE, imageUrl: null, imageSource: null })), { city: 'Birmingham', fromDate: new Date(), toDate: new Date() });
    const afterSecond = await prisma.experience.findFirst({ where: { name: 'Stale Image Test Diner' } });
    expect(afterSecond?.imageUrl).toBeNull();
    expect(afterSecond?.imageSource).toBeNull();
  });

  test('a manually-curated real photo (imageSource MANUAL) survives a later sync that finds no image', async () => {
    await syncProvider(fakeAdapter(() => ({ ...BASE, imageUrl: 'https://real-restaurant-site.example/photo.jpg', imageSource: 'MANUAL' })), {
      city: 'Birmingham',
      fromDate: new Date(),
      toDate: new Date(),
    });
    const afterFirst = await prisma.experience.findFirst({ where: { name: 'Stale Image Test Diner' } });
    expect(afterFirst?.imageSource).toBe('MANUAL');

    await syncProvider(fakeAdapter(() => ({ ...BASE, imageUrl: null, imageSource: null })), { city: 'Birmingham', fromDate: new Date(), toDate: new Date() });
    const afterSecond = await prisma.experience.findFirst({ where: { name: 'Stale Image Test Diner' } });
    expect(afterSecond?.imageUrl).toBe('https://real-restaurant-site.example/photo.jpg');
    expect(afterSecond?.imageSource).toBe('MANUAL');
  });

  test('a real provider image on a later sync always wins over whatever was there before', async () => {
    await syncProvider(fakeAdapter(() => ({ ...BASE })), { city: 'Birmingham', fromDate: new Date(), toDate: new Date() });
    await syncProvider(fakeAdapter(() => ({ ...BASE, imageUrl: 'https://real.example/new-photo.jpg', imageSource: 'OPENSTREETMAP' })), {
      city: 'Birmingham',
      fromDate: new Date(),
      toDate: new Date(),
    });
    const result = await prisma.experience.findFirst({ where: { name: 'Stale Image Test Diner' } });
    expect(result?.imageUrl).toBe('https://real.example/new-photo.jpg');
    expect(result?.imageSource).toBe('OPENSTREETMAP');
  });
});
