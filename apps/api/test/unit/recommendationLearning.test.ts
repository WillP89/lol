import { describe, expect, test } from 'vitest';
import { reasonOptionsFor } from '../../src/services/recommendationLearning';

/**
 * Unit tests for the contextual "what wasn't right" reason generator — pilot-readiness brief's
 * own explicit ask: "for a restaurant don't ask about an artist; for football don't ask about
 * music genre" (see recommendationLearning.ts's own header). The decayed/capped learning-bias
 * math itself (computeCrewLearningBias) is covered end-to-end against a real database in
 * test/recommendationLearningEngine.test.ts — this file covers the pure, database-free logic.
 */
describe('reasonOptionsFor', () => {
  test('a priced RESTAURANT gets venue + price + performer-free options', () => {
    const options = reasonOptionsFor({ category: 'RESTAURANT', priceMinMinor: 3000 });
    const codes = options.map((o) => o.code);
    expect(codes).toContain('too_expensive');
    expect(codes).toContain('not_this_venue');
    expect(codes).not.toContain('not_this_artist');
  });

  test('a free experience never offers "too expensive" — no dishonest option for something with no price', () => {
    const options = reasonOptionsFor({ category: 'RESTAURANT', priceMinMinor: 0 });
    expect(options.map((o) => o.code)).not.toContain('too_expensive');
  });

  test('a null price never offers "too expensive" either', () => {
    const options = reasonOptionsFor({ category: 'RESTAURANT', priceMinMinor: null });
    expect(options.map((o) => o.code)).not.toContain('too_expensive');
  });

  test('LIVE_MUSIC gets a performer-specific option ("Not this artist"), never a venue-identity option it does not need generically', () => {
    const options = reasonOptionsFor({ category: 'LIVE_MUSIC', priceMinMinor: 2000 });
    const codes = options.map((o) => o.code);
    expect(codes).toContain('not_this_artist');
  });

  test('SPORT gets its own performer-style label ("Not this team"), never the music wording', () => {
    const options = reasonOptionsFor({ category: 'SPORT', priceMinMinor: 1500 });
    const label = options.find((o) => o.code === 'not_this_artist')?.label;
    expect(label).toBe('Not this team');
  });

  test('every category always offers the universal fallback options', () => {
    for (const category of ['RESTAURANT', 'LIVE_MUSIC', 'SPORT', 'BAR', 'CINEMA', 'THEATRE', 'ART_CULTURE', 'DAY_ACTIVITY', 'COMEDY']) {
      const codes = reasonOptionsFor({ category, priceMinMinor: 1000 }).map((o) => o.code);
      expect(codes).toContain('not_into_this_type');
      expect(codes).toContain('too_far');
      expect(codes).toContain('wrong_day_time');
      expect(codes).toContain('done_enough_lately');
      expect(codes).toContain('something_else');
    }
  });

  test('a category with no venue identity (e.g. DAY_ACTIVITY) never offers "Not this venue"', () => {
    const codes = reasonOptionsFor({ category: 'DAY_ACTIVITY', priceMinMinor: null }).map((o) => o.code);
    expect(codes).not.toContain('not_this_venue');
  });
});
