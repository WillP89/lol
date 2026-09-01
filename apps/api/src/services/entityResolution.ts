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

// A near-duplicate cluster (same fictional DJ set at the "same" venue two days apart, from two
// city aliases that resolved to two different Venue rows) is still recognisably the same thing to
// a human looking at two cards side by side — this is the window within which "same name, same
// category" gets treated as one option rather than two.
const NEAR_DUPLICATE_WINDOW_DAYS = 3;

/**
 * Runtime near-duplicate suppression — the counterpart `similarityScore`/`shouldAutoMerge` were
 * missing. Before this, both functions existed only as ingestion-time heuristics that nothing
 * ever called: `buildCanonicalKey`'s unique constraint was the only dedup that actually ran, and
 * it only catches SAME-DAY exact matches. Root-caused via the actual reported bug (two "Jorja
 * Smith DJ Set" cards, different dates): `defaultCity` values "Stafford" and "Stone" both alias to
 * the same STAFFORDSHIRE_VENUES set (providers/mock/ticketingProvider.ts), but `ensureInventory`
 * self-heals per literal city string on first use — each alias gets its own Venue row (Venue
 * identity is name+city) and its own Experience row (canonicalKey includes the day, and the mock
 * provider's "daysOut" is relative to whichever wall-clock day each city's sync happened to run
 * on). `scoreExperiencesForCrew`'s candidate query has no city filter — by design, so a crew can
 * still see worth-travelling-for options further out — so both rows end up as separate-looking
 * options for the same crew.
 *
 * This isn't only a mock-data quirk: the exact same shape of problem happens with a real gig
 * listed by two real providers under slightly different names or a day apart. The general fix
 * lives here, at the point results are about to be shown, not just at ingestion: collapse
 * same-category, similar-name, near-in-time items down to the single best-ranked (i.e. first, in
 * whatever order the caller already sorted by) representative.
 */
export function dedupeNearDuplicates<T>(
  items: T[],
  getFields: (item: T) => { name: string; category: string; startsAt: Date },
): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const fields = getFields(item);
    const isDuplicate = kept.some((existing) => {
      const existingFields = getFields(existing);
      if (existingFields.category !== fields.category) return false;
      const daysApart = Math.abs(fields.startsAt.getTime() - existingFields.startsAt.getTime()) / 86_400_000;
      if (daysApart > NEAR_DUPLICATE_WINDOW_DAYS) return false;
      return shouldAutoMerge(fields.name, existingFields.name);
    });
    if (!isDuplicate) kept.push(item);
  }
  return kept;
}
