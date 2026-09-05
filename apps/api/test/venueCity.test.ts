import { beforeEach, describe, expect, test } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { resetDatabase } from './helpers/resetDb';
import { buildApp } from '../src/app';
import { syncProvider, backfillVenueCities } from '../src/services/inventorySync';
import { nearestPlaceName } from '../src/data/ukPlaces';
import type { ProviderAdapter, CanonicalListingInput } from '../src/providers/types';

/**
 * Real, live-reported bug: "I'm in Birmingham, filtered to this area, and it's showing me events
 * in Sheffield and Chester." Root cause (found by reading, not guessed): every live ticketed-
 * events provider deliberately searches well beyond the requested city — Ticketmaster 100km,
 * Skiddle ~104km, PredictHQ 40km — specifically so Explore's own radius-widening feature has real
 * inventory from one sync. That's legitimate. The bug was `syncProvider` stamping every one of
 * those real, farther-out results with the SYNCED city's name (`params.city`) instead of asking
 * where the venue actually is — so a genuine Sheffield venue turned up by a Birmingham-centred
 * search got mislabelled "Birmingham", and then trivially passed Explore's exact-city filter,
 * which trusts `venue.city` completely. Fixed by deriving `city` from the venue's own real
 * coordinates (`nearestPlaceName`) instead of the sync parameter — proved directly here, both for
 * new ingestion and for correcting rows already mislabelled in production.
 */
const app = buildApp();
const BIRMINGHAM = { name: 'Birmingham', lat: 52.4862, lng: -1.8904 };
const SHEFFIELD = { name: 'Sheffield', lat: 53.3811, lng: -1.4701 };

function fakeAdapter(canonical: () => CanonicalListingInput): ProviderAdapter {
  return {
    id: 'fake_venue_city_adapter',
    displayName: 'Fake venue-city test adapter',
    categories: ['LIVE_MUSIC'],
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
  name: 'A venue really in Sheffield',
  description: 'A real, live-reported bug fixture.',
  category: 'LIVE_MUSIC',
  subcategories: [],
  venueName: 'The Sheffield Test Venue',
  latitude: SHEFFIELD.lat,
  longitude: SHEFFIELD.lng,
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
  externalUrl: 'https://example.invalid/sheffield-venue',
  commissionEligible: false,
};

async function loginByEmail(email: string): Promise<string> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  return `${cookie.name}=${cookie.value}`;
}

describe('nearestPlaceName', () => {
  test('resolves real coordinates to the real nearest gazetteer city, not an arbitrary one', () => {
    expect(nearestPlaceName(SHEFFIELD.lat, SHEFFIELD.lng)).toBe('Sheffield');
    expect(nearestPlaceName(BIRMINGHAM.lat, BIRMINGHAM.lng)).toBe('Birmingham');
  });
});

describe('syncProvider labels a Venue by where it really is, not by which city synced it', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('a Birmingham-centred sync that legitimately returns a real Sheffield venue files it under Sheffield, not Birmingham', async () => {
    await syncProvider(fakeAdapter(() => BASE), { city: BIRMINGHAM.name, fromDate: new Date(), toDate: new Date(Date.now() + 30 * 86_400_000) });

    const venue = await prisma.venue.findFirst({ where: { name: 'The Sheffield Test Venue' } });
    expect(venue).not.toBeNull();
    expect(venue!.city).toBe('Sheffield'); // never 'Birmingham', even though that's what was synced
    expect(venue!.latitude).toBeCloseTo(SHEFFIELD.lat, 3);
  });

  test('Explore\'s own exact-city filter for Birmingham never surfaces that real Sheffield venue', async () => {
    await syncProvider(fakeAdapter(() => BASE), { city: BIRMINGHAM.name, fromDate: new Date(), toDate: new Date(Date.now() + 30 * 86_400_000) });
    const cookie = await loginByEmail('venue-city-explore@plot-test.invalid');

    const birminghamRes = await app.inject({ method: 'GET', url: `/explore/experiences?city=${encodeURIComponent(BIRMINGHAM.name)}`, headers: { cookie } });
    const birminghamBody = birminghamRes.json() as { experiences: { name: string }[] };
    expect(birminghamBody.experiences.some((e) => e.name === BASE.name)).toBe(false);

    // The same real venue IS honestly findable under the city it's actually in.
    const sheffieldRes = await app.inject({ method: 'GET', url: `/explore/experiences?city=${encodeURIComponent(SHEFFIELD.name)}`, headers: { cookie } });
    const sheffieldBody = sheffieldRes.json() as { experiences: { name: string }[] };
    expect(sheffieldBody.experiences.some((e) => e.name === BASE.name)).toBe(true);
  });
});

describe('backfillVenueCities corrects production rows already mislabelled before this fix shipped', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('a venue with real Sheffield coordinates but a stale "Birmingham" label gets corrected in place', async () => {
    const bad = await prisma.venue.create({
      data: { name: 'Legacy Mislabelled Venue', city: BIRMINGHAM.name, latitude: SHEFFIELD.lat, longitude: SHEFFIELD.lng },
    });

    const result = await backfillVenueCities();
    expect(result.corrected).toBe(1);
    expect(result.merged).toBe(0);

    const fixed = await prisma.venue.findUnique({ where: { id: bad.id } });
    expect(fixed!.city).toBe('Sheffield');
  });

  test('a second run is a real no-op — idempotent, never needs disabling', async () => {
    await prisma.venue.create({ data: { name: 'Legacy Mislabelled Venue 2', city: BIRMINGHAM.name, latitude: SHEFFIELD.lat, longitude: SHEFFIELD.lng } });
    await backfillVenueCities();
    const second = await backfillVenueCities();
    expect(second.corrected).toBe(0);
  });

  test('merges into an already-correct venue of the same name rather than leaving a duplicate', async () => {
    const correct = await prisma.venue.create({
      data: { name: 'Duplicated Venue', city: SHEFFIELD.name, latitude: SHEFFIELD.lat, longitude: SHEFFIELD.lng },
    });
    const stale = await prisma.venue.create({
      data: { name: 'Duplicated Venue', city: BIRMINGHAM.name, latitude: SHEFFIELD.lat, longitude: SHEFFIELD.lng },
    });
    const orphanExperience = await prisma.experience.create({
      data: {
        canonicalKey: 'duplicated-venue-stale-experience',
        name: 'Gig at the stale duplicate',
        description: 'Should end up pointing at the correct venue after the merge.',
        category: 'LIVE_MUSIC',
        subcategories: [],
        venueId: stale.id,
        startsAt: new Date(Date.now() + 86_400_000),
        qualityScore: 80,
        bookingStatus: 'AVAILABLE',
        tags: {},
      },
    });

    const result = await backfillVenueCities();
    expect(result.merged).toBe(1);

    const staleStillExists = await prisma.venue.findUnique({ where: { id: stale.id } });
    expect(staleStillExists).toBeNull();

    const movedExperience = await prisma.experience.findUnique({ where: { id: orphanExperience.id } });
    expect(movedExperience!.venueId).toBe(correct.id);
  });
});
