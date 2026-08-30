import type { ProviderAdapter } from './types';
import { mockTicketingProvider } from './mock/ticketingProvider';
import { mockRestaurantProvider } from './mock/restaurantProvider';
import { ticketmasterProvider } from './live/ticketmaster';
import { config } from '../lib/config';

/**
 * Every provider adapter, real or mock, registers here. `docs/providers/*.md` documents
 * exactly what's needed to add each real one (Ticketmaster, DICE, Eventbrite, OpenTable, ...)
 * — the pattern is always: implement `ProviderAdapter`, add credentials to config.ts, register
 * it here. Nothing else in the codebase needs to change.
 *
 * Ticketmaster registers only when a real API key is configured — see
 * docs/DECISIONS.md#real-events. Without a key, the mock providers are the only source, and
 * that fact is surfaced to the client (GET /admin/providers, and the Explore page's "sample
 * events" banner) rather than silently presented as real inventory.
 */
const hasAnyLiveCredential = Boolean(config.TICKETMASTER_API_KEY);

export const providerRegistry: ProviderAdapter[] = hasAnyLiveCredential
  ? [ticketmasterProvider]
  : [mockTicketingProvider, mockRestaurantProvider];

export const hasLiveProvider = providerRegistry.some((p) => p.isLive);

export function getProvider(id: string): ProviderAdapter | undefined {
  return providerRegistry.find((p) => p.id === id);
}
