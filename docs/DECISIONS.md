# Decisions

Anchored sections referenced from code comments throughout the codebase. Each is a real
tradeoff we made deliberately, with the honest downside written down rather than hidden —
the point of this file is that a future engineer (including us, in six months) can find out
*why* without archaeology.

## #canonical-vs-listing

See `prisma/schema.prisma`'s top-of-file comment. Short version: one canonical `Experience`
entity with a category enum + JSON tag bag, not separate Event/Restaurant/Performance tables,
because Match/dedup/quality-scoring would otherwise need N near-identical code paths.

## #event-log

One `IntentSignal` table (`name` + typed JSON `payload`, validated at the application layer
against `packages/shared/src/analytics.ts`) instead of a table per interaction type
(SearchInteraction, RecommendationInteraction, ...). Adding an event is a one-line change to
shared code, not a migration. Downside: no DB-level schema enforcement on payload shape —
mitigated by the shared taxonomy being the only import path callers use.

## #rate-limiting

In-memory, single-instance only. See ARCHITECTURE.md — this is the first thing to fix before
running more than one API instance.

## #entity-resolution

Two-stage: deterministic `canonicalKey` (name+venue+date) for exact duplicates, a Jaccard
token-overlap heuristic for near-duplicates that does NOT auto-merge below 0.82 similarity.
Honest limitation: under-merges genuinely differently-named listings of the same thing,
over-merges coincidental near-matches at small venues. Correct long-term fix is embedding
similarity once there's enough real multi-provider overlap to justify training/tuning one —
premature before then.

## #venue-identity

`Venue` has no natural unique constraint beyond `id` (two venues can share a name across
cities). We look up by `(name, city)` and create on miss rather than misusing Prisma's
`upsert` against a synthetic id. Downside: a genuine race (two syncs creating the same venue
concurrently) could create a duplicate Venue row — acceptable at pilot sync volume/frequency;
a unique constraint on `(name, city)` is the fix if it ever actually happens.

## #quality-scoring

Weighted so that validity + freshness (30 pts max) can never alone cross
`MIN_PUBLISHABLE_QUALITY_SCORE` (40) — completeness (description, image, price, tag richness;
70 pts) has to contribute. A listing that's technically valid and freshly fetched but has no
description, image or price is still not fit to show a group deciding what to do. Popularity/
booking-conversion/cancellation-history inputs from the fuller brief list are real signals but
need real usage volume to be meaningful — staged for V1 once there's data to compute them
from, not invented now.

## #recommendation-system

Layer 4 (`LearnedRanker` in `services/match.ts`) is currently the identity function — it does
not reorder anything. We do not believe there is enough RewindSignal/BookingCompleted history
to train a real ranker yet; adding one now would mean fitting noise and calling it
intelligence. The interface exists so swapping in a real model later is a drop-in, not a
rewrite.

## #cold-start-defaults

A brand-new Crew with no completed-plan history defaults to Fri/Sat best-nights and LOW DNA
confidence rather than fabricating false precision (brief §12 "do not fake confidence"). See
`services/crewDna.ts`.

## #rewind-not-memory-reel

Rewind ships as a single tap ("would your Crew do this again?") instead of a photo/memory-reel
feature. It's the cheapest possible surface that produces real training signal, and it doesn't
compete with what Instagram/BeReal already do well — see the phase-2 strategy work on why
Plot should not become a photo-sharing app.

## #booking-models

Only Model A (deep link) is implemented. Models B (affiliate)/C (API)/D (native) all require
commercial agreements or a verified payments account that don't exist yet (see
`docs/providers/`) — the `BookingModel` enum and `Booking`/`Payment` schema exist so adding
them later is additive, not a migration.

## #local-supply

Restaurant and independent-venue inventory realistically comes from direct relationships
(a venue emails their weekly availability, an operator enters it via `POST
/admin/experiences/manual`) rather than any single aggregator API — OpenTable, Resy and
SevenRooms are all partner-gated per `docs/providers/restaurants.md`. This is why manual
curation goes through the exact same canonical pipeline (`canonicalKey`, quality scoring) as
an automated provider sync: Match can't tell the difference, and it shouldn't have to.

## #admin-auth

`/admin/*` is gated by a single shared-secret header (`ADMIN_API_KEY`), not real role-based
auth. This is a deliberate pilot-stage stopgap for a team of one or two operators. It must be
replaced with real per-operator auth (a `User.role` enum + session-based admin auth) before
more than a couple of people touch it — a shared secret has no audit trail of *who* did an
admin action, only that *someone* with the key did.

## #test-database

Integration tests run against a real, separate Postgres database (`plot_test`), not a mocked
Prisma client. `test/setup.ts` redirects `DATABASE_URL` before any app code is imported. We
chose this deliberately over mocking the ORM: the thing most likely to break this product is a
wrong assumption at a component boundary (a Prisma relation, a transaction, a real constraint
violation), and mocking that boundary out is exactly how you stop catching it.

## #crew-chat

A simple per-Crew group chat (`CrewMessage`), added after a founding-team demo (a static,
disconnected HTML prototype — see the demo's own header, "Prototype · Founding team review")
was mistaken for the real, functional app. That demo depicted no chat feature at all — Plot's
whole thesis is replacing the group chat, not adding one — so this is new scope, not something
that regressed.

Deliberately minimal for the pilot: text only, no read receipts, no typing indicators, no
edit/delete, no threading. The web client polls `GET /crews/:id/messages` (optionally with
`?after=<lastMessageId>`) every few seconds rather than a websocket/SSE transport — the
simplest thing that works for a pilot-sized Crew (a handful of people talking occasionally),
not a chat app's worth of real-time infrastructure. Membership (`isCrewMember`), not
authorship, gates both read and write, reusing the same crew-membership check the rest of the
Crew surface already uses.

Upgrade path once polling stops being good enough (larger Crews, users expecting sub-second
delivery): swap the transport for SSE or a websocket without touching the data model —
`CrewMessage` doesn't encode anything about how it's delivered.

## #explore-map

The founding-team demo's "map" screen is CSS gradients and absolutely-positioned divs — no
map provider, no real coordinates. A real one turned out to be cheap to build because the data
already supported it: the mock provider adapters (`providers/mock/*.ts`) carry real London
venue lat/lng, and `Venue.latitude`/`longitude` were already real columns. `GET
/explore/experiences?city=` reuses Match's Layer-1 hard constraints (quality score, not sold
out, within the candidate window) without the crew-specific scoring — it's a browse view, not
a recommendation — and the web app renders it with Leaflet + OpenStreetMap tiles (free, no API
key) rather than a paid provider like Mapbox/Google Maps, which is the right tradeoff until
there's a reason (offline tiles, custom styling) to pay for one.

One related gap this surfaced: nothing in the codebase ever called `syncAllProviders` outside
the manual `POST /admin/sync` endpoint, so a freshly migrated database has zero `Experience`
rows and both Match and Explore would silently return empty. `ensureInventory(city)`
(`services/inventorySync.ts`) self-heals this — it syncs once if a city looks unseeded — which
is safe only because the registered providers are in-memory mocks with no real API cost or
rate limit. A real provider adapter should keep going through the scheduled `/admin/sync` path
instead of leaning on this fallback.

## #real-events

Ticketmaster's Discovery API (`providers/live/ticketmaster.ts`) is the first real provider,
per docs/providers/ticketing.md's existing plan. `providers/registry.ts` registers it — and
only it, dropping both mocks entirely — the moment `TICKETMASTER_API_KEY` is set; without a
key, the mocks are the only source, same as before. This is a deliberate either/or, not
mock-plus-real: presenting fabricated sample events alongside real bookable ones with no way
to tell them apart would be actively misleading once real inventory exists.

`hasLiveProvider` (registry.ts) is threaded through `GET /explore/experiences` and
`POST /crews/:id/find-us-something` as a `dataSource: 'live' | 'mock'` field, and the web app
shows an explicit "Sample events — no real event provider connected" banner whenever it's
`'mock'`. The alternative — silently rendering fake events as if they were real — is exactly
what was explicitly ruled out.

Not verified against a live Ticketmaster account: this was written in an environment with no
outbound network access to `app.ticketmaster.com`. The category/booking-status mapping logic
is unit-tested against hand-built fixtures shaped like real Discovery API responses
(`test/unit/ticketmaster.test.ts`), which catches a wrong mapping but not "does our actual API
key work" or "does Ticketmaster's real response shape match what we assumed" — that needs a
real key and a real request against the deployed service.

`ensureInventory`'s "sync once if this city has zero Experience rows, then never again" logic
(see above) is a real limitation once a live provider is involved: it means a city's event
data, once synced, never refreshes on its own — no cron, no staleness check. Fine for a first
pilot city seeded once; a real ongoing product needs a scheduled `POST /admin/sync` (e.g. a
Render Cron Job hitting it daily) rather than relying on this on-demand fallback indefinitely.
