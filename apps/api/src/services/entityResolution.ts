import type { CanonicalListingInput } from '../providers/types';

/**
 * Deduplication (brief §44). The same gig can arrive from DICE, RA and the venue's own site;
 * Plot must show it once.
 *
 * This is a deliberately simple two-stage heuristic, not ML-based entity resolution:
 *
 *  1. `canonicalKey` — a deterministic key (normalised name + venue + date) catches the exact-
 *     duplicate case cheaply, with no similarity computation, and is what the DB unique
 *     constraint on `Experience.canonicalKey` enforces.
 *  2. `similarityScore` — a cheap token-overlap heuristic for near-duplicates ("Fred again.."
 *     vs "Fred again.. (Live)") that DON'T share a canonicalKey. Below
 *     AUTO_MERGE_THRESHOLD we do NOT auto-merge — we create a separate Experience and flag it
 *     for human review (brief §44 "human review when confidence is low") rather than risk
 *     silently merging two different things.
 *
 * The honest limitation, written down rather than hidden: this will under-merge listings whose
 * names genuinely differ a lot (a venue's internal event name vs. an aggregator's marketing
 * title) and over-merge coincidental near-matches at small venues. Replacing step 2 with an
 * embedding-similarity model is the correct fix once there's enough real multi-provider
 * overlap to justify it — see docs/DECISIONS.md#entity-resolution.
 */

const AUTO_MERGE_THRESHOLD = 0.82;

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildCanonicalKey(input: CanonicalListingInput): string {
  const day = input.startsAt.toISOString().slice(0, 10);
  return `${normalise(input.name)}::${normalise(input.venueName)}::${day}`;
}

/** Token-overlap (Jaccard on word sets) — cheap, dependency-free, good enough to flag review candidates. */
export function similarityScore(a: string, b: string): number {
  const tokensA = new Set(normalise(a).split(' ').filter(Boolean));
  const tokensB = new Set(normalise(b).split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function shouldAutoMerge(a: string, b: string): boolean {
  return similarityScore(a, b) >= AUTO_MERGE_THRESHOLD;
}
