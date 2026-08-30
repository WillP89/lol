import { describe, expect, test } from 'vitest';
import { buildCanonicalKey, similarityScore, shouldAutoMerge, normalise } from '../../src/services/entityResolution';
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
