import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams } from '../types';
import { withRetry } from '../../lib/retry';

/**
 * Shaped like a real ticketing aggregator response (DICE/Ticketmaster Discovery API both
 * return roughly: id, name, venue{name,lat,lng}, dates{start,end}, priceRanges[], images[],
 * classifications[], url). Going live with a real one means implementing `mapToCanonical`
 * against its actual schema and setting the adapter's `isLive` from a real API key — see
 * docs/providers/ticketing.md for exactly what each of Ticketmaster/DICE/Eventbrite needs
 * (an API key alone is not sufficient for DICE, which requires a partner agreement).
 */

interface MockTicketingRaw {
  id: string;
  name: string;
  venue: { name: string; lat: number; lng: number };
  category: ExperienceCategory;
  subgenres: string[];
  startsAt: string;
  endsAt: string | null;
  priceFromMinor: number;
  priceToMinor: number;
  soldOutPct: number; // 0-100
  imageUrl: string | null;
  tags: Record<string, unknown>;
}

const LONDON_VENUES = [
  { name: 'Drumsheds', lat: 51.6042, lng: -0.0733, area: 'Meridian Water' },
  { name: 'Fabric', lat: 51.5203, lng: -0.1027, area: 'Farringdon' },
  { name: 'Night Tales', lat: 51.5432, lng: -0.0507, area: 'Hackney' },
  { name: 'Corsica Studios', lat: 51.4952, lng: -0.0983, area: 'Elephant & Castle' },
  { name: 'Backyard Comedy Club', lat: 51.5285, lng: -0.0555, area: 'Bethnal Green' },
  { name: 'Ministry of Sound', lat: 51.4972, lng: -0.0994, area: 'Elephant & Castle' },
  { name: 'XOYO', lat: 51.5257, lng: -0.0873, area: 'Shoreditch' },
  { name: 'The Jazz Cafe', lat: 51.5399, lng: -0.1425, area: 'Camden' },
];

// Real Staffordshire-area venues (same "coherent sample tuple, honest fallback art" pattern as
// London's set above — see the beta's actual test group, docs/DECISIONS.md#uk-wide-location) —
// not the Ticketmaster/DICE coverage a live key would give, but real places with real
// coordinates, not London data relabelled. Same length/order as LONDON_VENUES so the lineup
// arrays below can index into either set.
const STAFFORDSHIRE_VENUES = [
  { name: 'Victoria Hall', lat: 53.0233, lng: -2.1727, area: 'Hanley, Stoke-on-Trent' },
  { name: 'The Sugarmill', lat: 53.0245, lng: -2.1785, area: 'Hanley, Stoke-on-Trent' },
  { name: 'Trentham Gardens', lat: 52.9727, lng: -2.1857, area: 'Trentham' },
  { name: 'Bet365 Stadium', lat: 52.9883, lng: -2.1751, area: 'Stoke-on-Trent' },
  { name: 'Stafford Gatehouse Theatre', lat: 52.8063, lng: -2.1177, area: 'Stafford' },
  { name: "Katie Fitzgerald's", lat: 52.8047, lng: -2.1213, area: 'Stafford' },
  { name: 'The Place', lat: 52.6913, lng: -2.0303, area: 'Cannock' },
  { name: 'Stafford County Showground', lat: 52.8355, lng: -2.1064, area: 'Stafford' },
];

// Real Birmingham venues — added because Birmingham is both this app's own UK-central fallback
// city (see UK_FALLBACK_CENTER, data/ukPlaces.ts) and the pilot's own "worth travelling to"
// example from Stafford, yet had zero mock coverage: a real user resolving to Birmingham (the
// fallback itself, or by choice) saw a genuinely empty catalogue whenever no live provider was
// configured. Two of these (O2 Institute, Utilita Arena) are independently confirmed real by
// live Ticketmaster results seen in production, not just general knowledge.
const BIRMINGHAM_VENUES = [
  { name: 'O2 Academy Birmingham', lat: 52.4746, lng: -1.8994, area: 'Bristol Street' },
  { name: 'O2 Institute Birmingham', lat: 52.4759, lng: -1.8898, area: 'Digbeth' },
  { name: 'The Sunflower Lounge', lat: 52.4772, lng: -1.8987, area: 'Smallbrook Queensway' },
  { name: 'Birmingham Hippodrome', lat: 52.4762, lng: -1.8998, area: 'Hurst Street' },
  { name: 'Symphony Hall', lat: 52.4779, lng: -1.9095, area: 'Broad Street' },
  { name: 'The Glee Club Birmingham', lat: 52.4762, lng: -1.8935, area: 'Arcadian Centre' },
  { name: 'Utilita Arena Birmingham', lat: 52.4783, lng: -1.9126, area: 'King Edward’s Road' },
  { name: 'Resorts World Arena', lat: 52.4519, lng: -1.7274, area: 'NEC, Marston Green' },
];

// city -> venue set, matched case-insensitively. Any city not in here gets an honest empty
// catalogue rather than London (or Staffordshire) data mislabelled under the wrong city — see
// docs/DECISIONS.md#uk-wide-location.
const CITY_VENUES: Record<string, typeof LONDON_VENUES> = {
  london: LONDON_VENUES,
  stafford: STAFFORDSHIRE_VENUES,
  'stoke-on-trent': STAFFORDSHIRE_VENUES,
  cannock: STAFFORDSHIRE_VENUES,
  stone: STAFFORDSHIRE_VENUES,
  birmingham: BIRMINGHAM_VENUES,
};

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/**
 * Each mock listing is a coherent (name, category, venue) tuple, not independently randomised
 * fields — a previous version cycled category by `index % 3` against a flat artist list, which
 * produced nonsense like "New Material Night ft. Skepta B2B" (a DJ b2b set labeled as a
 * stand-up comedy show).
 *
 * Deliberately no fake `imageUrl` here (a picsum.photos seed was tried and dropped — it does
 * not reliably load even in production, and a random unrelated stock photo is arguably worse
 * than an honest category treatment: it's imagery that lies about what the event actually is).
 * Sample data gets Plot's real, designed category fallback (see categoryStyle.ts); actual event
 * photography only ever comes from a real connected provider (Ticketmaster once
 * TICKETMASTER_API_KEY is set — see mapToCanonical in the live adapter), never faked here.
 */
const CLUBBING_LIVE_LINEUP: { name: string; cat: 'CLUBBING' | 'LIVE_MUSIC'; sub: string[]; venue: number }[] = [
  { name: 'Fred again..', cat: 'CLUBBING', sub: ['house', 'techno'], venue: 0 },
  { name: 'Bicep', cat: 'CLUBBING', sub: ['house', 'techno'], venue: 1 },
  { name: 'Overmono', cat: 'LIVE_MUSIC', sub: ['electronic', 'indie'], venue: 2 },
  { name: 'Nia Archives', cat: 'CLUBBING', sub: ['house', 'techno'], venue: 6 },
  { name: 'Peggy Gou', cat: 'CLUBBING', sub: ['house', 'techno'], venue: 5 },
  { name: 'Jamie xx', cat: 'LIVE_MUSIC', sub: ['electronic', 'indie'], venue: 3 },
  { name: 'Jorja Smith DJ Set', cat: 'LIVE_MUSIC', sub: ['electronic', 'indie'], venue: 7 },
];
const COMEDY_LINEUP: { name: string; venue: number }[] = [
  { name: 'New Material Night', venue: 4 },
  { name: 'Saturday Night Stand-Up Social', venue: 4 },
];

function generateMockCatalogue(city: string): MockTicketingRaw[] {
  const venues = CITY_VENUES[city.trim().toLowerCase()];
  if (!venues) return []; // honest: no sample coverage here rather than another city's data

  const citySlug = city.trim().toLowerCase().replace(/\s+/g, '-');
  const rand = seededRandom(42);
  // externalId is scoped by city — the same lineup index means a different real listing per
  // city (different venue/coordinates), so it must not collide with another city's row under
  // ProviderListing's (providerId, providerListingId) unique key.
  const entries: { id: string; name: string; venue: (typeof LONDON_VENUES)[number]; cat: ExperienceCategory; sub: string[] }[] = [
    ...CLUBBING_LIVE_LINEUP.map((a, i) => ({ id: `mock-tkt-${citySlug}-${i}`, name: a.name, venue: venues[a.venue], cat: a.cat as ExperienceCategory, sub: a.sub })),
    ...COMEDY_LINEUP.map((c, i) => ({ id: `mock-tkt-${citySlug}-comedy-${i}`, name: c.name, venue: venues[c.venue], cat: 'COMEDY' as ExperienceCategory, sub: ['stand_up'] })),
  ];

  return entries.map(({ id, name, venue, cat, sub }, i) => {
    // The first couple of listings are deliberately pinned near-term (today, tomorrow) rather
    // than left to the same 2-23-day spread as the rest — otherwise Explore's "Tonight" rail
    // (and often "This weekend") would be empty every single time, since a uniform 2+ day
    // minimum can never land on today. Everything else keeps the wider spread for variety.
    const daysOut = i === 0 ? 0 : i === 1 ? 1 : 2 + Math.floor(rand() * 21);
    const start = new Date();
    start.setDate(start.getDate() + daysOut);
    start.setHours(20, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 0, 0);

    return {
      id,
      name,
      venue: { name: venue.name, lat: venue.lat, lng: venue.lng },
      category: cat,
      subgenres: sub,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      priceFromMinor: (18 + Math.floor(rand() * 40)) * 100,
      priceToMinor: (45 + Math.floor(rand() * 60)) * 100,
      soldOutPct: Math.floor(rand() * 100),
      imageUrl: null,
      tags: {
        energy: cat === 'COMEDY' ? 'medium' : 'high',
        crowd: rand() > 0.5 ? 'mainstream' : 'alternative',
        indoorOutdoor: 'indoor',
        groupFriendly: true,
      },
    };
  });
}

export const mockTicketingProvider: ProviderAdapter = {
  id: 'mock_ticketing',
  displayName: 'Mock Ticketing (DICE/Ticketmaster-shaped)',
  categories: ['LIVE_MUSIC', 'CLUBBING', 'COMEDY'],
  isLive: false,

  async healthCheck() {
    return { status: 'ACTIVE', checkedAt: new Date() };
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    return withRetry(async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (signal.aborted) throw new Error('aborted');
      return generateMockCatalogue(params.city).map((item) => ({ externalId: item.id, raw: item }));
    });
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const item = listing.raw as MockTicketingRaw;
    const bookingStatus =
      item.soldOutPct >= 100 ? 'SOLD_OUT' : item.soldOutPct >= 80 ? 'LIMITED' : 'AVAILABLE';

    return {
      name: item.name,
      description: `${item.name} at ${item.venue.name}.`,
      category: item.category,
      subcategories: item.subgenres,
      venueName: item.venue.name,
      latitude: item.venue.lat,
      longitude: item.venue.lng,
      startsAt: new Date(item.startsAt),
      endsAt: item.endsAt ? new Date(item.endsAt) : null,
      timezone: 'Europe/London',
      priceMinMinor: item.priceFromMinor,
      priceMaxMinor: item.priceToMinor,
      currency: 'GBP',
      bookingStatus,
      imageUrl: item.imageUrl || null,
      tags: item.tags,
      externalUrl: `https://example-provider.invalid/events/${item.id}`,
      commissionEligible: false,
    };
  },
};
