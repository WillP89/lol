import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { providerRegistry } from '../providers/registry';
import type { ProviderAdapter } from '../providers/types';
import { buildCanonicalKey } from './entityResolution';
import { computeQualityScore } from './qualityScoring';
import { UK_FALLBACK_CENTER } from '../data/ukPlaces';

/**
 * Runs one provider end-to-end: fetch -> map -> dedup -> quality-score -> upsert. Every
 * listing is handled independently (brief §42/#44) — one malformed record from a provider
 * logs and continues rather than failing the whole sync, and one provider throwing during
 * fetch marks itself DEGRADED/DOWN without touching the others.
 */
export async function syncProvider(
  adapter: ProviderAdapter,
  params: { city: string; fromDate: Date; toDate: Date },
): Promise<{ providerId: string; fetched: number; upserted: number; failed: number }> {
  await prisma.provider.upsert({
    where: { id: adapter.id },
    update: { name: adapter.displayName, categories: adapter.categories },
    create: { id: adapter.id, name: adapter.displayName, categories: adapter.categories },
  });

  let listings: Awaited<ReturnType<ProviderAdapter['fetchListings']>>;
  try {
    listings = await adapter.fetchListings(params);
  } catch (err) {
    logger.error({ err, provider: adapter.id }, 'Provider fetch failed — marking DOWN');
    await prisma.provider.update({
      where: { id: adapter.id },
      data: { status: 'DOWN', lastError: String(err), lastHealthCheckAt: new Date() },
    });
    return { providerId: adapter.id, fetched: 0, upserted: 0, failed: 0 };
  }

  let upserted = 0;
  let failed = 0;

  for (const listing of listings) {
    try {
      const canonicalInput = adapter.mapToCanonical(listing);
      const canonicalKey = buildCanonicalKey(canonicalInput);
      const now = new Date();
      const qualityScore = computeQualityScore(canonicalInput, now);

      // Venue has no natural unique key in the schema beyond id (two venues can share a name
      // in different cities), so we look up by name+city and create on miss rather than
      // misusing `upsert` against a synthetic id — see docs/DECISIONS.md#venue-identity.
      const existingVenue = await prisma.venue.findFirst({
        where: { name: canonicalInput.venueName, city: params.city },
      });
      const venue =
        existingVenue ??
        (await prisma.venue.create({
          data: {
            name: canonicalInput.venueName,
            latitude: canonicalInput.latitude,
            longitude: canonicalInput.longitude,
            city: params.city,
          },
        }));

      const experience = await prisma.experience.upsert({
        where: { canonicalKey },
        update: {
          name: canonicalInput.name,
          description: canonicalInput.description,
          bookingStatus: canonicalInput.bookingStatus,
          priceMinMinor: canonicalInput.priceMinMinor,
          priceMaxMinor: canonicalInput.priceMaxMinor,
          qualityScore,
          tags: canonicalInput.tags as Prisma.InputJsonValue,
          updatedAt: now,
        },
        create: {
          canonicalKey,
          name: canonicalInput.name,
          description: canonicalInput.description,
          category: canonicalInput.category,
          subcategories: canonicalInput.subcategories,
          venueId: venue.id,
          startsAt: canonicalInput.startsAt,
          endsAt: canonicalInput.endsAt,
          timezone: canonicalInput.timezone,
          priceMinMinor: canonicalInput.priceMinMinor,
          priceMaxMinor: canonicalInput.priceMaxMinor,
          currency: canonicalInput.currency,
          bookingStatus: canonicalInput.bookingStatus,
          imageUrl: canonicalInput.imageUrl,
          tags: canonicalInput.tags as Prisma.InputJsonValue,
          qualityScore,
        },
      });

      await prisma.providerListing.upsert({
        where: { providerId_providerListingId: { providerId: adapter.id, providerListingId: listing.externalId } },
        update: { experienceId: experience.id, rawPayload: listing.raw as Prisma.InputJsonValue, lastRefreshedAt: now },
        create: {
          providerId: adapter.id,
          providerListingId: listing.externalId,
          experienceId: experience.id,
          rawPayload: listing.raw as Prisma.InputJsonValue,
          externalUrl: canonicalInput.externalUrl,
          commissionEligible: canonicalInput.commissionEligible,
          lastRefreshedAt: now,
        },
      });

      upserted += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, provider: adapter.id, externalId: listing.externalId }, 'Failed to upsert listing');
    }
  }

  await prisma.provider.update({
    where: { id: adapter.id },
    data: { status: failed === 0 ? 'ACTIVE' : 'DEGRADED', lastHealthCheckAt: new Date(), lastError: null },
  });

  return { providerId: adapter.id, fetched: listings.length, upserted, failed };
}

export async function syncAllProviders(city = UK_FALLBACK_CENTER.name): Promise<Awaited<ReturnType<typeof syncProvider>>[]> {
  const fromDate = new Date();
  const toDate = new Date();
  toDate.setDate(toDate.getDate() + 60);

  const results: Awaited<ReturnType<typeof syncProvider>>[] = [];
  for (const adapter of providerRegistry) {
    results.push(await syncProvider(adapter, { city, fromDate, toDate }));
  }
  return results;
}

/**
 * Nothing in this codebase runs `syncProvider` on a schedule (see `POST /admin/sync` for the
 * manual trigger docs/PILOT.md assumes an operator runs periodically) — so a fresh database
 * has zero Experience rows and Match/the map silently return empty. Since the registered
 * providers are all in-memory mocks (no real API cost, no rate limit), it's safe and cheap to
 * self-heal on demand: call this before reading Experience data for a city and it syncs once
 * if that city looks unseeded. Real provider adapters should keep going through the scheduled
 * `/admin/sync` path instead — this guard exists for the pilot's zero-ops mock-data path.
 */
export async function ensureInventory(city: string): Promise<void> {
  const count = await prisma.experience.count({ where: { venue: { city } } });
  if (count === 0) {
    await syncAllProviders(city);
  }
}
