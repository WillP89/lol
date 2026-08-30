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
