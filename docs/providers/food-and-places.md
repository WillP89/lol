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
| **OpenStreetMap (Overpass)** | ✅ always (no key) | Yes | None | Yes | Restaurant, bar, cafe, pub, nightclub, cinema, theatre, museum, gallery, market, gym/pool/sports centre, golf, ice rink, horse riding, a few activity types | Only when OSM's own `image` tag is a direct file (uncommon) — enrichment covers the rest | Yes (real coordinates) | No (OSM has no price data) | Real venue website when tagged, else a real OpenStreetMap.org permalink | Shared public instance — no hard quota, kept to a moderate query size/radius deliberately | No price data; "when to go" is a computed sensible time, never a real booking slot; independent restaurants without their own Wikipedia page won't get a photo via enrichment |
| **PredictHQ** | ✅ (needs `PREDICTHQ_ACCESS_TOKEN`) | Yes | Self-serve signup, current pricing unverified from this sandbox | Yes (real lat/lng radius search) | Community, concerts, festivals, food & drink, performing arts, sport | No (falls into the same enrichment chain as OSM) | Yes (real lat/lng) | No (PredictHQ has no price data) | No public click-through URL — externalUrl is a real Google Maps search for the venue, not a booking link | Unverified from this sandbox — check predicthq.com/pricing | See docs/providers/ticketing.md's own section for the full writeup |
| **Wikipedia (image enrichment)** | ✅ always (no key) | Yes | None | N/A (global) | Any (name-matched) | Yes, when a confident match exists | N/A | N/A | N/A — enrichment only, not a discovery source | Reasonable per Wikimedia's own etiquette guidance | Only fires on an exact/close name match; a disambiguation page or 404 correctly yields no image rather than a wrong one |
| **TheSportsDB** | ✅ (shared free test key; `SPORTSDB_API_KEY` optional upgrade) | Yes | Free key (shared test key documented by TheSportsDB itself for light use) | Partial — skews toward larger/professional clubs | SPORT (image enrichment only, not discovery) | Yes, real team badges | N/A | N/A | N/A — enrichment only | Free-key result cap is 10 per query | Smaller/local teams often not in the database — falls through to Wikipedia enrichment on a miss; NOT used for discovery — see "Round 2" section below for why (fixtures are queried by league, not by location) |
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

## Round 2 — closing the "I only see comedy and live music" gap

Real, live-reported product complaint: category variety was way too narrow — comedy and live
music dominated both what Explore showed and what the automatic recommendation engine actually
sent to Crews, with none of "food, drinks, restaurants, motorbike events, random events, horse
racing, whatever it is, we hold it". Root cause isn't a bug in the matching engine
(`services/match.ts` pulls its top-50 candidate pool with no category filter at all — it scores
whatever `Experience` rows exist) — it's that too few rows of anything else existed to score. Two
real, structural reasons: (1) Ticketmaster + Skiddle are both genuinely self-serve, but both are
ticketed-*listings* sites, and their own real UK catalogue for a small town skews toward comedy
nights and gigs inside any 3-week candidate window; (2) OpenStreetMap was only being asked for a
fraction of the real, free, no-credential categories it actually has data for. Fixed both ways —
add a genuinely different-shaped source, and stop leaving free real data on the table:

- **OpenStreetMap query widened** (`providers/live/openStreetMap.ts`) — no new credential, same
  source already live. Added: `amenity=nightclub` → CLUBBING (previously had exactly one real
  source, Skiddle's own CLUB eventcode), `amenity=cinema` → CINEMA and `amenity=theatre` →
  THEATRE (real local venues beyond ticketed listings), `leisure=fitness_centre` /
  `sports_centre` / `swimming_pool` → FITNESS (previously **zero real source at all** — every
  FITNESS row was mock-only), plus `golf_course` / `ice_rink` / `horse_riding` folded into the
  existing DAY_ACTIVITY leisure bucket.
- **PredictHQ added** (`providers/live/predicthq.ts`, needs `PREDICTHQ_ACCESS_TOKEN`) — see
  `docs/providers/ticketing.md`'s own section for the full writeup, including the one real
  limitation (no public click-through URL) worth reading before applying. This is the one that
  most directly targets "whatever it is" — its own categories include `food-drink` and
  `community`, which is where genuinely oddball local stuff (markets, fairs, tastings, meets)
  actually gets listed by the organisations that run PredictHQ's source feeds.

### "Horse racing" and "motorbike events" specifically — the honest answer

Neither has a realistic self-serve public API in the UK, and that's worth saying plainly rather
than quietly hoping PredictHQ or OSM happens to cover it:

- **Horse racing**: the BHA (British Horseracing Authority) and individual racecourses don't
  publish a public fixtures API. OSM's `leisure=horse_riding` tag (added this pass) is real data,
  but it's riding centres/schools, NOT race meetings — deliberately not relabelled as anything
  closer to "horse racing" than that honestly supports. PredictHQ's `sports` category may
  surface a well-known meeting (Cheltenham, Aintree) if one of its source feeds lists it, but
  this is opportunistic, not systematic coverage.
- **Motorbike events**: bike nights, ride-outs and grassroots motorsport meets are organised
  hyper-locally (a pub car park, a bike shop, a Facebook group) and simply aren't indexed by any
  of the sources above, or by any other API found in this research pass.
- **The realistic path for both**: `POST /admin/experiences/manual` (see
  `docs/DECISIONS.md#local-supply`) — exactly the same mechanism already used for the
  Uttoxeter Racecourse example in `mock/activityProvider.ts`. A handful of known recurring local
  fixtures (a racecourse's own published calendar, a bike shop's monthly meet) entered by an
  operator is genuinely more reliable here than chasing an API that doesn't exist.

### Newly researched this pass — candidates NOT implemented, and exactly why

| Provider | Verdict | Why |
|---|---|---|
| **Google Places API** | Recommended follow-up, not implemented | By far the broadest real category taxonomy (150+ place types — bowling, karting, escape rooms, motorcycle dealers, stadiums, the lot), with real photos and ratings. NOT implemented now because it's a genuine commercial decision, not a technical one: requires a billing account and is pay-per-request beyond a monthly free credit. Worth a dedicated follow-up pass once Will decides the cost is worth it for richer place data than OSM's patchier small-town tagging — a real tradeoff to make deliberately, not default into. |
| **AllEvents.in API** | Candidate, unverified | Self-serve developer API (developer.allevents.in) with broad worldwide category coverage including community/hobby events, which could plausibly pick up grassroots UK listings OSM/PredictHQ miss. Data quality/depth for small UK towns specifically is unverified — this environment's egress block means it can't be tested here. Worth a real evaluation against a live key before committing engineering time to an adapter. |
| **VisitEngland / VisitBritain tourism data** | Candidate, needs partner registration | Real UK tourism-board attraction/days-out listings — a strong fit for the DAY_ACTIVITY category specifically. Access is via their own partner/datahub registration (a business step, not a "get a key and go" self-serve flow), so this is a recommendation for Will to pursue directly rather than something this session can complete blind. |
| **Meetup API** | Rejected (for now) | Meetup's public API closed for general free use years ago; current access is a restricted, commercial "Pro API" partnership, not self-serve — same shape of blocker as Bandsintown's manual `app_id`, just with a heavier commercial layer on top. |
| **TheSportsDB as a discovery source (not just image enrichment)** | Rejected — real technical reason, not just unexplored | TheSportsDB's fixture endpoints are queried by LEAGUE (e.g. "English Premier League"), returning that league's next fixtures nationwide — there's no location-radius search. Using it for SPORT discovery would mean showing a Stafford Crew a fixture in a city hundreds of miles away with no real way to filter by "is this actually near this Crew" without a second lookup per team's home venue and a lot more engineering than the category gap currently justifies. Stays exactly where it already earns its keep: image enrichment by name (`lib/imageEnrichment.ts`), not discovery. |
| **Ergast / Jolpica F1 API** | Considered, not worth it | Real, free, no key, gives the full F1 calendar — but F1 is a narrow slice of "motorsport", doesn't cover MotoGP/BTCC/grassroots motorbike events at all, and a UK Crew is realistically not travelling to an F1 race as a spontaneous "Plot found this" suggestion. Not a good ROI for a dedicated adapter. |

**Still confirmed rejected from the first research pass, unchanged**: Yelp Fusion (paid-only since
2024), Foursquare Places (Photos endpoint Premium-only), Spotify Web API (2026 terms
structurally incompatible with real user volume), Bandsintown (manual `app_id` approval, not
self-serve), OpenTable/Resy/SevenRooms (partner-gated — `docs/providers/restaurants.md`),
DICE/Resident Advisor/Songkick (no public self-serve access — `docs/providers/ticketing.md`),
Eventbrite (confirmed dead for new keys, not a credential gap).

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
