import { prisma } from '../lib/prisma';
import { track } from './analytics';
import type { EnergyLevel } from '@prisma/client';

export type SwipeChoice = 'yes' | 'maybe' | 'no';

export interface TasteSwipe {
  category: string;
  choice: SwipeChoice;
}

const CHOICE_WEIGHT: Record<SwipeChoice, number> = { yes: 1, maybe: 0.3, no: -1 };

/**
 * Builds a TasteProfile from onboarding swipes (brief §"Build my taste" — rapid yes/maybe/not
 * me reactions, not a checklist). This is intentionally the ONLY place a TasteProfile's
 * categoryAffinity is bulk-written; ongoing signals (saves, Rewind, votes) should nudge it
 * incrementally elsewhere rather than duplicating this logic — see TODO in services/match.ts
 * for where that incremental-update hook belongs once there's real usage to tune it against.
 */
export async function submitTasteSwipes(
  userId: string,
  swipes: TasteSwipe[],
  budget: { minMinor: number; maxMinor: number; currency: string },
  travelRadiusMeters: number,
  energyPreference: EnergyLevel,
): Promise<void> {
  const affinity: Record<string, number> = {};
  for (const swipe of swipes) {
    affinity[swipe.category] = CHOICE_WEIGHT[swipe.choice];
  }

  await prisma.tasteProfile.upsert({
    where: { userId },
    update: {
      categoryAffinity: affinity,
      budgetMinMinor: budget.minMinor,
      budgetMaxMinor: budget.maxMinor,
      currency: budget.currency,
      travelRadiusMeters,
      energyPreference,
    },
    create: {
      userId,
      categoryAffinity: affinity,
      budgetMinMinor: budget.minMinor,
      budgetMaxMinor: budget.maxMinor,
      currency: budget.currency,
      travelRadiusMeters,
      energyPreference,
    },
  });

  const yes = swipes.filter((s) => s.choice === 'yes').length;
  const maybe = swipes.filter((s) => s.choice === 'maybe').length;
  const no = swipes.filter((s) => s.choice === 'no').length;
  await track('TasteCompleted', { userId, cardsShown: swipes.length, yes, maybe, no }, { userId });
}

export async function setLocationPreferences(
  userId: string,
  prefs: { kind: 'HOME' | 'WORK' | 'FAVOURITE' | 'CITY'; label: string; latitude?: number; longitude?: number }[],
): Promise<void> {
  await prisma.$transaction([
    prisma.locationPreference.deleteMany({ where: { userId } }),
    prisma.locationPreference.createMany({
      data: prefs.map((p) => ({ userId, ...p })),
    }),
  ]);
}
