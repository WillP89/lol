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
  imageUrl: string;
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

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateMockCatalogue(): MockTicketingRaw[] {
  const rand = seededRandom(42);
  const artists = [
    'Fred again..',
    'Bicep',
    'Overmono',
    'Nia Archives',
    'Peggy Gou',
    'Skepta B2B',
    'Jamie xx',
    'Jorja Smith DJ Set',
  ];
  const categories: { cat: ExperienceCategory; sub: string[] }[] = [
    { cat: 'CLUBBING', sub: ['house', 'techno'] },
    { cat: 'LIVE_MUSIC', sub: ['electronic', 'indie'] },
    { cat: 'COMEDY', sub: ['stand_up'] },
  ];

  return artists.map((artist, i) => {
    const venue = LONDON_VENUES[i % LONDON_VENUES.length];
    const { cat, sub } = categories[i % categories.length];
    const daysOut = 2 + Math.floor(rand() * 21);
    const start = new Date();
    start.setDate(start.getDate() + daysOut);
    start.setHours(20, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 0, 0);

    return {
      id: `mock-tkt-${i}`,
      name: cat === 'COMEDY' ? `New Material Night ft. ${artist}` : artist,
      venue: { name: venue.name, lat: venue.lat, lng: venue.lng },
      category: cat,
      subgenres: sub,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      priceFromMinor: (18 + Math.floor(rand() * 40)) * 100,
      priceToMinor: (45 + Math.floor(rand() * 60)) * 100,
      soldOutPct: Math.floor(rand() * 100),
      imageUrl: '',
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

  async fetchListings(_params: FetchListingsParams): Promise<RawListing[]> {
    return withRetry(async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (signal.aborted) throw new Error('aborted');
      return generateMockCatalogue().map((item) => ({ externalId: item.id, raw: item }));
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
