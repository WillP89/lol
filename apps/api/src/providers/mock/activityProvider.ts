import type { ExperienceCategory } from '@prisma/client';
import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams } from '../types';
import { withRetry } from '../../lib/retry';

/**
 * Real, reported gap this closes: before this file existed, the ONLY inventory Plot ever had —
 * live or mock — was `mockTicketingProvider` (LIVE_MUSIC/CLUBBING/COMEDY only) and
 * `mockRestaurantProvider` (RESTAURANT only). Every other category the schema already models
 * (`ExperienceCategory`: SPORT, FITNESS, DAY_ACTIVITY, ART_CULTURE, THEATRE, CINEMA, BAR,
 * COMMUNITY) had a real column in the database and zero rows ever landing in it — "Plot feels
 * heavily skewed toward music/gigs" wasn't a perception problem, it was literally true of the
 * data. This is the same honest pattern as the other two mock providers (see their own
 * comments): real, named, real-coordinate UK places — a genuine sports stadium, a genuine
 * theme park, a genuine museum — standing in for the ticketed/session data a real
 * sport/attraction/activity API would supply once one is connected (see docs/providers/*.md
 * for what's actually needed there). Never fabricated as "real inventory" to the user — same
 * `isLive: false` / sample-data labelling every other mock provider already carries.
 */

interface MockActivityRaw {
  id: string;
  name: string;
  category: ExperienceCategory;
  venueName: string;
  lat: number;
  lng: number;
  description: string;
  subcategories: string[];
  priceFromMinor: number;
  priceToMinor: number;
  daysOut: number;
  groupFriendly: boolean;
}

type Seed = Omit<MockActivityRaw, 'id' | 'daysOut'>;

// Real Staffordshire/Stoke places across the categories the ticketing+restaurant mocks never
// touch. Coordinates are approximate town-centre/landmark positions for real, well-known
// places — the same confidence bar the existing venue lists in ticketingProvider.ts and
// restaurantProvider.ts already use, not exact entrance geocodes.
const STAFFORDSHIRE_ACTIVITIES: Seed[] = [
  { name: 'Stoke City vs. Rotherham', category: 'SPORT', venueName: 'Bet365 Stadium', lat: 52.9883, lng: -2.1751, description: 'Championship football at Stoke City’s home ground.', subcategories: ['football'], priceFromMinor: 2500, priceToMinor: 6000, groupFriendly: true },
  { name: 'Uttoxeter Racecourse Race Day', category: 'SPORT', venueName: 'Uttoxeter Racecourse', lat: 52.8934, lng: -1.8564, description: 'A live race meeting with bars and a beer garden.', subcategories: ['horse_racing'], priceFromMinor: 1500, priceToMinor: 4000, groupFriendly: true },
  { name: 'Cannock Chase Trail Walk', category: 'DAY_ACTIVITY', venueName: 'Cannock Chase AONB', lat: 52.7392, lng: -2.0203, description: 'Waymarked forest trails across an Area of Outstanding Natural Beauty.', subcategories: ['walking', 'outdoors'], priceFromMinor: 0, priceToMinor: 0, groupFriendly: true },
  { name: 'Alton Towers Day Ticket', category: 'DAY_ACTIVITY', venueName: 'Alton Towers Resort', lat: 52.9866, lng: -1.8877, description: 'Rides and rollercoasters for a full day out.', subcategories: ['theme_park'], priceFromMinor: 3500, priceToMinor: 6500, groupFriendly: true },
  { name: 'Trentham Monkey Forest', category: 'DAY_ACTIVITY', venueName: 'Trentham Monkey Forest', lat: 52.9557, lng: -2.1866, description: 'Walk among free-roaming Barbary macaques.', subcategories: ['nature', 'family'], priceFromMinor: 800, priceToMinor: 1200, groupFriendly: true },
  { name: 'Chasewater Watersports Taster', category: 'FITNESS', venueName: 'Chasewater Country Park', lat: 52.6708, lng: -1.9308, description: 'Kayaking and paddleboarding sessions on the reservoir.', subcategories: ['watersports'], priceFromMinor: 1800, priceToMinor: 3000, groupFriendly: true },
  { name: 'Clip ’n Climb Stafford', category: 'FITNESS', venueName: 'Clip ’n Climb Stafford', lat: 52.8073, lng: -2.1220, description: 'Indoor climbing walls, group sessions bookable.', subcategories: ['climbing'], priceFromMinor: 1200, priceToMinor: 1800, groupFriendly: true },
  { name: 'The Potteries Museum & Art Gallery', category: 'ART_CULTURE', venueName: 'The Potteries Museum & Art Gallery', lat: 53.0208, lng: -2.1802, description: 'Ceramics, WWII Spitfire history and rotating exhibitions.', subcategories: ['museum'], priceFromMinor: 0, priceToMinor: 0, groupFriendly: true },
  { name: 'Stafford Gatehouse Theatre: touring musical', category: 'THEATRE', venueName: 'Stafford Gatehouse Theatre', lat: 52.8063, lng: -2.1177, description: 'A touring West End production for one week only.', subcategories: ['musical'], priceFromMinor: 2200, priceToMinor: 4500, groupFriendly: true },
  { name: 'Odeon Cinema: new release', category: 'CINEMA', venueName: 'Odeon Stoke-on-Trent', lat: 53.0083, lng: -2.1889, description: 'This week’s big new release, group booking available.', subcategories: ['film'], priceFromMinor: 900, priceToMinor: 1400, groupFriendly: true },
  { name: 'Stafford Indoor Market', category: 'COMMUNITY', venueName: 'Stafford Market', lat: 52.8058, lng: -2.1176, description: 'Independent stalls, street food and a Saturday crowd.', subcategories: ['market'], priceFromMinor: 0, priceToMinor: 0, groupFriendly: true },
  { name: "Katie Fitzgerald's Quiz Night", category: 'BAR', venueName: "Katie Fitzgerald's", lat: 52.8047, lng: -2.1213, description: 'Weekly pub quiz, teams of up to six.', subcategories: ['quiz'], priceFromMinor: 200, priceToMinor: 200, groupFriendly: true },
  // Real gap this closes (live product directive: "street food, food festivals, food markets,
  // pop-ups... are still underrepresented"): the mock catalogue's only food-adjacent entries
  // before this were a market with a generic 'market' tag and the restaurant provider's own
  // cuisine list — nothing that could ever earn a "street_food"/"food_festivals" taxonomy match
  // specifically. Real, named Stafford town-centre location, not a fabricated one.
  { name: 'Stafford Street Food Festival', category: 'RESTAURANT', venueName: 'Market Square, Stafford', lat: 52.8062, lng: -2.1170, description: 'A weekend of street food traders and live cooking demos in the town centre.', subcategories: ['street_food', 'food_festivals'], priceFromMinor: 0, priceToMinor: 1500, groupFriendly: true },
];

const BIRMINGHAM_ACTIVITIES: Seed[] = [
  { name: 'Aston Villa vs. Fulham', category: 'SPORT', venueName: 'Villa Park', lat: 52.5092, lng: -1.8848, description: 'Premier League football at Villa Park.', subcategories: ['football'], priceFromMinor: 3500, priceToMinor: 9000, groupFriendly: true },
  { name: 'Warwickshire CCC Match Day', category: 'SPORT', venueName: 'Edgbaston Cricket Ground', lat: 52.4553, lng: -1.9024, description: 'A day of county cricket with the ground’s own bars open.', subcategories: ['cricket'], priceFromMinor: 2000, priceToMinor: 5500, groupFriendly: true },
  { name: 'Lickey Hills Country Park Walk', category: 'DAY_ACTIVITY', venueName: 'Lickey Hills Country Park', lat: 52.3897, lng: -2.0106, description: 'Hilltop views over Birmingham, waymarked trails.', subcategories: ['walking', 'outdoors'], priceFromMinor: 0, priceToMinor: 0, groupFriendly: true },
  { name: 'Birmingham Botanical Gardens', category: 'DAY_ACTIVITY', venueName: 'Birmingham Botanical Gardens', lat: 52.4646, lng: -1.9424, description: 'Glasshouses, gardens and a bandstand lawn.', subcategories: ['gardens'], priceFromMinor: 700, priceToMinor: 900, groupFriendly: true },
  { name: 'The Gymnasium Escape Room', category: 'FITNESS', venueName: 'The Gymnasium Birmingham', lat: 52.4796, lng: -1.8990, description: 'A themed group escape room, 4-6 players.', subcategories: ['escape_room'], priceFromMinor: 1800, priceToMinor: 2400, groupFriendly: true },
  { name: 'Birmingham Museum & Art Gallery', category: 'ART_CULTURE', venueName: 'Birmingham Museum & Art Gallery', lat: 52.4804, lng: -1.9028, description: 'Pre-Raphaelites, Staffordshire Hoard and free general admission.', subcategories: ['museum'], priceFromMinor: 0, priceToMinor: 0, groupFriendly: true },
  { name: 'Birmingham Hippodrome: touring show', category: 'THEATRE', venueName: 'Birmingham Hippodrome', lat: 52.4762, lng: -1.8998, description: 'A major touring production, several nights this run.', subcategories: ['musical'], priceFromMinor: 2500, priceToMinor: 5500, groupFriendly: true },
  { name: 'Everyman Cinema: new release', category: 'CINEMA', venueName: 'Everyman Cinema Birmingham', lat: 52.4788, lng: -1.9026, description: 'Sofa seating, this week’s new release.', subcategories: ['film'], priceFromMinor: 1200, priceToMinor: 1800, groupFriendly: true },
  { name: 'Birmingham Bullring Market', category: 'COMMUNITY', venueName: 'Bullring Open Market', lat: 52.4772, lng: -1.8925, description: 'One of the UK’s oldest open-air markets.', subcategories: ['market'], priceFromMinor: 0, priceToMinor: 0, groupFriendly: true },
  { name: 'The Wellington Quiz Night', category: 'BAR', venueName: 'The Wellington', lat: 52.4802, lng: -1.8965, description: 'Weekly pub quiz in a real-ale pub.', subcategories: ['quiz'], priceFromMinor: 200, priceToMinor: 200, groupFriendly: true },
];

const LONDON_ACTIVITIES: Seed[] = [
  { name: 'Arsenal vs. Everton', category: 'SPORT', venueName: 'Emirates Stadium', lat: 51.5549, lng: -0.1084, description: 'Premier League football at the Emirates.', subcategories: ['football'], priceFromMinor: 4500, priceToMinor: 12000, groupFriendly: true },
  { name: 'Lord’s Cricket Ground Match Day', category: 'SPORT', venueName: "Lord's Cricket Ground", lat: 51.5299, lng: -0.1729, description: 'A day of cricket at the home of the game.', subcategories: ['cricket'], priceFromMinor: 3000, priceToMinor: 8000, groupFriendly: true },
  { name: 'Hampstead Heath Walk', category: 'DAY_ACTIVITY', venueName: 'Hampstead Heath', lat: 51.5608, lng: -0.1629, description: 'Open parkland, ponds and skyline views from Parliament Hill.', subcategories: ['walking', 'outdoors'], priceFromMinor: 0, priceToMinor: 0, groupFriendly: true },
  { name: 'Kew Gardens', category: 'DAY_ACTIVITY', venueName: 'Royal Botanic Gardens, Kew', lat: 51.4787, lng: -0.2956, description: 'Glasshouses, treetop walkway and 300 acres of gardens.', subcategories: ['gardens'], priceFromMinor: 1600, priceToMinor: 2200, groupFriendly: true },
  { name: 'Clip ’n Climb London', category: 'FITNESS', venueName: 'Clip ’n Climb Wimbledon', lat: 51.4214, lng: -0.2064, description: 'Indoor climbing walls, group sessions bookable.', subcategories: ['climbing'], priceFromMinor: 1600, priceToMinor: 2200, groupFriendly: true },
  { name: 'Tate Modern', category: 'ART_CULTURE', venueName: 'Tate Modern', lat: 51.5076, lng: -0.0994, description: 'Modern and contemporary art, free general admission.', subcategories: ['gallery'], priceFromMinor: 0, priceToMinor: 0, groupFriendly: true },
  { name: 'West End: touring musical', category: 'THEATRE', venueName: 'Apollo Victoria Theatre', lat: 51.4964, lng: -0.1447, description: 'A long-running West End musical.', subcategories: ['musical'], priceFromMinor: 3500, priceToMinor: 9500, groupFriendly: true },
  { name: 'Everyman Cinema: new release', category: 'CINEMA', venueName: 'Everyman Screen on the Green', lat: 51.5379, lng: -0.1029, description: 'Sofa seating, this week’s new release.', subcategories: ['film'], priceFromMinor: 1400, priceToMinor: 2000, groupFriendly: true },
  { name: 'Broadway Market', category: 'COMMUNITY', venueName: 'Broadway Market', lat: 51.5364, lng: -0.0605, description: 'Independent stalls and street food every Saturday.', subcategories: ['market'], priceFromMinor: 0, priceToMinor: 0, groupFriendly: true },
  { name: 'The Antwerp Arms Quiz Night', category: 'BAR', venueName: 'The Antwerp Arms', lat: 51.6006, lng: -0.0682, description: 'Weekly pub quiz, teams welcome.', subcategories: ['quiz'], priceFromMinor: 200, priceToMinor: 200, groupFriendly: true },
];

// city -> seed set, same case-insensitive matching and "honest empty catalogue for an unlisted
// city" rule as the other two mock providers — see their own CITY_* maps.
const CITY_ACTIVITIES: Record<string, Seed[]> = {
  london: LONDON_ACTIVITIES,
  stafford: STAFFORDSHIRE_ACTIVITIES,
  'stoke-on-trent': STAFFORDSHIRE_ACTIVITIES,
  cannock: STAFFORDSHIRE_ACTIVITIES,
  stone: STAFFORDSHIRE_ACTIVITIES,
  birmingham: BIRMINGHAM_ACTIVITIES,
};

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateCatalogue(city: string): MockActivityRaw[] {
  const seeds = CITY_ACTIVITIES[city.trim().toLowerCase()];
  if (!seeds) return [];
  const citySlug = city.trim().toLowerCase().replace(/\s+/g, '-');
  const rand = seededRandom(7);
  return seeds.map((seed, i) => ({
    ...seed,
    id: `mock-act-${citySlug}-${i}`,
    // Spread across the next ~3 weeks, same shape as the ticketing mock's spread, with one
    // pinned to "this weekend" so the weekend-facing surfaces (Explore's rails, an availability
    // poll) always have at least one real candidate to show.
    daysOut: i === 0 ? 2 : i === 1 ? 5 : 3 + Math.floor(rand() * 18),
  }));
}

export const mockActivityProvider: ProviderAdapter = {
  id: 'mock_activities',
  displayName: 'Mock Activities & Attractions (sport/outdoors/culture/community-shaped)',
  categories: ['SPORT', 'FITNESS', 'DAY_ACTIVITY', 'ART_CULTURE', 'THEATRE', 'CINEMA', 'COMMUNITY', 'BAR'],
  isLive: false,

  async healthCheck() {
    return { status: 'ACTIVE', checkedAt: new Date() };
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    return withRetry(async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      if (signal.aborted) throw new Error('aborted');
      return generateCatalogue(params.city).map((item) => ({ externalId: item.id, raw: item }));
    });
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const item = listing.raw as MockActivityRaw;
    const start = new Date();
    start.setDate(start.getDate() + item.daysOut);
    start.setHours(item.category === 'SPORT' ? 15 : item.category === 'DAY_ACTIVITY' || item.category === 'ART_CULTURE' ? 11 : 19, 0, 0, 0);
    const end = new Date(start);
    end.setHours(end.getHours() + (item.category === 'DAY_ACTIVITY' ? 4 : 2));

    return {
      name: item.name,
      description: item.description,
      category: item.category,
      subcategories: item.subcategories,
      venueName: item.venueName,
      latitude: item.lat,
      longitude: item.lng,
      startsAt: start,
      endsAt: end,
      timezone: 'Europe/London',
      priceMinMinor: item.priceFromMinor,
      priceMaxMinor: item.priceToMinor,
      currency: 'GBP',
      bookingStatus: 'AVAILABLE',
      imageUrl: null,
      imageSource: null,
      tags: { groupFriendly: item.groupFriendly, indoorOutdoor: item.category === 'DAY_ACTIVITY' ? 'outdoor' : 'indoor' },
      externalUrl: `https://example-provider.invalid/activities/${item.id}`,
      commissionEligible: false,
    };
  },
};
