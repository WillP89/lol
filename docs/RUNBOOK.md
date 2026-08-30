# Runbook

## The API won't start: "Invalid environment configuration"

`src/lib/config.ts` validates env vars at import time and fails loudly rather than starting in
a half-configured state. Check stderr for which field failed — almost always a missing
`.env` (copy `apps/api/.env.example`) or a `SESSION_SECRET`/`TOKEN_HASH_SECRET` under 16 chars.

## `/health` returns `db: unreachable`

Postgres isn't running, or `DATABASE_URL` points at the wrong place.
`sudo service postgresql start` (or your platform's equivalent), then check
`psql "$DATABASE_URL" -c "select 1"` directly before blaming the app.

## Tests fail with connection errors

`test/setup.ts` points the app at `TEST_DATABASE_URL`, a separate database from dev — make
sure it exists and has migrations applied: `DATABASE_URL="$TEST_DATABASE_URL" npx prisma
migrate deploy` from `apps/api`.

## A provider sync shows `failed > 0` in the sync result

Expected occasionally — `services/inventorySync.ts` handles bad individual listings without
failing the whole sync. Check the API logs for the specific `externalId` and error; if it's
systemic (every listing from one provider fails), check that provider's `status` via
`GET /admin/providers` — it likely flipped to `DOWN` and needs its credentials or the adapter
implementation checked.

## Magic links aren't arriving for real users

Expected until an email provider is wired up — see `docs/providers/email.md`. In development
and the pilot, the link is logged and returned directly in the API response; this is the
single highest-priority integration gap before onboarding anyone who isn't watching server
logs.

## A Crew's Group DNA looks wrong / stuck at LOW confidence

Working as designed until the Crew has 3+ completed plans — see
`docs/DECISIONS.md#cold-start-defaults`. If it's stuck above that threshold, check
`services/crewDna.ts#computeCrewDna` is actually being called (it's invoked from
`markCompleted` in `services/plan.ts`, not on every vote).

## Onboarding a new engineer

Read in this order: `README.md` (setup) → `docs/ARCHITECTURE.md` (system shape and why) →
`docs/DECISIONS.md` (the tradeoffs, so you don't "fix" something that's deliberate) →
`docs/PILOT.md` (what we're actually trying to learn) → the golden-path test
(`apps/api/test/golden-path.test.ts`) — reading it top to bottom is the fastest way to
understand the whole product loop in code form.
