# Plot

**The decision layer for real-world social life.** Turns "we should do something" into a
confirmed plan for a specific group of people — Match → Agree → Lock.

This is the pilot-foundation codebase: a real backend (Postgres + Fastify + TypeScript), a
real web app (Next.js), and a real, tested implementation of the core loop — not a prototype.
See `docs/ARCHITECTURE.md` for how it's built and why, `docs/PILOT.md` for what "done" means
for the pilot, and `docs/ANTI_ROADMAP.md` for what's deliberately not here yet.

## What's real vs. what's a documented gap

Real: auth (email magic-link), the full Crew/Plan/Match/Booking data model against a real
Postgres database, the Match recommendation engine, Plan Pulse state machine, deep-link
booking, Rewind, analytics event log, a golden-path integration test suite, and a working
Next.js web app driving all of it.

Deliberately not real yet, with exactly what's needed to make them real documented in
`docs/providers/`: OAuth sign-in (needs paid developer accounts), native payments (needs a
verified Stripe business account), real ticketing/restaurant inventory (needs commercial
agreements — DICE, OpenTable et al. are partner-gated, not self-serve), transactional email
(needs a sending domain).

## Prerequisites

- Node.js 20+
- PostgreSQL 16 running locally (or point `DATABASE_URL` at any Postgres instance)

## Setup

```bash
npm install

# Create databases (adjust user/password to taste)
createuser plot --createdb --pwprompt   # or: psql -c "CREATE USER plot WITH PASSWORD '...' CREATEDB;"
createdb -O plot plot_dev
createdb -O plot plot_test

cp apps/api/.env.example apps/api/.env   # then edit DATABASE_URL, SESSION_SECRET, TOKEN_HASH_SECRET
cd apps/api
npx prisma migrate dev
```

## Running it

```bash
npm run dev:api    # Fastify on :4000
npm run dev:web    # Next.js on :3000, proxies /api/* to the API
```

Seed mock inventory (real provider pipeline, mock data — see docs/providers/):

```bash
curl -X POST http://localhost:4000/admin/sync -H "x-admin-key: dev_admin_key_change_me"
```

Then open http://localhost:3000, sign in with any email — in development the magic link is
returned directly in the response (no email provider configured; see
`docs/providers/email.md`).

## Tests

```bash
cd apps/api
npx vitest run   # golden-path integration test (real Postgres, plot_test db) + unit tests
```

## Repo layout

```
apps/api       Fastify + Prisma + PostgreSQL backend
apps/web       Next.js web app (the golden-path screens)
packages/shared  Analytics event taxonomy + wire-format types shared by both
docs/          Architecture, decisions, privacy, pilot plan, anti-roadmap, provider docs
```
