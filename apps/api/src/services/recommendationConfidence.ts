import type { MatchOption } from './match';
import { isTicketedEvent } from './opportunityIntent';

/**
 * Real, evidence-derived confidence for a Crew-facing recommendation — pilot-readiness brief's
 * own explicit ask: "communicate Plot's confidence honestly," never "score > arbitrary number =
 * GREAT FIT," and never customer-facing "confidence: HIGH" / "87% match" language (Part 20).
 * This file is the ONE place that decides the level; `crewRecommendations.ts` turns the level
 * into natural Plot-voiced copy, never raw numbers.
 *
 * Every threshold here is built on evidence `services/match.ts#scoreExperiencesForCrew` already
 * computes — a real taste-signal reason code, a real distance, a real ticket — never a fabricated
 * "vibe" score. `MIN_RECOMMENDATION_SCORE` is the SAME confidence floor
 * `crewRecommendations.ts#evaluateCrewEligibility` already gated automatic sends on before this
 * file existed — moved here so both "is this eligible at all" and "how confident are we" read
 * from one definition, not two that could drift.
 */

export type RecommendationConfidenceLevel = 'HIGH' | 'MEDIUM' | 'EXPLORATORY';

export interface ConfidenceResult {
  level: RecommendationConfidenceLevel;
  /** Internal audit trail only — never shown to a user; see this file's own header. */
  reasons: string[];
}

// The floor MEDIUM confidence (and therefore ordinary automatic-send eligibility) requires —
// unchanged from the pre-existing MIN_RECOMMENDATION_SCORE this replaces, just now named for
// what it actually represents.
export const MIN_RECOMMENDATION_SCORE = 55;
// A real, higher bar — not just "a bit above 55" picked arbitrarily: HIGH additionally requires
// a specific, named taste-signal reason (not just budget+distance+availability, which brief's
// own real-world regression already showed can clear 55+ with zero real taste evidence — see
// match.ts's own "category_affinity" comment). See deriveConfidence's own logic below.
export const HIGH_CONFIDENCE_SCORE = 72;
// The floor below which nothing is EVER sent, even as a labelled exploratory pick — "very
// little" wildcard space (Part 7), not "no floor at all". A real, ticketed, in-radius candidate
// that still can't clear even 40 genuinely isn't a defensible send under any framing.
export const EXPLORATION_MIN_SCORE = 40;

// The real, specific taste-signal reason codes match.ts's own scorer can produce — as opposed to
// budget/distance/availability/quality, which are real too but not evidence of TASTE fit on
// their own (see match.ts's own "category_affinity" bug-fix comment for the exact regression
// this distinction closes: budget+distance+availability alone cleared 55+ for a comedy-blind
// Crew on a sport event with zero real taste evidence).
const STRONG_TASTE_SIGNAL_CODES = new Set([
  'free_text_match',
  'interest_match',
  'crew_interest_preference',
  'crew_preference',
  'category_affinity',
  'crew_dna_match',
]);

function hasStrongTasteSignal(option: Pick<MatchOption, 'reasons'>): boolean {
  return option.reasons.some((r) => STRONG_TASTE_SIGNAL_CODES.has(r.code));
}

/**
 * The main classifier. `forceExploratory` lets `crewRecommendations.ts`'s own bounded
 * exploration path (see its own EXPLORATION_MIN_SCORE comment) label a genuinely sub-MEDIUM-
 * threshold candidate as EXPLORATORY explicitly, rather than this function silently inferring it
 * from score alone — the exploration DECISION (is this even eligible to be sent at all) lives in
 * crewRecommendations.ts, which has the weekly-cap/recency context this file doesn't; this
 * function only ever answers "given that decision, how should Plot talk about it".
 */
export function deriveConfidence(
  option: Pick<MatchOption, 'matchScore' | 'reasons' | 'experience'>,
  opts: { forceExploratory?: boolean } = {},
): ConfidenceResult {
  const reasons: string[] = [];
  if (opts.forceExploratory) {
    reasons.push('below_normal_threshold_but_defensible');
    return { level: 'EXPLORATORY', reasons };
  }

  const strongSignal = hasStrongTasteSignal(option);
  const ticketed = isTicketedEvent(option.experience);
  reasons.push(`score:${option.matchScore}`, `strongTasteSignal:${strongSignal}`, `ticketed:${ticketed}`);

  if (option.matchScore >= HIGH_CONFIDENCE_SCORE && strongSignal) {
    reasons.push('clears_high_bar_with_real_taste_signal');
    return { level: 'HIGH', reasons };
  }
  reasons.push('medium_by_default');
  return { level: 'MEDIUM', reasons };
}

/**
 * Natural, Plot-voiced copy — never "confidence: HIGH", never a percentage. Product spec's own
 * exact requested phrasing (Part 4), preserved verbatim where given. This is the lead-in used to
 * replace the generic "Plot found something your Crew might like" opener — see
 * crewRecommendations.ts's own use, layered UNDER the ticketed-fallback preface (a different,
 * more specific honesty signal — see TICKETED_FALLBACK_PREFACE's own comment).
 */
export function confidenceLeadIn(level: RecommendationConfidenceLevel): string {
  switch (level) {
    case 'HIGH':
      return 'We think this is a great fit for your Crew';
    case 'MEDIUM':
      return 'This might be one for the Crew';
    case 'EXPLORATORY':
      return "A little outside your usual picks — but this looked worth a shout";
  }
}
