import { prisma } from '../lib/prisma';
import { tryDeriveAndApplyCrewPreferences } from './crewTasteDerivation';

/**
 * Real, live product requirement: "Before creating a crew, one person must fill out the crew's
 * specific preferences using the AI generated or personal selection, this then defines the
 * group's preferences... no events or things should be done on crew until preference set" —
 * explicitly NOT derived/averaged from individual members (CrewRecommendationSettings
 * .categoryPreferences/.interestPreferences are the Crew's OWN picks, set once by whoever
 * created it, stamped onto .preferencesSetAt — see that field's own schema comment). Thrown by
 * both member-triggered flows (services/match.ts#findUsSomething, which suggestToCrewChat calls
 * through) so nothing — automatic sweep or manual request alike — can act on a Crew before that
 * moment. Editable afterwards ("you can tailor it after and change") — this only ever gates the
 * FIRST time, never subsequent edits.
 */
export class CrewPreferencesNotSetError extends Error {
  constructor(public crewId: string) {
    super("This Crew's preferences haven't been set yet — set them before Plot can find or suggest anything.");
    this.name = 'CrewPreferencesNotSetError';
  }
}

/**
 * A standalone module rather than a call into services/crewRecommendations.ts directly: that
 * module already imports scoreExperiencesForCrew from services/match.ts, so match.ts importing
 * back from it would be a circular import. This only ever reads the one settings column both
 * sides need to agree on.
 */
export async function assertCrewPreferencesSet(crewId: string): Promise<void> {
  const settings = await prisma.crewRecommendationSettings.findUnique({
    where: { crewId },
    select: { preferencesSetAt: true },
  });
  if (settings?.preferencesSetAt) return;

  // Real gap this closes: a member manually tapping "Find us something" used to hit the exact
  // same hard wall the automatic sweep did, even in cases the sweep could (and now does) safely
  // resolve on its own — see services/crewTasteDerivation.ts#tryDeriveAndApplyCrewPreferences's
  // own comment. A manual request gets the same self-healing chance before it's told to go set
  // something up by hand.
  const derived = await tryDeriveAndApplyCrewPreferences(crewId);
  if (derived) return;

  throw new CrewPreferencesNotSetError(crewId);
}
