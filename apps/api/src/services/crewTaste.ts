import { prisma } from '../lib/prisma';
import { interestLabel, TASTE_INTEREST_INDEX } from '@plot/shared';

/**
 * "WHAT ARE WE USUALLY UP FOR?" — the Crew Taste surface (brief §Phase 8/13). Real, reported
 * design constraint from the brief: this must NOT be a naive average ("Sarah loves techno, Tom
 * hates clubs, Ben likes electronic music" should never resolve to "the average of that is
 * mid-enthusiasm techno clubbing"). Computed fresh on every read (same pattern
 * scoreExperiencesForCrew already uses for categoryAffinity — no cache to invalidate), from real
 * TasteProfile.interestAffinity rows, not fabricated or hand-authored.
 */
export interface CrewTasteInterest {
  interestId: string;
  label: string;
  /** How many members have a genuinely positive affinity for this — the actual "overlap" signal,
   *  not an average that a single strong negative could drag down without anyone noticing. */
  overlapCount: number;
  totalMembers: number;
  avgAffinity: number;
  /** At least one member loves it AND at least one member is firmly not into it — surfaced so the
   *  UI can show "mixed" rather than pretending a real disagreement doesn't exist. */
  hasConflict: boolean;
}

export interface CrewTasteSummary {
  memberCount: number;
  topInterests: CrewTasteInterest[];
  crewPreferenceInterestIds: string[]; // the Crew's own explicit picks, layered on top
}

export async function computeCrewTasteSummary(crewId: string): Promise<CrewTasteSummary> {
  const [members, settings] = await Promise.all([
    prisma.crewMember.findMany({ where: { crewId, status: 'ACTIVE' }, include: { user: { include: { tasteProfile: true } } } }),
    prisma.crewRecommendationSettings.findUnique({ where: { crewId }, select: { interestPreferences: true } }),
  ]);

  const affinities = members
    .map((m) => m.user.tasteProfile?.interestAffinity as Record<string, number> | undefined)
    .filter((a): a is Record<string, number> => Boolean(a));

  const allIds = new Set<string>();
  for (const a of affinities) for (const id of Object.keys(a)) if (TASTE_INTEREST_INDEX.has(id)) allIds.add(id);

  const rows: CrewTasteInterest[] = [];
  for (const id of allIds) {
    const values = affinities.map((a) => a[id] ?? 0);
    const overlapCount = values.filter((v) => v > 0.3).length;
    const avgAffinity = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    const hasConflict = values.some((v) => v >= 0.6) && values.some((v) => v <= -0.6);
    // Worth surfacing if real people are into it (overlap), even if one loud dissenter drags the
    // raw average down — overlap is the primary sort key, average only breaks ties.
    if (overlapCount > 0) rows.push({ interestId: id, label: interestLabel(id), overlapCount, totalMembers: members.length, avgAffinity, hasConflict });
  }

  rows.sort((a, b) => b.overlapCount - a.overlapCount || b.avgAffinity - a.avgAffinity);

  return {
    memberCount: members.length,
    topInterests: rows.slice(0, 10),
    crewPreferenceInterestIds: settings?.interestPreferences ?? [],
  };
}
