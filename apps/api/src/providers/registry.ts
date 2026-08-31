import type { ProviderAdapter } from './types';
import { mockTicketingProvider } from './mock/ticketingProvider';
import { mockRestaurantProvider } from './mock/restaurantProvider';
import { ticketmasterProvider } from './live/ticketmaster';
import { eventbriteProvider } from './live/eventbrite';
import { config } from '../lib/config';

/**
 * Every provider adapter, real or mock, registers here. `docs/providers/*.md` documents
 * exactly what's needed to add each real one (Ticketmaster, Eventbrite, DICE, OpenTable, ...)
 * — the pattern is always: implement `ProviderAdapter`, add credentials to config.ts, register
 * it here. Nothing else in the codebase needs to change.
 *
 * Each live ticketed-events adapter registers independently as its own key is configured —
 * more than one can run at once (Ticketmaster AND Eventbrite both live is the normal case for
 * "every source possible", not either/or). The mock restaurant provider stays registered
 * regardless: no self-serve restaurant/pub API exists at all (OpenTable/Resy/SevenRooms are
 * all partner-gated — see docs/providers/restaurants.md), so losing it the moment ANY ticketed
 * source went live would have silently killed restaurant/pub discovery entirely — caught
 * before this first ran with a real key. If NO live credential exists at all, the mocks are
 * the only source, and that fact is surfaced to the client (GET /admin/providers, and
 * Explore/Discover's "sample events" banner) rather than silently presented as real inventory.
 * See docs/DECISIONS.md#real-events.
 */
const liveTicketedProviders: ProviderAdapter[] = [
  ...(config.TICKETMASTER_API_KEY ? [ticketmasterProvider] : []),
  ...(config.EVENTBRITE_API_KEY ? [eventbriteProvider] : []),
];

export const providerRegistry: ProviderAdapter[] = liveTicketedProviders.length > 0
  ? [...liveTicketedProviders, mockRestaurantProvider]
  : [mockTicketingProvider, mockRestaurantProvider];

export const hasLiveProvider = providerRegistry.some((p) => p.isLive);

export function getProvider(id: string): ProviderAdapter | undefined {
  return providerRegistry.find((p) => p.id === id);
}
