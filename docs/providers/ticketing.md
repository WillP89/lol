# Going live: ticketing & event providers

Plot ships with `mockTicketingProvider` (`apps/api/src/providers/mock/ticketingProvider.ts`),
shaped like a real aggregator response so the rest of the system (Match, dedup, quality
scoring) is already exercised against realistic data. Below is exactly what each real provider
needs before it can replace or sit alongside the mock.

## Ticketmaster
- **Access**: self-serve API key via [developer.ticketmaster.com](https://developer.ticketmaster.com) for the
  Discovery API (read-only event data). Real *commission* requires their **Partner API**,
  which is invite-only and requires an existing distribution relationship — see our earlier
  market research. Budget for a business-development conversation, not just an API integration.
- **Env**: `TICKETMASTER_API_KEY`
- **Implementation**: new file `src/providers/live/ticketmaster.ts` implementing `ProviderAdapter`;
  map Discovery API's `_embedded.events[]` (id, name, dates.start, _embedded.venues[],
  priceRanges[], classifications[], images[]) into `CanonicalListingInput`.
- **Rate limits**: 5 req/s, 5000 req/day on the free tier — the `withRetry` backoff in
  `lib/retry.ts` already handles 429s; add a token-bucket limiter if sync volume grows.

## DICE
- **Access**: partner API, commercial agreement required — no public self-serve key. Contact
  DICE partnerships.
- **Env**: `DICE_API_KEY` (placeholder until an agreement exists)

## Eventbrite — RESOLVED: confirmed non-functional for this use, not a credential gap
- **Access**: self-serve OAuth app + API key, free — **implemented**
  (`src/providers/live/eventbrite.ts`) but **deliberately not registered** in
  `providers/registry.ts`.
- **Update (September 2026)**: the "genuinely uncertain" caveat this section used to carry is
  now resolved by research, not a live call this environment still can't make. Eventbrite
  pulled public access to `GET /v3/events/search/` for all new self-serve keys in February
  2020 — a new key can only read events belonging to the key-holder's own organisation, which
  is a different, useless feature for a discovery app that isn't Eventbrite's own event
  organisers — and Eventbrite ended official API support entirely by 2025 (community-forum
  support only since). **A real `EVENTBRITE_API_KEY` would not fix this**; there is no
  credential blocker here, the endpoint this adapter needs simply doesn't exist for new apps
  any more.
- **Env**: `EVENTBRITE_API_KEY` — kept in config.ts, not currently used by anything registered.
- **If Eventbrite ever reopens search or exposes a replacement endpoint**: the adapter's
  `mapCategory`/`mapToCanonical` would still be correct for a similarly-shaped response — only
  `fetchPage`'s URL would need to change, and it would need re-registering in registry.ts.

## Resident Advisor / Songkick / Bandsintown
- No public commercial API as of writing for RA; Songkick's API is deprecated for new
  partners. These are realistically **scrape-and-verify or manual-curation** sources for the
  pilot (`POST /admin/experiences/manual` — see `docs/DECISIONS.md#local-supply`), not adapter integrations.

## Adding any of the above
1. Implement `ProviderAdapter` in `src/providers/live/<name>.ts`.
2. Add the credential to `src/lib/config.ts` (already scaffolded for the four above).
3. Register the adapter in `src/providers/registry.ts`.
4. Nothing else changes — `inventorySync.ts`, the Match engine, and dedup all operate on the
   canonical shape, not the provider.
