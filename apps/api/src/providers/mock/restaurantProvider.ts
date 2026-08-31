import type { ProviderAdapter, RawListing, CanonicalListingInput, FetchListingsParams } from '../types';
import { withRetry } from '../../lib/retry';

/**
 * Shaped like a real restaurant-availability aggregator (OpenTable/Resy/SevenRooms-style:
 * restaurant id, name, location, cuisine, price band, available time slots). Going live needs
 * a real commercial agreement per docs/providers/restaurants.md — OpenTable's Availability
 * API is partner-gated, not self-serve.
 */

interface MockRestaurantRaw {
  id: string;
  name: string;
  cuisine: string;
  lat: number;
  lng: number;
  areaName: string;
  avgSpendMinor: number;
  slotsAt: string[]; // ISO timestamps of bookable slots this window
  atmosphere: string[];
}

const LONDON_RESTAURANTS: Omit<MockRestaurantRaw, 'slotsAt'>[] = [
  { id: 'mock-rst-london-1', name: 'Smoking Goat', cuisine: 'Thai', lat: 51.5272, lng: -0.0789, areaName: 'Shoreditch', avgSpendMinor: 4200, atmosphere: ['casual', 'loud', 'group_friendly'] },
  { id: 'mock-rst-london-2', name: 'Kiln', cuisine: 'Thai', lat: 51.5117, lng: -0.1367, areaName: 'Soho', avgSpendMinor: 4500, atmosphere: ['casual', 'counter_seating'] },
  { id: 'mock-rst-london-3', name: 'Brat', cuisine: 'Basque / Grill', lat: 51.5252, lng: -0.0782, areaName: 'Shoreditch', avgSpendMinor: 6500, atmosphere: ['smart_casual', 'date_friendly'] },
  { id: 'mock-rst-london-4', name: 'Rovi', cuisine: 'Vegetable-forward', lat: 51.5245, lng: -0.1417, areaName: 'Fitzrovia', avgSpendMinor: 5500, atmosphere: ['smart_casual'] },
  { id: 'mock-rst-london-5', name: 'Bao Borough', cuisine: 'Taiwanese', lat: 51.5054, lng: -0.0913, areaName: 'Borough', avgSpendMinor: 3200, atmosphere: ['casual', 'group_friendly'] },
];

// Real Staffordshire dining rooms/pubs — same honesty bar as London's list (genuinely real
// places), not a second copy of London data under a different label. See
// docs/DECISIONS.md#uk-wide-location.
const STAFFORDSHIRE_RESTAURANTS: Omit<MockRestaurantRaw, 'slotsAt'>[] = [
  { id: 'mock-rst-staffs-1', name: 'The Moat House', cuisine: 'Modern British', lat: 52.7736, lng: -2.1109, areaName: 'Acton Trussell', avgSpendMinor: 4800, atmosphere: ['smart_casual', 'date_friendly'] },
  { id: 'mock-rst-staffs-2', name: 'Twelve', cuisine: 'Modern British', lat: 52.9435, lng: -2.1743, areaName: 'Barlaston', avgSpendMinor: 5500, atmosphere: ['smart_casual', 'date_friendly'] },
  { id: 'mock-rst-staffs-3', name: 'The George', cuisine: 'Gastropub', lat: 52.8574, lng: -2.2453, areaName: 'Eccleshall', avgSpendMinor: 3600, atmosphere: ['casual', 'group_friendly'] },
  { id: 'mock-rst-staffs-4', name: 'The Holly Bush Inn', cuisine: 'Gastropub', lat: 52.8480, lng: -2.1145, areaName: 'Salt', avgSpendMinor: 3400, atmosphere: ['casual', 'group_friendly'] },
];

const CITY_RESTAURANTS: Record<string, Omit<MockRestaurantRaw, 'slotsAt'>[]> = {
  london: LONDON_RESTAURANTS,
  stafford: STAFFORDSHIRE_RESTAURANTS,
  'stoke-on-trent': STAFFORDSHIRE_RESTAURANTS,
  cannock: STAFFORDSHIRE_RESTAURANTS,
  stone: STAFFORDSHIRE_RESTAURANTS,
};

function generateSlots(daysAhead: number[]): string[] {
  const slots: string[] = [];
  for (const d of daysAhead) {
    const date = new Date();
    date.setDate(date.getDate() + d);
    for (const hour of [19, 19.5, 20, 20.5]) {
      const slot = new Date(date);
      slot.setHours(Math.floor(hour), (hour % 1) * 60, 0, 0);
      slots.push(slot.toISOString());
    }
  }
  return slots;
}

export const mockRestaurantProvider: ProviderAdapter = {
  id: 'mock_restaurants',
  displayName: 'Mock Restaurants (OpenTable-shaped)',
  categories: ['RESTAURANT'],
  isLive: false,

  async healthCheck() {
    return { status: 'ACTIVE', checkedAt: new Date() };
  },

  async fetchListings(params: FetchListingsParams): Promise<RawListing[]> {
    const restaurants = CITY_RESTAURANTS[params.city.trim().toLowerCase()] ?? [];
    return withRetry(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return restaurants.map((r) => ({
        externalId: r.id,
        raw: { ...r, slotsAt: generateSlots([0, 1, 2, 5, 6]) } satisfies MockRestaurantRaw,
      }));
    });
  },

  mapToCanonical(listing: RawListing): CanonicalListingInput {
    const item = listing.raw as MockRestaurantRaw;
    const nextSlot = item.slotsAt.sort()[0];

    return {
      name: item.name,
      description: `${item.cuisine} in ${item.areaName}.`,
      category: 'RESTAURANT',
      subcategories: [item.cuisine.toLowerCase()],
      venueName: item.name,
      latitude: item.lat,
      longitude: item.lng,
      startsAt: new Date(nextSlot),
      endsAt: null,
      timezone: 'Europe/London',
      priceMinMinor: Math.round(item.avgSpendMinor * 0.7),
      priceMaxMinor: Math.round(item.avgSpendMinor * 1.3),
      currency: 'GBP',
      bookingStatus: item.slotsAt.length > 0 ? 'AVAILABLE' : 'SOLD_OUT',
      imageUrl: null,
      tags: { formality: item.atmosphere.includes('date_friendly') ? 'smart_casual' : 'casual', groupFriendly: item.atmosphere.includes('group_friendly') },
      externalUrl: `https://example-provider.invalid/restaurants/${item.id}`,
      commissionEligible: false,
    };
  },
};
