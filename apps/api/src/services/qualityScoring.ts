import type { CanonicalListingInput } from '../providers/types';

/**
 * Quality score (brief §5 "a huge catalogue full of rubbish will destroy the recommendation
 * experience"). This does NOT decide what a user likes — that's the Match engine's job. It
 * decides whether an Experience is fit to be shown at all: complete, current, priced,
 * bookable. A perfect Match-score result with a 20/100 quality score (no price, starts
 * yesterday, no venue coordinates) should never reach a user.
 *
 * Inputs deliberately kept to things we can compute from the canonical record itself, plus
 * freshness. Popularity/booking-conversion/cancellation-history inputs from the brief's fuller
 * list are real signals but need real usage volume to mean anything — see
 * docs/DECISIONS.md#quality-scoring for the staged plan.
 */
export function computeQualityScore(input: CanonicalListingInput, lastRefreshedAt: Date): number {
  let score = 0;

  // Completeness (70 pts). Deliberately scores only fields that genuinely vary in quality
  // across real provider data (description, image, price, tag richness). Latitude/longitude
  // are NOT scored here even though the brief lists them — CanonicalListingInput requires them
  // as non-null numbers, so they're structurally always "complete" and would be dead weight
  // in this formula; see docs/DECISIONS.md#quality-scoring.
  if (input.description && input.description.length > 10) score += 20;
  if (input.imageUrl) score += 20;
  if (input.priceMinMinor !== null && input.priceMaxMinor !== null) score += 20;
  if (Object.keys(input.tags).length >= 2) score += 10;

  // Validity (15 pts) and Freshness (15 pts) are necessary but NOT sufficient — capped so that
  // a listing with zero completeness can never cross MIN_PUBLISHABLE_QUALITY_SCORE on
  // "technically valid and recently fetched" alone. A blank record with a real future date is
  // still not something we should show a group deciding what to do together.
  const now = Date.now();
  if (input.startsAt.getTime() > now) score += 8;
  if (input.bookingStatus !== 'SOLD_OUT') score += 7;

  const hoursSinceRefresh = (now - lastRefreshedAt.getTime()) / (1000 * 60 * 60);
  score += Math.max(0, 15 - hoursSinceRefresh * (15 / 48));

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Minimum score to be eligible for Match at all — see services/match.ts Layer 1. */
export const MIN_PUBLISHABLE_QUALITY_SCORE = 40;
