import { prisma } from '../../src/lib/prisma';
import { __resetSystemUserCacheForTests } from '../../src/services/crewRecommendations';
import { __resetRateLimitForTests } from '../../src/lib/rateLimit';

/**
 * Truncates every application table (not _prisma_migrations) between test runs. Raw SQL
 * because Prisma has no built-in "wipe everything" — this is the standard pattern for
 * Postgres-backed integration tests. RESTART IDENTITY + CASCADE so serial ids (none here, but
 * defensive) and FK-ordered deletes both just work.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_prisma_migrations';
  `;
  if (tables.length === 0) return;

  const tableList = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`);

  // Real, live-found test-isolation bug this closes — see crewRecommendations.ts's own
  // `cachedSystemUserId` comment: that cache survives the truncate above, so any test file with
  // more than one test that both resets the database AND delivers a real recommendation message
  // hits a stale, now-deleted user id on the second one. Clearing it here, once, fixes it for
  // every test file that uses this shared helper, not just the one that happened to find it.
  __resetSystemUserCacheForTests();

  // Real test-isolation bug this closes — see rateLimit.ts's own `__resetRateLimitForTests`
  // comment: the IP-based magic-link rate limit is process-lifetime, not per-test, so a growing
  // integration-test file (each test logging in its own fresh users to keep DB state isolated)
  // can legitimately exceed its real, deliberate budget purely from test volume, nothing to do
  // with what's actually being tested.
  __resetRateLimitForTests();
}
