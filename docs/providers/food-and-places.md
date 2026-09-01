# Real content pass: food, places, culture, sport imagery — provider research + what's live

This is the record for the PLOT-CONTENT directive ("real content + real imagery + maximum
discovery coverage"). It documents every provider actually researched, what's actually wired up
now, and exactly why the ones that aren't wired up aren't — not a research memo sitting apart
from the code; everything marked LIVE below is implemented and registered today.

## What changed

- **`providers/live/openStreetMap.ts`** (new, LIVE, no credential) — real restaurants, cafes,
  bars, pubs, museums, galleries, markets, and a handful of activity types (bowling, escape
  rooms, trampoline parks) across any UK city, queried via the Overpass API. Real venue names,
  coordinates, addresses, cuisines, websites. Replaces `mockRestaurantProvider`/
  `mockActivityProvider` in the production registry the same way a configured Ticketmaster key
  already replaced `mockTicketingProvider` — see `providers/registry.ts`'s own comment.
- **`lib/imageEnrichment.ts`** (new) — when a provider maps to no image, tries a legitimate open
  source before falling back to the branded editorial mark: TheSportsDB's team badges for SPORT,
  Wikipedia's own summary API (real Creative-Commons/public-domain photos from a subject's own
  Wikipedia infobox) for everything else. Wired into every sync via `inventorySync.ts`.
- **`Experience.imageSource`** (new schema column, `ImageSource` enum) — every real image now
  carries where it came from (`TICKETMASTER` / `OPENSTREETMAP` / `WIKIPEDIA` / `THESPORTSDB` /
  `MANUAL` / `EVENTBRITE`). `null` means no real image — the client renders the branded
  editorial fallback (`v2Art.ts`), never a stock photo (see "Image audit" below).
- **`POST /admin/experiences/manual`** can now accept a real operator-entered `imageUrl`
  (previously hardcoded to `null` regardless of input — a real gap for the "direct venue
  relationships" pilot path this endpoint exists for).
- **Eventbrite researched and resolved** — see `docs/providers/ticketing.md`'s updated section:
  confirmed dead for this use (2020 API restriction + 2025 official support end), not a
  credential gap. Implemented but not registered.

## Researched and explicitly rejected (not wired up, and why)

| Provider | Verdict | Why |
|---|---|---|
| **Yelp Fusion** | Rejected | Moved to paid-only in 2024 (from $7.99/1000 calls) — no free tier exists any more for restaurant search or photos. |
| **Foursquare Places API** | Rejected (for now) | Free tier (500 Pro calls/month + $200 credit, from June 2026) covers place *search*, but the **Photos endpoint is Premium-only**, no free tier — the one thing this directive cares about most. Revisit if a future pass needs richer place *metadata* without images; OpenStreetMap already covers the "real venue exists" need for free. |
| **Spotify Web API** | Rejected | Researched current (Sept 2026) developer terms in detail: February–July 2026 changes require the app owner to hold an active **Premium subscription** just to keep Development Mode working, cap unapproved apps to **5 allowlisted users**, and gate Extended Quota (real end-user traffic) behind **250k+ monthly active users on an already-registered organisation**. Structurally incompatible with serving real Plot users at any real scale — not a "get a key" problem. |
| **Bandsintown API** | Rejected (for now) | Not self-serve: requires emailing Bandsintown, describing the use case, and waiting for a manually-issued `app_id` — a real human approval step, not something obtainable in an automated session. If Will wants to pursue this: contact Bandsintown partnerships and provide `apps/api/src/providers/live/` as the integration pattern once an `app_id` exists. |
| **OpenTable / Resy / SevenRooms** | Already documented rejected | See `docs/providers/restaurants.md` — all partner-gated, unchanged. |
| **DICE / Resident Advisor / Songkick** | Already documented rejected | See `docs/providers/ticketing.md` — unchanged, still no public self-serve access. |

## Provider table

| Provider | Live? | Real data? | Auth required? | UK coverage | Categories | Real images? | Location? | Price? | Booking/action? | Rate limit | Limitations |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Ticketmaster Discovery API** | ✅ (needs `TICKETMASTER_API_KEY`) | Yes | Self-serve free key | Yes | Music, sport, film, theatre, comedy, art/culture, community | Yes, provider-supplied | Yes (venue lat/lng) | Yes (price ranges) | "View event" → real Ticketmaster URL | 5 req/s, 5000/day | Real commission needs the separate invite-only Partner API |
| **OpenStreetMap (Overpass)** | ✅ always (no key) | Yes | None | Yes | Restaurant, bar, cafe, pub, museum, gallery, market, a few activity types | Only when OSM's own `image` tag is a direct file (uncommon) — enrichment covers the rest | Yes (real coordinates) | No (OSM has no price data) | Real venue website when tagged, else a real OpenStreetMap.org permalink | Shared public instance — no hard quota, kept to a moderate query size/radius deliberately | No price data; "when to go" is a computed sensible time, never a real booking slot; independent restaurants without their own Wikipedia page won't get a photo via enrichment |
| **Wikipedia (image enrichment)** | ✅ always (no key) | Yes | None | N/A (global) | Any (name-matched) | Yes, when a confident match exists | N/A | N/A | N/A — enrichment only, not a discovery source | Reasonable per Wikimedia's own etiquette guidance | Only fires on an exact/close name match; a disambiguation page or 404 correctly yields no image rather than a wrong one |
| **TheSportsDB** | ✅ (shared free test key; `SPORTSDB_API_KEY` optional upgrade) | Yes | Free key (shared test key documented by TheSportsDB itself for light use) | Partial — skews toward larger/professional clubs | SPORT (image enrichment only, not discovery) | Yes, real team badges | N/A | N/A | N/A — enrichment only | Free-key result cap is 10 per query | Smaller/local teams often not in the database — falls through to Wikipedia enrichment on a miss |
| **Eventbrite** | ❌ implemented, not registered | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | Public event search killed for new keys in 2020, official API support ended 2025 — confirmed dead, not a credential gap |
| **Yelp Fusion** | ❌ | — | — | — | — | — | — | — | — | — | Paid-only since 2024, no free tier |
| **Foursquare Places** | ❌ | — | — | — | — | — | — | — | — | — | Free tier excludes Photos (Premium-only) |
| **Spotify Web API** | ❌ | — | — | — | — | — | — | — | — | — | 2026 Developer Mode changes cap unapproved apps at 5 users; Extended Quota needs 250k+ MAU |
| **Bandsintown** | ❌ | — | — | — | — | — | — | — | — | — | Requires manually-approved `app_id`, not self-serve |
| **OpenTable / Resy / SevenRooms** | ❌ | — | — | — | — | — | — | — | — | — | Partner-gated (see docs/providers/restaurants.md) |

## Image audit

- **Stock/generic photography found in the current pipeline: zero.** Audited the whole
  repository (`grep` across `apps/api/src`, `apps/web/src`, the Prisma schema for
  unsplash/picsum/pexels/pixabay/shutterstock/istockphoto/placeholder-service URLs) — the only
  hit was a code comment in `mock/ticketingProvider.ts` *documenting* that a `picsum.photos` seed
  was tried and deliberately removed before this session; no live code path generates one any
  more.
- **One real, live-caught exception, found and fixed this pass**: this session's own local dev
  database still had `Experience` rows carrying that old `picsum.photos` URL from before the
  removal — `imageUrl` was create-only in `inventorySync.ts`'s upsert, so a resync could never
  clear a stale value even once the source stopped producing one. Fixed (see `syncProvider`'s
  updated image-provenance logic) and proven with a dedicated test
  (`test/imageProvenance.test.ts`) rather than just asserted. Production's database should be
  checked the same way once a sync has run there — `GET /admin/providers` plus a spot check via
  `GET /explore/experiences?city=<city>` for any lingering `picsum.photos`/similar URL.
- **Real provider images now render** wherever Ticketmaster has one (already true before this
  pass) and wherever OpenStreetMap/Wikipedia/TheSportsDB enrichment finds one (new this pass).
- **Plot's editorial fallback** (`apps/web/src/lib/v2Art.ts`) is where every other card lands:
  a deliberately branded, per-category gradient + icon + texture treatment, never a photo
  pretending to be one. This is correct, intentional coverage for "no real image exists yet" —
  not a gap to close by faking one.

## Why "final evidence" (real music/comedy/food photos rendering in the app) isn't in this
document

This environment's outbound network is allowlisted to `api.github.com` only — confirmed by
direct `curl` to `overpass-api.de`, `en.wikipedia.org`, `thesportsdb.com`, and
`app.ticketmaster.com` (all `403`), and separately via the `WebFetch` tool against
`en.wikipedia.org` (`EGRESS_BLOCKED`). Every adapter above is written against each API's real,
stable, publicly-documented contract and is exercised by unit tests using realistic fixture data
(`test/unit/openStreetMapProvider.test.ts`, `test/unit/imageEnrichment.test.ts`,
`test/imageProvenance.test.ts`) and a live smoke test against the actual dev server confirming
graceful failure (a blocked Overpass call correctly logs a warning and returns zero results
rather than breaking the request — see the `explore.ts` example in this pass's session log) —
but none of it can be proven against the real internet from here. **Live evidence — a real
artist photo on a real gig, a real restaurant's real photo, a real team's real badge — needs to
come from the deployed Render service**, which has real outbound network access. Once
`TICKETMASTER_API_KEY` is set there (see `docs/DEPLOYMENT.md`) and a sync has run
(`POST /admin/sync`), `GET /explore/experiences?city=<a real city>` and `GET /admin/providers`
are the two endpoints to check this against — happy to look at that output the same way this
whole session has verified everything else live.
