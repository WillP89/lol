# Architecture

## System overview

```
apps/web (Next.js)  --/api/*-->  apps/api (Fastify)  --Prisma-->  PostgreSQL
                                        |
                                        +--> providers/* (adapter interface; mock + docs for real ones)
```

One Postgres database, one API process, one web process. Deliberately not microservices, not
a queue-based architecture, not multi-region — see "What breaks at scale" below for exactly
when each of those stops being true and what to do about it. Building for a scale we don't
have users for yet is its own failure mode (brief §"do not spend six months building
theoretical infrastructure before users touch it").

## Why these technologies, why now, what breaks, how we migrate

**PostgreSQL + Prisma.** Why: relational data with real foreign keys (a Plan belongs to
exactly one Crew, a Vote belongs to exactly one Plan and one User) is the actual shape of this
domain — forcing it into a document store would mean re-implementing joins in application
code. Prisma gives real migrations, a typed client, and is boring/well-understood, which
matters more than raw performance at pilot scale. What breaks: a single Postgres instance
comfortably handles the pilot and low-tens-of-thousands-of-users scale; past that, read
replicas for the Match engine's candidate queries (read-heavy) are the first lever, not a
database rewrite. Migration: none needed until then — Postgres scales vertically a long way
first.

**Fastify.** Why: faster and lighter than Express, first-class TypeScript, plugin model that
matches how this codebase is organised (routes/services/providers as clean boundaries). What
breaks: nothing at pilot scale; Fastify handles far more throughput than one process will see
before the API itself needs horizontalizing (see rate-limiting note below for what that
requires first).

**Next.js (App Router).** Why: the Plan Card (brief §16) needs real server-rendered
OpenGraph metadata for WhatsApp/iMessage previews — a pure SPA can't do that. Server
components for that page, client components everywhere else, one framework instead of two.
What breaks: nothing meaningful before real scale; Vercel or any Node host handles this
without change.

**Session-based auth (opaque token + HMAC, not JWT).** Why: instant, real revocation
(logout-everywhere on account deactivation/deletion, brief §9) — a stateless JWT can't be
revoked without a denylist, which is just a session store with extra steps. See
`src/lib/crypto.ts`. What breaks: nothing until multi-instance (see below).

**In-memory rate limiting.** Why: zero-dependency, correct for a single API instance, which
is what the pilot runs. **What breaks: the moment the API runs on more than one instance
behind a load balancer**, each instance has its own counts and the limiter silently stops
being a real limit. **This is the single most important "don't scale past this without
fixing it first" line in the codebase.** Migration: swap `src/lib/rateLimit.ts` for a
Redis-backed limiter (e.g. `rate-limiter-flexible` with a Redis store) — the call sites in
`services/auth.ts` don't need to change, only the implementation behind `isRateLimited`.

**One canonical `Experience` entity, not per-category tables.** See `prisma/schema.prisma`'s
top comment and `#canonical-vs-listing` in DECISIONS.md.

**One `IntentSignal` event log, not N interaction tables.** See `#event-log` in
DECISIONS.md.

## Provider abstraction

`src/providers/types.ts` defines `ProviderAdapter` — every inventory source (real or mock)
implements `fetchListings` + `mapToCanonical` + `healthCheck`. `services/inventorySync.ts`
runs any adapter through fetch → map → dedup (`entityResolution.ts`) → quality score
(`qualityScoring.ts`) → upsert, independently per listing so one bad record or one dead
provider never takes down the others (brief §42/§44). See `docs/providers/*.md` for exactly
what each real provider needs.

## Match engine

`services/match.ts` — four layers: hard constraints (SQL WHERE, not application filtering),
preference scoring (TasteProfile category affinity + CrewDNA), context (budget fit, real
AvailabilityWindow-derived free/busy), and a `LearnedRanker` hook that is currently a no-op
identity function. Every option carries `reasons[]` so results are explainable, not a black
box. See `#recommendation-system` in DECISIONS.md for why ML isn't in Layer 4 yet.

## Plan Pulse

`services/plan.ts#derivePulseStatus` is a pure function over vote counts — there is exactly
one legal status for a given vote distribution, recomputed on every vote rather than stored as
a transition table, so status can never drift out of sync with the votes that produced it.

## Analytics

`packages/shared/src/analytics.ts` is the single source of truth for event names and payload
shapes, imported by both apps so client and server can't drift. `services/analytics.ts#track`
is the one write path into `IntentSignal`; failures there are logged, never thrown — analytics
must not be the reason a user-facing request fails.

## Roadmap phases (see docs/PILOT.md and docs/ANTI_ROADMAP.md for the detail)

| Phase | Scope |
|---|---|
| **Pilot (this codebase)** | Real Crews, real Match/Plan/Booking loop, mock+manual inventory, deep-link booking only |
| **V1** | Real independent-venue inventory, calendar OAuth sync, Rewind-trained ranking, Deciders |
| **V2** | Native group checkout, compound multi-stop plans, second/third cities |
| **Platform** | Group-aware recommendation API, natural-language planning agent, exclusive supply |
