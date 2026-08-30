import { prisma } from '../../src/lib/prisma';

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
}
