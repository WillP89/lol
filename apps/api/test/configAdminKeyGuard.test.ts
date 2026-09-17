import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Security/production-hygiene fix: ADMIN_API_KEY's own schema default (lib/config.ts) is a
 * literal, public string readable by anyone with this repo — every /admin/* route (including
 * user hard-delete and, as of the pilot scorecard, real aggregate analytics) is gated on nothing
 * but this key. A production deploy that forgets to set it used to boot and serve every admin
 * route wide open. Same fail-loud-at-boot pattern as resolvePublicApiUrl()'s own production guard
 * right above it in config.ts — proven here the only way a module-level import-time throw can be:
 * a fresh child process per case, since importing config.ts inside the shared vitest process
 * would corrupt every other test's already-loaded config singleton.
 */
const repoRoot = path.resolve(__dirname, '../../..');
const fixture = path.resolve(__dirname, 'fixtures/importConfig.ts');

function runWithEnv(extraEnv: Record<string, string>) {
  return spawnSync('node_modules/.bin/tsx', [fixture], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/plot_test',
      SESSION_SECRET: 'a'.repeat(32),
      TOKEN_HASH_SECRET: 'b'.repeat(32),
      ...extraEnv,
    },
  });
}

describe('ADMIN_API_KEY production-safety guard', () => {
  test('refuses to boot in production with the public default key', () => {
    const result = runWithEnv({ NODE_ENV: 'production', ADMIN_API_KEY: 'dev_admin_key_change_me' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ADMIN_API_KEY is unset in production');
  });

  test('boots fine in production with a real key set', () => {
    // Also needs a real API_PUBLIC_URL — resolvePublicApiUrl() has its own, separate
    // production-safety throw right below this guard in config.ts; supplying it here isolates
    // this test to the ADMIN_API_KEY guard specifically, not that unrelated one.
    const result = runWithEnv({
      NODE_ENV: 'production',
      ADMIN_API_KEY: 'a-real-random-secret-value',
      API_PUBLIC_URL: 'https://api.plotmaker.co.uk',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('config loaded ok');
  });

  test('the public default key is still fine outside production — dev/test must not be blocked', () => {
    const devResult = runWithEnv({ NODE_ENV: 'development', ADMIN_API_KEY: 'dev_admin_key_change_me' });
    expect(devResult.status).toBe(0);

    const testResult = runWithEnv({ NODE_ENV: 'test', ADMIN_API_KEY: 'dev_admin_key_change_me' });
    expect(testResult.status).toBe(0);
  });
});
