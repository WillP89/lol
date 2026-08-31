#!/bin/sh
# Runs on every API boot (see package.json's "start" script) — applies any pending Prisma
# migration before the server starts serving traffic. See docs/DECISIONS.md#auto-migrate-on-deploy
# for why this exists at all.
#
# This also self-heals a specific failure mode confirmed in production: P3005 ("the database
# schema is not empty"), which Prisma raises when a database already has real tables in it but
# no `_prisma_migrations` history — meaning it was provisioned by something other than
# `prisma migrate` at some point, so Prisma has no record of what's already applied and refuses
# to guess. Rather than assume which migrations that covers, this loop lets Postgres itself be
# the source of truth: attempt a normal deploy; if a specific migration fails because its
# tables/columns already exist (P3018, "already exists"), that migration's entire transaction
# rolled back untouched (Postgres DDL is transactional — nothing partially applied) and its
# target state is therefore provably already true of the database, so it's safe to mark exactly
# that migration as already-applied and retry. This converges on applying only what's genuinely
# new, however many migrations predate this database ever being tracked by `prisma migrate`.
set -u
cd "$(dirname "$0")/.."

attempt=0
max_attempts=10

while [ "$attempt" -lt "$max_attempts" ]; do
  attempt=$((attempt + 1))
  OUTPUT=$(npx prisma migrate deploy 2>&1)
  STATUS=$?
  echo "$OUTPUT"

  if [ "$STATUS" -eq 0 ]; then
    echo "== Migrations up to date =="
    exec node dist/src/server.js
  fi

  if echo "$OUTPUT" | grep -q "P3005"; then
    OLDEST=$(ls -1 prisma/migrations | grep -v '\.toml$' | sort | head -1)
    echo "== P3005: pre-existing database with no migration history. Baselining oldest migration ($OLDEST) as already-applied and retrying. =="
    npx prisma migrate resolve --applied "$OLDEST" || { echo "== resolve --applied failed — exiting =="; exit 1; }
    continue
  fi

  if echo "$OUTPUT" | grep -q "P3018"; then
    FAILED=$(echo "$OUTPUT" | grep "Migration name:" | head -1 | sed 's/Migration name: *//')
    if [ -n "$FAILED" ]; then
      echo "== P3018: '$FAILED' failed because its objects already exist in the database — it's already applied in fact if not in Prisma's records. Baselining it and retrying. =="
      npx prisma migrate resolve --applied "$FAILED" || { echo "== resolve --applied failed — exiting =="; exit 1; }
      continue
    fi
  fi

  echo "== Migration failed and this isn't a known-recoverable case — exiting rather than serving on a possibly-stale schema. See output above. =="
  exit 1
done

echo "== Gave up after $max_attempts attempts without a clean deploy — exiting. =="
exit 1
