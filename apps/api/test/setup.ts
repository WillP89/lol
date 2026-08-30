import 'dotenv/config';

// Redirect the app at the dedicated test database BEFORE anything under src/ is imported —
// lib/config.ts's own `dotenv/config` call is a no-op for keys already set (dotenv's default
// behaviour), so this wins. See docs/DECISIONS.md#test-database.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
process.env.NODE_ENV = 'test';
