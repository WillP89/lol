import { describe, expect, test } from 'vitest';
import {
  deriveSourceKind,
  isGenericChainName,
  derivePlanWorthiness,
  isPlanWorthyForCrew,
  deriveBookingType,
} from '../../src/services/opportunityIntent';

/**
 * THE OTHER HALF of the "Caffè Nero in London" fix — pure classification logic, testable
 * without a live database. The integration test (test/crewRecommendationHardGates.test.ts)
 * proves this actually stops the exact reported candidate; this file proves the classification
 * itself is principled and doesn't over- or under-reach.
 */

function experience(overrides: Partial<{ name: string; description: string; category: string; subcategories: string[]; tags: Record<string, unknown>; bookingStatus: string; priceMinMinor: number | null }> = {}) {
  return {
    name: 'Test Venue',
    description: 'A real test venue with enough description text.',
    category: 'RESTAURANT',
    subcategories: [],
    tags: {},
    bookingStatus: 'AVAILABLE',
    priceMinMinor: null,
    ...overrides,
  } as never;
}

describe('deriveSourceKind', () => {
  test('place-provider tags (openstreetmap/fhrs/google_places/foursquare) classify as PLACE_PROVIDER', () => {
    for (const provider of ['openstreetmap', 'fhrs', 'google_places', 'foursquare']) {
      expect(deriveSourceKind(experience({ tags: { provider } }))).toBe('PLACE_PROVIDER');
    }
  });

  test('event-provider tags (ticketmaster/skiddle/predicthq/eventbrite) classify as EVENT_PROVIDER', () => {
    for (const provider of ['ticketmaster', 'skiddle', 'predicthq', 'eventbrite']) {
      expect(deriveSourceKind(experience({ tags: { provider } }))).toBe('EVENT_PROVIDER');
    }
  });

  test('no tags.provider at all (manual curation, every mock provider) classifies as UNKNOWN, never penalised as PLACE_PROVIDER', () => {
    expect(deriveSourceKind(experience({ tags: {} }))).toBe('UNKNOWN');
    expect(deriveSourceKind(experience({ tags: { formality: 'casual' } }))).toBe('UNKNOWN');
  });
});

describe('isGenericChainName', () => {
  test('recognises real UK coffee/fast-food chains', () => {
    expect(isGenericChainName('Caffè Nero')).toBe(true);
    expect(isGenericChainName('Costa Coffee')).toBe(true);
    expect(isGenericChainName("McDonald's")).toBe(true);
    expect(isGenericChainName('Greggs')).toBe(true);
  });

  test('never flags a real independent venue or a legitimate restaurant chain groups do book', () => {
    expect(isGenericChainName('The Wellington')).toBe(false);
    expect(isGenericChainName('Smoking Goat')).toBe(false);
    expect(isGenericChainName('Wagamama')).toBe(false); // deliberately not blacklisted — a real group-dinner choice
    expect(isGenericChainName("Nando's")).toBe(false);
  });
});

describe('derivePlanWorthiness — the actual "Caffè Nero" gate', () => {
  test('a PLACE_PROVIDER-sourced generic chain venue is VERY_LOW regardless of category', () => {
    const result = derivePlanWorthiness(experience({ name: 'Caffè Nero', category: 'RESTAURANT', tags: { provider: 'openstreetmap' } }));
    expect(result.level).toBe('VERY_LOW');
    expect(result.reasons).toContain('generic_chain_name');
  });

  test('a PLACE_PROVIDER-sourced generic, non-chain RESTAURANT/BAR with no specialness signal is LOW — "there is a place nearby" is not a plan', () => {
    expect(derivePlanWorthiness(experience({ name: 'Corner Café', category: 'RESTAURANT', tags: { provider: 'openstreetmap' } })).level).toBe('LOW');
    expect(derivePlanWorthiness(experience({ name: 'The Local', category: 'BAR', tags: { provider: 'fhrs' } })).level).toBe('LOW');
  });

  test('a PLACE_PROVIDER-sourced RESTAURANT with a real specialness signal in its own text is HIGH', () => {
    const result = derivePlanWorthiness(experience({ name: 'Borough Street Food Market', category: 'RESTAURANT', tags: { provider: 'openstreetmap' } }));
    expect(result.level).toBe('HIGH');
    expect(result.reasons).toContain('place_provider_but_specialness_signal');
  });

  test('an EVENT_PROVIDER-sourced RESTAURANT (PredictHQ food-drink) is HIGH — a real dated occasion, not a permanent venue', () => {
    const result = derivePlanWorthiness(experience({ name: 'Stafford Food & Drink Market', category: 'RESTAURANT', tags: { provider: 'predicthq' } }));
    expect(result.level).toBe('HIGH');
    expect(result.reasons).toContain('event_provider_dated_occasion');
  });

  test('an UNKNOWN-sourced RESTAURANT/BAR (mock providers, manual curation) is MEDIUM — the ordinary baseline, never penalised for an unreviewed source it is not', () => {
    expect(derivePlanWorthiness(experience({ name: 'Smoking Goat', category: 'RESTAURANT', tags: {} })).level).toBe('MEDIUM');
    expect(derivePlanWorthiness(experience({ name: 'The Wellington', category: 'BAR', tags: {} })).level).toBe('MEDIUM');
  });

  test('LIVE_MUSIC/FESTIVAL/COMEDY/THEATRE/SPORT default HIGH or above regardless of source', () => {
    for (const category of ['LIVE_MUSIC', 'COMEDY', 'THEATRE', 'SPORT']) {
      expect(derivePlanWorthiness(experience({ name: 'A Real Show', category, tags: {} })).level).toBe('HIGH');
    }
    expect(derivePlanWorthiness(experience({ name: 'A Real Festival', category: 'FESTIVAL', tags: {} })).level).toBe('VERY_HIGH');
  });

  test('a DAY_ACTIVITY venue with real activity-specific wording (escape room, bowling) is HIGH even from a place provider', () => {
    const result = derivePlanWorthiness(experience({ name: 'Clue HQ Escape Room', category: 'DAY_ACTIVITY', tags: { provider: 'openstreetmap' } }));
    expect(result.level).toBe('HIGH');
    expect(result.reasons).toContain('activity_venue_signal');
  });

  test('an ordinary DAY_ACTIVITY with no activity-specific wording stays at the MEDIUM baseline', () => {
    expect(derivePlanWorthiness(experience({ name: 'Staffordshire Riding School', category: 'DAY_ACTIVITY', tags: { provider: 'openstreetmap' } })).level).toBe('MEDIUM');
  });
});

describe('isPlanWorthyForCrew — the actual hard-gate boundary', () => {
  test('MEDIUM and above pass; LOW and VERY_LOW fail', () => {
    expect(isPlanWorthyForCrew(experience({ name: 'A Real Show', category: 'LIVE_MUSIC', tags: {} }))).toBe(true);
    expect(isPlanWorthyForCrew(experience({ name: 'Smoking Goat', category: 'RESTAURANT', tags: {} }))).toBe(true);
    expect(isPlanWorthyForCrew(experience({ name: 'Corner Café', category: 'RESTAURANT', tags: { provider: 'openstreetmap' } }))).toBe(false);
    expect(isPlanWorthyForCrew(experience({ name: 'Caffè Nero', category: 'RESTAURANT', tags: { provider: 'openstreetmap' } }))).toBe(false);
  });
});

describe('deriveBookingType', () => {
  test('SOLD_OUT always wins regardless of source', () => {
    expect(deriveBookingType(experience({ bookingStatus: 'SOLD_OUT', tags: { provider: 'ticketmaster' }, priceMinMinor: 2000 }))).toBe('SOLD_OUT');
  });

  test('a real EVENT_PROVIDER listing with a price is a ticket; without one, an RSVP', () => {
    expect(deriveBookingType(experience({ tags: { provider: 'ticketmaster' }, priceMinMinor: 2000 }))).toBe('TICKET_AVAILABLE');
    expect(deriveBookingType(experience({ tags: { provider: 'predicthq' }, priceMinMinor: null }))).toBe('RSVP_AVAILABLE');
  });

  test('a PLACE_PROVIDER listing is always a walk-in — no adapter has a real booking integration', () => {
    expect(deriveBookingType(experience({ tags: { provider: 'openstreetmap' }, priceMinMinor: null }))).toBe('WALK_IN');
    expect(deriveBookingType(experience({ tags: { provider: 'fhrs' }, priceMinMinor: null }))).toBe('WALK_IN');
  });

  test('an UNKNOWN-source listing with a real price is a booking link; without one, no booking required', () => {
    expect(deriveBookingType(experience({ tags: {}, priceMinMinor: 3000 }))).toBe('BOOKING_LINK_AVAILABLE');
    expect(deriveBookingType(experience({ tags: {}, priceMinMinor: null }))).toBe('NO_BOOKING_REQUIRED');
  });
});
