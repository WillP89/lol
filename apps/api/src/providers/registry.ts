import type { ProviderAdapter } from './types';
import { mockTicketingProvider } from './mock/ticketingProvider';
import { mockRestaurantProvider } from './mock/restaurantProvider';

/**
 * Every provider adapter, real or mock, registers here. `docs/providers/*.md` documents
 * exactly what's needed to add each real one (Ticketmaster, DICE, Eventbrite, OpenTable, ...)
 * — the pattern is always: implement `ProviderAdapter`, add credentials to config.ts, register
 * it here. Nothing else in the codebase needs to change.
 */
export const providerRegistry: ProviderAdapter[] = [mockTicketingProvider, mockRestaurantProvider];

export function getProvider(id: string): ProviderAdapter | undefined {
  return providerRegistry.find((p) => p.id === id);
}
