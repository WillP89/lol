import { PrismaClient } from '@prisma/client';

/**
 * Standard singleton pattern so dev hot-reload (tsx watch) doesn't exhaust Postgres
 * connections by instantiating a new PrismaClient per reload.
 */
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}
