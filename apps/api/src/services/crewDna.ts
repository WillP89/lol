import { prisma } from '../lib/prisma';
import type { DnaConfidence, PlanningPersonality } from '@prisma/client';

/**
 * Group DNA is derived, never hand-authored — see brief §12 "do not fake confidence." A
 * brand-new Crew gets `confidence: LOW` and generic top categories; it only becomes a
 * genuinely useful signal once the crew has real history. This function is the one place
 * that's allowed to write a `CrewDNA` row; nothing else touches that table directly.
 *
 * Confidence bands (deliberately simple, documented so they can be tuned against real pilot
 * data rather than treated as arbitrary):
 *  - LOW:    < 3 completed plans for this crew — DNA is just an average of individual tastes.
 *  - MEDIUM: 3-7 completed plans — enough to start trusting category/spend patterns.
 *  - HIGH:   8+ completed plans — enough for the Match engine to weight CrewDNA over
 *            individual TasteProfiles when they disagree.
 */
export async function computeCrewDna(crewId: string): Promise<void> {
  const members = await prisma.crewMember.findMany({
    where: { crewId, status: 'ACTIVE' },
    include: { user: { include: { tasteProfile: true } } },
  });

  const tasteProfiles = members.map((m) => m.user.tasteProfile).filter(Boolean) as NonNullable<
    (typeof members)[number]['user']['tasteProfile']
  >[];

  const completedPlanCount = await prisma.plan.count({ where: { crewId, status: 'COMPLETED' } });
  const confidence: DnaConfidence = completedPlanCount >= 8 ? 'HIGH' : completedPlanCount >= 3 ? 'MEDIUM' : 'LOW';

  const categoryTotals = new Map<string, number>();
  let spendSum = 0;
  let spendCount = 0;

  for (const tp of tasteProfiles) {
    const affinity = tp.categoryAffinity as Record<string, number>;
    for (const [category, score] of Object.entries(affinity)) {
      if (score > 0) categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + score);
    }
    if (tp.budgetMaxMinor > 0) {
      spendSum += (tp.budgetMinMinor + tp.budgetMaxMinor) / 2;
      spendCount += 1;
    }
  }

  const topCategories = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([category]) => category);

  const medianSpendMinor = spendCount > 0 ? Math.round(spendSum / spendCount) : 0;

  // Best nights / usual areas / planning personality: from completed-plan history once it
  // exists, falling back to sane defaults for a fresh crew (Fri/Sat is the honest generic
  // prior for UK social plans; see docs/DECISIONS.md#cold-start-defaults).
  const completedPlans = await prisma.plan.findMany({
    where: { crewId, status: 'COMPLETED' },
    include: { experience: { include: { venue: true } } },
  });

  const dayCounts = new Map<string, number>();
  const areaCounts = new Map<string, number>();
  const leadTimes: number[] = [];

  for (const plan of completedPlans) {
    if (!plan.experience) continue;
    const day = plan.experience.startsAt.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase();
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    if (plan.experience.venue) {
      areaCounts.set(plan.experience.venue.city, (areaCounts.get(plan.experience.venue.city) ?? 0) + 1);
    }
    leadTimes.push((plan.experience.startsAt.getTime() - plan.createdAt.getTime()) / (1000 * 60 * 60 * 24));
  }

  const bestNights = dayCounts.size
    ? [...dayCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => d)
    : ['FRI', 'SAT'];

  const usualAreas = areaCounts.size
    ? [...areaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a)
    : [];

  const avgLeadDays = leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null;
  const planningPersonality: PlanningPersonality =
    avgLeadDays === null ? 'MIXED' : avgLeadDays <= 3 ? 'LAST_MINUTE' : avgLeadDays >= 10 ? 'PLANNER' : 'MIXED';

  await prisma.crewDNA.upsert({
    where: { crewId },
    update: {
      confidence,
      topCategories,
      medianSpendMinor,
      bestNights,
      usualAreas,
      planningPersonality,
      computedAt: new Date(),
    },
    create: {
      crewId,
      confidence,
      topCategories,
      medianSpendMinor,
      bestNights,
      usualAreas,
      planningPersonality,
    },
  });
}
