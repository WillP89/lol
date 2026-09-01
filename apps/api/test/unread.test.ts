import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real, persisted unread-message state (CrewMember.lastReadAt) — see
 * apps/api/src/services/crew.ts#crewSummaryExtras and #markCrewRead. Never faked client-side:
 * this is the actual thing that decides whether a badge shows, so it's tested at the API level
 * the same way every other real-state feature in this suite is.
 */

const app = buildApp();

async function loginByEmail(email: string): Promise<{ userId: string; cookie: string }> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  const { user } = callbackRes.json() as { user: { id: string } };
  return { userId: user.id, cookie: `${cookie.name}=${cookie.value}` };
}

async function unreadCountFor(cookie: string, crewId: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/crews', headers: { cookie } });
  const { crews } = res.json() as { crews: { id: string; unreadCount: number }[] };
  return crews.find((c) => c.id === crewId)!.unreadCount;
}

describe('unread-message state: real, persisted, per-member', () => {
  let owner: { userId: string; cookie: string };
  let member: { userId: string; cookie: string };
  let crewId = '';

  beforeAll(async () => {
    await resetDatabase();
    owner = await loginByEmail('unread-owner@plot-test.invalid');
    member = await loginByEmail('unread-member@plot-test.invalid');

    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Unread Test Crew', defaultCity: 'Stafford' },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    crewId = crew.id;
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: member.cookie }, payload: { inviteCode: crew.inviteCode } });
  });

  test('a brand-new Crew with no messages has zero unread for everyone', async () => {
    expect(await unreadCountFor(owner.cookie, crewId)).toBe(0);
    expect(await unreadCountFor(member.cookie, crewId)).toBe(0);
  });

  test('your own message is never unread to yourself', async () => {
    await app.inject({ method: 'POST', url: `/crews/${crewId}/messages`, headers: { cookie: owner.cookie }, payload: { body: 'Hey!' } });
    expect(await unreadCountFor(owner.cookie, crewId)).toBe(0);
  });

  test('the same message IS unread for the other member, who has never opened this Crew', async () => {
    expect(await unreadCountFor(member.cookie, crewId)).toBe(1);
  });

  test('POST /crews/:id/read marks it read — unread drops to zero', async () => {
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/read`, headers: { cookie: member.cookie } });
    expect(res.statusCode).toBe(200);
    expect(await unreadCountFor(member.cookie, crewId)).toBe(0);
  });

  test('a new message after marking read increments unread again — reading is a point in time, not permanent', async () => {
    await app.inject({ method: 'POST', url: `/crews/${crewId}/messages`, headers: { cookie: owner.cookie }, payload: { body: 'Second message' } });
    expect(await unreadCountFor(member.cookie, crewId)).toBe(1);
    // The owner already read everything up to their own last message — this new one is theirs.
    expect(await unreadCountFor(owner.cookie, crewId)).toBe(0);
  });

  test('marking read again after the member replies does not count their own reply as unread to themselves', async () => {
    await app.inject({ method: 'POST', url: `/crews/${crewId}/read`, headers: { cookie: member.cookie } });
    await app.inject({ method: 'POST', url: `/crews/${crewId}/messages`, headers: { cookie: member.cookie }, payload: { body: 'Replying' } });
    expect(await unreadCountFor(member.cookie, crewId)).toBe(0);
    // But it IS unread for the owner, who hasn't read past their own last message yet.
    expect(await unreadCountFor(owner.cookie, crewId)).toBe(1);
  });

  test('a non-member cannot mark a Crew read (403, not a silent no-op)', async () => {
    const outsider = await loginByEmail('unread-outsider@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/read`, headers: { cookie: outsider.cookie } });
    expect(res.statusCode).toBe(403);
  });
});
