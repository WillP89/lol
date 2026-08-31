#!/bin/sh
# Runs on every API boot (see package.json's "start" script) — applies any pending Prisma
# migration before the server starts serving traffic. See docs/DECISIONS.md#auto-migrate-on-deploy
# for why this exists at all.
#
# Two production failure modes are handled here, both confirmed via real Render deploy logs
# (not assumed):
#
# 1. P3005 ("the database schema is not empty") — this production database has real tables in
#    it but no `_prisma_migrations` history, meaning it was provisioned by something other than
#    `prisma migrate` at some point, so Prisma has no record of what's already applied and
#    refuses to guess. Recovered by baselining the oldest un-tracked migration and retrying.
#
# 2. P3018 ("migration failed to apply" because its objects already exist) — happens per
#    migration as the loop works forward once history exists. Postgres DDL is transactional, so
#    a P3018 means that migration's whole transaction rolled back untouched — nothing partially
#    applied — which means its target state is *already* true of the database in fact, just not
#    recorded. Safe to mark it resolved and move on to the next one.
#
# Every `prisma` call is wrapped in `timeout` — confirmed via a real deploy that a stalled
# handshake against Neon's pooled connection can hang a `prisma migrate resolve` call
# indefinitely with zero output, which silently hung the whole container until Render killed the
# deploy on its own port-scan timeout ("Port scan timeout reached, no open ports detected") 14
# minutes later. Same shape as the SMTP-hang bug elsewhere in this codebase (see
# docs/providers/email.md) — without an explicit timeout, a stalled connection doesn't fail, it
# just hangs. Bounding every step means this script always reaches either success or a fast,
# loud failure, never another silent multi-minute stall.
set -u
cd "$(dirname "$0")/.."

STEP_TIMEOUT=60
max_attempts=15

run_prisma() {
  timeout "$STEP_TIMEOUT" npx prisma "$@" 2>&1
}

resolve_applied() {
  name="$1"
  echo "== Resolving '$name' as already-applied (timeout ${STEP_TIMEOUT}s)... =="
  OUT=$(run_prisma migrate resolve --applied "$name")
  ST=$?
  echo "$OUT"
  if [ "$ST" -eq 124 ]; then
    echo "== resolve timed out after ${STEP_TIMEOUT}s — will retry =="
    return 1
  fi
  if [ "$ST" -ne 0 ]; then
    echo "== resolve --applied failed — exiting =="
    exit 1
  fi
  return 0
}

attempt=0
while [ "$attempt" -lt "$max_attempts" ]; do
  attempt=$((attempt + 1))
  echo "== migrate deploy attempt $attempt/$max_attempts (timeout ${STEP_TIMEOUT}s)... =="
  OUTPUT=$(run_prisma migrate deploy)
  STATUS=$?
  echo "$OUTPUT"

  if [ "$STATUS" -eq 0 ]; then
    echo "== Migrations up to date =="
    exec node dist/src/server.js
  fi

  if [ "$STATUS" -eq 124 ]; then
    echo "== 'prisma migrate deploy' timed out after ${STEP_TIMEOUT}s — likely a stalled pooled-connection handshake. Retrying. =="
    continue
  fi

  if echo "$OUTPUT" | grep -q "P3005"; then
    OLDEST=$(ls -1 prisma/migrations | grep -v '\.toml$' | sort | head -1)
    echo "== P3005: pre-existing database with no migration history. =="
    resolve_applied "$OLDEST"
    continue
  fi

  if echo "$OUTPUT" | grep -q "P3018"; then
    FAILED=$(echo "$OUTPUT" | grep "Migration name:" | head -1 | sed 's/Migration name: *//')
    if [ -n "$FAILED" ]; then
      echo "== P3018: '$FAILED' failed because its objects already exist — already true of the database in fact. =="
      resolve_applied "$FAILED"
      continue
    fi
  fi

  echo "== Migration failed and this isn't a known-recoverable case — exiting rather than serving on a possibly-stale schema. See output above. =="
  exit 1
done

echo "== Gave up after $max_attempts attempts without a clean deploy — exiting. =="
exit 1
