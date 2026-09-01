import type { ProviderAdapter } from './types';
import { mockTicketingProvider } from './mock/ticketingProvider';
import { mockRestaurantProvider } from './mock/restaurantProvider';
import { mockActivityProvider } from './mock/activityProvider';
import { ticketmasterProvider } from './live/ticketmaster';
import { eventbriteProvider } from './live/eventbrite';
import { openStreetMapProvider } from './live/openStreetMap';
import { config } from '../lib/config';

void eventbriteProvider; // kept implemented, deliberately not registered — see the file's own comment

/**
 * Every provider adapter, real or mock, registers here. `docs/providers/*.md` documents
 * exactly what's needed to add each real one (Ticketmaster, DICE, ...) — the pattern is
 * always: implement `ProviderAdapter`, add credentials to config.ts if it needs any, register
 * it here. Nothing else in the codebase needs to change.
 *
 * Each live ticketed-events adapter registers independently as its own key is configured —
 * more than one can run at once, the normal case for "every source possible", not either/or.
 * Eventbrite is implemented but NOT registered: researched and confirmed (September 2026, see
 * its own file's top comment) that Eventbrite cut public event search off for new keys in 2020
 * and ended official API support entirely by 2025 — a real EVENTBRITE_API_KEY would not make
 * this adapter return real inventory, so presenting it as a "live" option the moment a key is
 * set would itself be the fake coverage the PLOT-CONTENT directive forbids.
 *
 * `openStreetMapProvider` needs no credential at all (a public API) and is always registered —
 * real restaurant/cafe/bar/pub/museum/gallery/market/attraction inventory across any UK city,
 * closing the exact gap this file used to document as unsolvable ("no self-serve restaurant/pub
 * API exists at all"). It REPLACES `mockRestaurantProvider`/`mockActivityProvider` in the live
 * registry for the same reason a configured Ticketmaster key replaces `mockTicketingProvider`:
 * once a real source exists, showing fabricated availability slots next to it — with no way for
 * a user to tell which is which — is exactly the "silently mixing stock and real imagery/data"
 * the directive forbids. The mocks stay in the codebase (imported by tests, and available as an
 * explicit dev/QA fallback — see docs/providers/food-and-places.md) but are not part of the
 * production registry any more.
 *
 * If NO live ticketed source exists at all, the ticketed-events mock is the only source for
 * that category, and that fact is surfaced to the client (GET /admin/providers, and Explore/
 * Discover's "sample events" banner) rather than silently presented as real inventory. See
 * docs/DECISIONS.md#real-events.
 */
const liveTicketedProviders: ProviderAdapter[] = [
  ...(config.TICKETMASTER_API_KEY ? [ticketmasterProvider] : []),
];

// Same convention already used for media storage (lib/mediaStorage.ts) and email
// (lib/email.ts): `NODE_ENV=test` gets the deterministic, network-free local/mock path, dev and
// production get the real one. `openStreetMapProvider` makes a genuine HTTP call to a public
// API with no credential gate to skip in tests the way a missing API key already skips
// Ticketmaster — without this check, every test run that seeds inventory (golden-path.test.ts's
// `syncAllProviders`, `ensureInventory`) would make a real network call to a third-party
// service: slow, flaky, and something this specific sandbox's own egress policy blocks outright
// (see openStreetMap.ts's file comment) — the whole test suite would fail here, not just skip.
const isTestEnv = config.NODE_ENV === 'test';

export const providerRegistry: ProviderAdapter[] = isTestEnv
  ? [mockTicketingProvider, mockRestaurantProvider, mockActivityProvider]
  : [...(liveTicketedProviders.length > 0 ? liveTicketedProviders : [mockTicketingProvider]), openStreetMapProvider];

export const hasLiveProvider = providerRegistry.some((p) => p.isLive);

// A real, distinct signal from `hasLiveProvider`: `openStreetMapProvider` being always-live now
// means `hasLiveProvider` alone can no longer answer "are ticketed EVENTS (concerts, gigs,
// shows) real or fabricated?" — a real gap this specific change would otherwise have created,
// caught before shipping: Explore/Discover's "Sample events — no live provider connected yet"
// banner reads as being about ticketed events specifically, and without this it would have
// silently stopped showing the moment OpenStreetMap alone made the broader flag true, even with
// zero real event coverage and TICKETMASTER_API_KEY still unset. Restaurants/places being real
// is a genuinely different fact from events being real — see docs/providers/food-and-places.md.
export const hasLiveTicketedProvider = liveTicketedProviders.length > 0;

export function getProvider(id: string): ProviderAdapter | undefined {
  return providerRegistry.find((p) => p.id === id);
}
