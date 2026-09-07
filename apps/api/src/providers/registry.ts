import type { ProviderAdapter } from './types';
import { mockTicketingProvider } from './mock/ticketingProvider';
import { mockRestaurantProvider } from './mock/restaurantProvider';
import { mockActivityProvider } from './mock/activityProvider';
import { ticketmasterProvider } from './live/ticketmaster';
import { eventbriteProvider } from './live/eventbrite';
import { skiddleProvider } from './live/skiddle';
import { predictHqProvider } from './live/predicthq';
import { openStreetMapProvider } from './live/openStreetMap';
import { fhrsProvider } from './live/fhrs';
import { googlePlacesProvider } from './live/googlePlaces';
import { foursquareProvider } from './live/foursquare';
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
 * Skiddle (see live/skiddle.ts) is a second, independent ticketed-events source alongside
 * Ticketmaster — different real inventory (club nights, UK festivals, comedy, smaller venues),
 * not a duplicate. PredictHQ (see live/predicthq.ts) is a THIRD, genuinely different-shaped
 * source again — a broad events-intelligence aggregator (community, festivals, food & drink,
 * performing arts, sport) rather than another ticketed-listings site, added specifically because
 * Ticketmaster + Skiddle's own real UK catalogue for a small town skews toward comedy/live music
 * in any given few-week window — see that file's own header for two things to verify (current
 * pricing, and its lack of a public click-through URL) before relying on it. Eventbrite is
 * implemented but NOT registered: researched and confirmed (September 2026, see
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
 *
 * `fhrsProvider` (UK Food Standards Agency FHRS open data — live/live/fhrs.ts) needs no
 * credential either, same as OpenStreetMap, and is always registered alongside it as a SECOND,
 * independent restaurant/pub source — entityResolution.ts's own dedup already handles the same
 * real venue appearing in both. `googlePlacesProvider` and `foursquareProvider` are each real,
 * genuinely different-shaped places sources again, but both are real commercial APIs requiring
 * a key an operator has to go get (Google's is pay-as-you-go past a free credit; Foursquare has
 * a genuine free tier) — each registers independently the moment its own key is configured,
 * same "more than one runs at once" pattern as the ticketed sources above. See
 * docs/providers/food-and-places.md for what each of these three actually gives, and their own
 * files' header comments for the full research/trade-off writeup.
 */
const liveTicketedProviders: ProviderAdapter[] = [
  ...(config.TICKETMASTER_API_KEY ? [ticketmasterProvider] : []),
  ...(config.SKIDDLE_API_KEY ? [skiddleProvider] : []),
  ...(config.PREDICTHQ_ACCESS_TOKEN ? [predictHqProvider] : []),
];

const livePlacesProviders: ProviderAdapter[] = [
  fhrsProvider,
  ...(config.GOOGLE_PLACES_API_KEY ? [googlePlacesProvider] : []),
  ...(config.FOURSQUARE_API_KEY ? [foursquareProvider] : []),
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
  : [...(liveTicketedProviders.length > 0 ? liveTicketedProviders : [mockTicketingProvider]), openStreetMapProvider, ...livePlacesProviders];

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

// Skiddle's own API terms require crediting them "by name and brand logo" wherever their data
// is shown — a real, distinct signal from `hasLiveTicketedProvider` (which would stay true from
// Ticketmaster alone with SKIDDLE_API_KEY unset) so the client can show that credit only when
// Skiddle inventory can actually be present. See routes/explore.ts and docs/providers/ticketing.md.
export const hasSkiddleProvider = Boolean(config.SKIDDLE_API_KEY) && !isTestEnv;

export function getProvider(id: string): ProviderAdapter | undefined {
  return providerRegistry.find((p) => p.id === id);
}
