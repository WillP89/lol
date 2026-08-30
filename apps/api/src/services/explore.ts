import { prisma } from '../lib/prisma';
import { MIN_PUBLISHABLE_QUALITY_SCORE } from './qualityScoring';
import { ensureInventory } from './inventorySync';

const EXPLORE_WINDOW_DAYS = 21;
const EXPLORE_LIMIT = 200;

/**
 * Backs the real Explore/map view — every result has real venue coordinates (see
 * `Venue.latitude`/`longitude`), unlike the CSS-drawn map in the founding-team demo. Same
 * quality/booking-status/date-window constraints as `findUsSomething`'s Layer 1, minus the
 * crew-specific scoring — this is a browse view, not a recommendation.
 */
export async function listExploreExperiences(city: string) {
  await ensureInventory(city);

  const windowStart = new Date();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + EXPLORE_WINDOW_DAYS);

  return prisma.experience.findMany({
    where: {
      qualityScore: { gte: MIN_PUBLISHABLE_QUALITY_SCORE },
      bookingStatus: { not: 'SOLD_OUT' },
      startsAt: { gte: windowStart, lte: windowEnd },
      venue: { city },
    },
    include: { venue: true },
    orderBy: { startsAt: 'asc' },
    take: EXPLORE_LIMIT,
  });
}
