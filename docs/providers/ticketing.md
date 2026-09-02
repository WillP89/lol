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

## Skiddle
- **Access**: genuinely self-serve, free — apply at
  [skiddle.com/api/join.php](https://www.skiddle.com/api/join.php). No business-development
  conversation required, unlike Ticketmaster's Partner API. A second, independent live
  ticketed-events source alongside Ticketmaster — real inventory Ticketmaster doesn't carry
  (independent club nights, UK festivals, comedy nights, smaller/grassroots venues), not a
  duplicate of it.
- **Env**: `SKIDDLE_API_KEY`
- **Implementation**: `src/providers/live/skiddle.ts`, implementing `ProviderAdapter`. Skiddle's
  `eventcode` query param takes exactly one value per request, so one sync makes several
  requests per city — one per requested category (FEST/LIVE/CLUB/COMEDY/THEATRE/ARTS/SPORT),
  spaced ~350ms apart. Maps `results[]` (id, eventname, description, date, openingtimes,
  entryprice, venue.{name,latitude,longitude}, largeimageurl/imageurl, link, EventCode,
  cancelled) into `CanonicalListingInput`. `entryprice` is Skiddle's own free-text display
  string ("£12.50", "Free", "£10 - £15") — parsed best-effort, never guessed when it isn't
  price-shaped.
- **Rate limits**: no official published quota. Observed real-world pacing from actively
  maintained open-source consumers of the same endpoint is used as a polite default
  (`REQUEST_SPACING_MS` in the adapter) — not a hard requirement this codebase can otherwise
  verify. `withRetry`'s shared backoff handles the occasional failure.
- **Real legal constraints, not just technical ones** — read before applying for a key:
  - Skiddle's API terms require crediting **Skiddle by name and brand logo** wherever their
    data is shown. Plot satisfies the "by name" half at the UI layer (Explore's own
    attribution line, same pattern as the OpenStreetMap ODbL credit) — a brand-logo asset
    would need adding alongside it if Skiddle's terms are read strictly on that point.
  - Every result must link out via Skiddle's own unmodified `link` field — never rewritten or
    proxied. The adapter satisfies this by construction: `externalUrl` is always that field,
    untouched.
  - Skiddle's data itself must not be modified. The adapter passes `description` through
    as-is (falling back to a generated line only when Skiddle's own field is empty), and never
    rewrites `eventname`.
  - **Worth addressing honestly in the API application, not glossed over**: Skiddle's terms
    prohibit use on anything that "directly competes with the business activity of Skiddle
    Ltd." Plot is a Crew-planning app that surfaces events as one of several real-world
    activity types (alongside restaurants, bars, museums, sport) — not an events listings
    site — but it's close enough to Skiddle's own product shape that this is worth stating
    plainly in the application rather than hoping it isn't noticed. If Skiddle pushes back,
    the honest fallback is to keep Ticketmaster + OpenStreetMap and not chase this one.
  - **Separate from the plain data-API key**: Skiddle also runs an affiliate/commission
    programme, applied for independently at
    [skiddle.com/affiliates/join.php](https://www.skiddle.com/affiliates/join.php) (30%+
    commission per their public materials). The adapter ships with `commissionEligible: false`
    until that's actually joined and confirmed — flipping it prematurely would misrepresent
    real booking economics to the rest of the product (Plan Pulse, booking flows) the same way
    a fabricated price would.
- **Not exercised against the live API from this environment** — outbound network to
  www.skiddle.com isn't reachable from this sandbox (the same restriction that blocks every
  other live provider — Ticketmaster, Wikipedia, Overpass, postcodes.io). Written against
  Skiddle's own documented API contract; verify against Render's own logs once a real key is
  configured there.

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
