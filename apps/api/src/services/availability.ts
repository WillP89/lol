import { prisma } from '../lib/prisma';

/**
 * Free/busy only — see prisma schema comment (3) and docs/PRIVACY.md. This is the one place
 * that reads AvailabilityWindow rows; both the Match engine and the Crew-detail "everyone's
 * evening" strip call through here so there's one definition of "free."
 *
 * A member with NO availability data at all (never connected a calendar, never set manual
 * availability) is treated as available-unknown, not busy — see brief §8 "never make the
 * product unusable because somebody does not want calendar access." Unknown counts toward
 * `availableMemberCount` optimistically; the UI can distinguish "confirmed free" from
 * "no data" if it wants to, but Match must not penalise a crew for incomplete calendar data.
 */
export async function getMemberAvailability(
  userIds: string[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<string, boolean>> {
  const busyWindows = await prisma.availabilityWindow.findMany({
    where: {
      userId: { in: userIds },
      busy: true,
      startsAt: { lt: windowEnd },
      endsAt: { gt: windowStart },
    },
    select: { userId: true },
  });

  const busyUserIds = new Set(busyWindows.map((w) => w.userId));
  const result = new Map<string, boolean>();
  for (const userId of userIds) {
    result.set(userId, !busyUserIds.has(userId)); // true = available (incl. unknown)
  }
  return result;
}

export interface DayAvailability {
  day: string; // 'THU', 'FRI', ...
  date: string; // ISO date
  freeCount: number;
  totalMembers: number;
}

export async function getCrewAvailabilityByDay(crewId: string, daysAhead: number[]): Promise<DayAvailability[]> {
  const members = await prisma.crewMember.findMany({ where: { crewId, status: 'ACTIVE' }, select: { userId: true } });
  const userIds = members.map((m) => m.userId);
  if (userIds.length === 0) return [];

  const results: DayAvailability[] = [];
  for (const offset of daysAhead) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    const evening = new Date(date);
    evening.setHours(18, 0, 0, 0);
    const lateNight = new Date(date);
    lateNight.setHours(23, 59, 59, 0);

    const availability = await getMemberAvailability(userIds, evening, lateNight);
    const freeCount = [...availability.values()].filter(Boolean).length;

    results.push({
      day: evening.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase(),
      date: evening.toISOString().slice(0, 10),
      freeCount,
      totalMembers: userIds.length,
    });
  }
  return results;
}
