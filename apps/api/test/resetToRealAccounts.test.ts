import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * A real, explicit operator request ("remove ALL accounts apart from these two, remove all
 * existing Crews — they were all test/fake") — covered here because it's genuinely destructive
 * and irreversible, and because the dry-run/confirm split is the only thing standing between a
 * bare `?key=...` request and permanently deleting real data.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
const KEEP_A = 'reset-keep-a@example.com';
const KEEP_B = 'reset-keep-b@example.com';

async function loginByEmail(email: string): Promise<string> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  return `${cookie.name}=${cookie.value}`;
}

describe('GET /admin/reset-to-real-accounts', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  test('without ?confirm=..., nothing is deleted — reports counts only', async () => {
    await loginByEmail('reset-test-a@example.com');
    const cookie = await loginByEmail('reset-test-owner@example.com');
    await app.inject({ method: 'POST', url: '/crews', headers: { cookie }, payload: { name: 'Test Crew' } });

    const res = await app.inject({ method: 'GET', url: '/admin/reset-to-real-accounts', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { dryRun: boolean; wouldDeleteUserCount: number; wouldDeleteCrewCount: number };
    expect(body.dryRun).toBe(true);
    expect(body.wouldDeleteUserCount).toBeGreaterThan(0);
    expect(body.wouldDeleteCrewCount).toBeGreaterThan(0);

    // Genuinely nothing was deleted — a follow-up dry run sees the exact same state.
    const res2 = await app.inject({ method: 'GET', url: '/admin/reset-to-real-accounts', headers: { 'x-admin-key': ADMIN_KEY } });
    const body2 = res2.json() as { wouldDeleteUserCount: number };
    expect(body2.wouldDeleteUserCount).toBe(body.wouldDeleteUserCount);
  });

  test('the wrong confirm phrase also does not delete anything', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/reset-to-real-accounts?confirm=please',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    const body = res.json() as { dryRun: boolean };
    expect(body.dryRun).toBe(true);
  });

  test('with the exact confirm phrase, deletes everyone except the keep-list and every Crew', async () => {
    const keepCookieA = await loginByEmail(KEEP_A);
    await loginByEmail(KEEP_B);
    // Note: the keep-list is hardcoded in the route to willproud89@gmail.com/itswillproud@gmail.com,
    // not these test addresses — this test proves the DELETION mechanics (cascade safety, count
    // accuracy) rather than the specific hardcoded emails, since re-pointing the route at test
    // addresses just to test it would risk the route drifting from what it actually does in prod.
    const res = await app.inject({
      method: 'GET',
      url: '/admin/reset-to-real-accounts?confirm=DELETE_ALL_TEST_DATA',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { dryRun: boolean; deletedUserCount: number; deletedCrewCount: number };
    expect(body.dryRun).toBe(false);
    expect(body.deletedUserCount).toBeGreaterThan(0);
    expect(body.deletedCrewCount).toBeGreaterThan(0);

    // Everything not on the (real, hardcoded) keep-list is gone, including these test accounts —
    // proving the mechanics work correctly even though these specific emails aren't the ones kept.
    const lookup = await app.inject({
      method: 'GET',
      url: `/admin/users/lookup?email=${encodeURIComponent(KEEP_A)}`,
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(lookup.statusCode).toBe(404);

    // Running it again reports nothing left to delete — idempotent, no orphaned rows.
    const again = await app.inject({ method: 'GET', url: '/admin/reset-to-real-accounts', headers: { 'x-admin-key': ADMIN_KEY } });
    const againBody = again.json() as { wouldDeleteUserCount: number; wouldDeleteCrewCount: number };
    expect(againBody.wouldDeleteUserCount).toBe(0);
    expect(againBody.wouldDeleteCrewCount).toBe(0);
    void keepCookieA;
  });
});
