import { describe, expect, test } from 'vitest';
import { buildCanonicalKey, similarityScore, shouldAutoMerge, normalise, dedupeNearDuplicates } from '../../src/services/entityResolution';
import type { CanonicalListingInput } from '../../src/providers/types';

function fakeInput(overrides: Partial<CanonicalListingInput> = {}): CanonicalListingInput {
  return {
    name: 'Fred again..',
    description: '',
    category: 'CLUBBING',
    subcategories: [],
    venueName: 'Drumsheds',
    latitude: 51.6,
    longitude: -0.07,
    startsAt: new Date('2026-09-12T20:00:00Z'),
    endsAt: null,
    timezone: 'Europe/London',
    priceMinMinor: null,
    priceMaxMinor: null,
    currency: 'GBP',
    bookingStatus: 'AVAILABLE',
    imageUrl: null,
    imageSource: null,
    tags: {},
    externalUrl: 'https://example.invalid',
    commissionEligible: false,
    ...overrides,
  };
}

describe('entity resolution', () => {
  test('identical listings from two different providers produce the same canonical key', () => {
    const a = buildCanonicalKey(fakeInput());
    const b = buildCanonicalKey(fakeInput({ description: 'a totally different description' }));
    expect(a).toBe(b);
  });

  test('a different date produces a different canonical key', () => {
    const a = buildCanonicalKey(fakeInput());
    const b = buildCanonicalKey(fakeInput({ startsAt: new Date('2026-09-13T20:00:00Z') }));
    expect(a).not.toBe(b);
  });

  test('normalise strips punctuation and case', () => {
    expect(normalise('Fred again..')).toBe('fred again');
  });

  test('near-duplicate names score highly similar', () => {
    const score = similarityScore('Fred again..', 'Fred again.. (Live)');
    expect(score).toBeGreaterThan(0.4);
  });

  test('unrelated names auto-merge is rejected', () => {
    expect(shouldAutoMerge('Fred again..', 'Bicep at Fabric')).toBe(false);
  });

  test('exact name match auto-merges', () => {
    expect(shouldAutoMerge('Fred again..', 'Fred again..')).toBe(true);
  });
});

/**
 * The runtime suppression layer — the actual reported bug ("Jorja Smith DJ Set" shown twice,
 * different dates, same venue family) never collided on canonicalKey, so this is what fixes it.
 */
describe('dedupeNearDuplicates: the actual "Jorja Smith DJ Set" bug', () => {
  type Item = { id: string; name: string; category: string; startsAt: Date };
  const getFields = (i: Item) => i;

  test('same name, same category, one day apart — collapsed to one', () => {
    const items: Item[] = [
      { id: 'stafford', name: 'Jorja Smith DJ Set', category: 'LIVE_MUSIC', startsAt: new Date('2026-09-11T20:00:00Z') },
      { id: 'stone', name: 'Jorja Smith DJ Set', category: 'LIVE_MUSIC', startsAt: new Date('2026-09-12T20:00:00Z') },
    ];
    const result = dedupeNearDuplicates(items, getFields);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('stafford'); // first-in-order (best-ranked/soonest) survives
  });

  test('genuinely different events with different names are both kept', () => {
    const items: Item[] = [
      { id: 'a', name: 'Fred again..', category: 'CLUBBING', startsAt: new Date('2026-09-11T20:00:00Z') },
      { id: 'b', name: 'Bicep', category: 'CLUBBING', startsAt: new Date('2026-09-12T20:00:00Z') },
    ];
    expect(dedupeNearDuplicates(items, getFields)).toHaveLength(2);
  });

  test('same name but different category is not treated as a duplicate (e.g. a namesake)', () => {
    const items: Item[] = [
      { id: 'a', name: 'New Material Night', category: 'COMEDY', startsAt: new Date('2026-09-11T20:00:00Z') },
      { id: 'b', name: 'New Material Night', category: 'LIVE_MUSIC', startsAt: new Date('2026-09-12T20:00:00Z') },
    ];
    expect(dedupeNearDuplicates(items, getFields)).toHaveLength(2);
  });

  test('same name but more than 3 days apart is not treated as a duplicate — a real recurring night', () => {
    const items: Item[] = [
      { id: 'a', name: 'Saturday Night Stand-Up Social', category: 'COMEDY', startsAt: new Date('2026-09-05T20:00:00Z') },
      { id: 'b', name: 'Saturday Night Stand-Up Social', category: 'COMEDY', startsAt: new Date('2026-09-19T20:00:00Z') },
    ];
    expect(dedupeNearDuplicates(items, getFields)).toHaveLength(2);
  });

  test('a cluster of three near-duplicates collapses to one, keeping the first', () => {
    const items: Item[] = [
      { id: 'a', name: 'Jorja Smith DJ Set', category: 'LIVE_MUSIC', startsAt: new Date('2026-09-11T20:00:00Z') },
      { id: 'b', name: 'Jorja Smith DJ Set', category: 'LIVE_MUSIC', startsAt: new Date('2026-09-12T20:00:00Z') },
      { id: 'c', name: 'Jorja Smith DJ Set', category: 'LIVE_MUSIC', startsAt: new Date('2026-09-13T20:00:00Z') },
    ];
    const result = dedupeNearDuplicates(items, getFields);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });
});
