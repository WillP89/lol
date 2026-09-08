import { describe, expect, test } from 'vitest';
import { deriveConfidence, confidenceLeadIn, HIGH_CONFIDENCE_SCORE, MIN_RECOMMENDATION_SCORE } from '../../src/services/recommendationConfidence';
import type { Experience } from '@prisma/client';

/**
 * Unit tests for the real, evidence-derived three-tier confidence model (pilot-readiness brief
 * Parts 4-6). Every case here mirrors a real product scenario, not an arbitrary score boundary —
 * see recommendationConfidence.ts's own header for why HIGH requires a strong taste signal on
 * top of the score, not score alone.
 */

function fakeExperience(overrides: Partial<Experience> = {}): Experience {
  return {
    id: 'exp-1',
    canonicalKey: 'exp-1',
    name: 'Test Experience',
    description: 'A real test fixture.',
    category: 'LIVE_MUSIC',
    subcategories: [],
    venueId: 'venue-1',
    startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    endsAt: null,
    timezone: 'Europe/London',
    qualityScore: 80,
    bookingStatus: 'AVAILABLE',
    priceMinMinor: 2000,
    priceMaxMinor: 3500,
    currency: 'GBP',
    imageUrl: null,
    imageSource: null,
    tags: { provider: 'ticketmaster' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Experience;
}

describe('deriveConfidence', () => {
  test('a high score WITH a real taste-signal reason is HIGH confidence', () => {
    const result = deriveConfidence({
      matchScore: HIGH_CONFIDENCE_SCORE + 5,
      reasons: [{ code: 'interest_match', label: '2/2 of you are into UK garage' }],
      experience: fakeExperience(),
    });
    expect(result.level).toBe('HIGH');
  });

  test('a high score WITHOUT any real taste-signal reason is only MEDIUM — the real regression this closes: budget+distance+availability alone can clear the high bar with zero taste evidence', () => {
    const result = deriveConfidence({
      matchScore: HIGH_CONFIDENCE_SCORE + 5,
      reasons: [
        { code: 'nearby', label: '3 miles away' },
        { code: 'under_budget', label: 'Under your typical spend' },
        { code: 'high_availability', label: 'Everyone is free' },
      ],
      experience: fakeExperience(),
    });
    expect(result.level).toBe('MEDIUM');
  });

  test('a score at or above the eligibility floor but below the HIGH bar is MEDIUM, even with a strong taste signal', () => {
    const result = deriveConfidence({
      matchScore: MIN_RECOMMENDATION_SCORE + 2,
      reasons: [{ code: 'free_text_match', label: 'You said "UK Garage"' }],
      experience: fakeExperience(),
    });
    expect(result.level).toBe('MEDIUM');
  });

  test('forceExploratory always returns EXPLORATORY regardless of score/reasons — the decision lives in crewRecommendations.ts, not here', () => {
    const result = deriveConfidence(
      { matchScore: 20, reasons: [], experience: fakeExperience() },
      { forceExploratory: true },
    );
    expect(result.level).toBe('EXPLORATORY');
  });

  test('reasons carry an internal audit trail but never leak into user-facing copy (confidenceLeadIn takes only the level)', () => {
    const result = deriveConfidence({
      matchScore: HIGH_CONFIDENCE_SCORE + 5,
      reasons: [{ code: 'interest_match', label: 'x' }],
      experience: fakeExperience(),
    });
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.join(' ')).not.toMatch(/\d+%/); // never a percentage
  });
});

describe('confidenceLeadIn', () => {
  test('every level has natural, non-technical, Plot-voiced copy — never "confidence: X", never a percentage, never "AI"', () => {
    for (const level of ['HIGH', 'MEDIUM', 'EXPLORATORY'] as const) {
      const copy = confidenceLeadIn(level);
      expect(copy.length).toBeGreaterThan(0);
      expect(copy.toLowerCase()).not.toContain('confidence');
      expect(copy.toLowerCase()).not.toContain('ai ');
      expect(copy).not.toMatch(/\d+%/);
      expect(copy).not.toMatch(/vector/i);
    }
  });

  test('HIGH and MEDIUM and EXPLORATORY are three genuinely distinct strings', () => {
    const copies = new Set((['HIGH', 'MEDIUM', 'EXPLORATORY'] as const).map(confidenceLeadIn));
    expect(copies.size).toBe(3);
  });
});
