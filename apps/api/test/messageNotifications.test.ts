import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';
import { runMessageNotificationSweep, MESSAGE_NOTIFICATION_QUIET_WINDOW_MS } from '../src/services/messageNotifications';

/**
 * The message-digest email sweep — "notifications of messages in crews that you're in", a real,
 * explicit request implemented as a debounced digest, never one email per message (see
 * services/messageNotifications.ts's own comment). No email provider is configured in the test
 * environment, so `runMessageNotificationSweep` takes its own no-provider fallback (logs instead
 * of sending) — this asserts on the real, observable side effects that fallback still produces
 * (`lastEmailNotifiedAt` written, the sweep's own counts), which is exactly what a real send
 * would also do, rather than trying to intercept an outbound network call this environment can't
 * make anyway.
 *
 * A small, fixed, REUSED set of logged-in users, not a fresh login per test — /auth/magic-link is
 * rate-limited per IP (20 requests / 15 min, src/lib/rateLimit.ts) and `app.inject` calls all
 * share one synthetic IP within a test file's own module instance, so a dozen-plus sub-tests each
 * logging in two brand-new users would blow that budget on its own. Each test creates its own
 * fresh CREW between the same two people instead — cheap, and keeps every test's data isolated
 * from the others regardless.
 */

const app = buildApp();

async function loginByEmail(email: string): Promise<{ userId: string; cookie: string }> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session')!;
  const { user } = callbackRes.json() as { user: { id: string } };
  return { userId: user.id, cookie: `${cookie.name}=${cookie.value}` };
}

async function makeCrew(ownerCookie: string, friendInviteCookie: string) {
  const crewRes = await app.inject({
    method: 'POST',
    url: '/crews',
    headers: { cookie: ownerCookie },
    payload: { name: `Notif Test ${Date.now()}-${Math.random().toString(36).slice(2)}`, defaultCity: 'London' },
  });
  const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
  await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: friendInviteCookie }, payload: { inviteCode: crew.inviteCode } });
  return crew.id;
}

/** Directly inserts a message with a controlled `createdAt` — the sweep's "quiet window" logic
 * is genuinely time-based, and waiting 5 real minutes per test isn't reasonable; backdating the
 * row is the same technique other tests in this suite use for freshness/expiry logic. */
async function sendBackdatedMessage(crewId: string, authorId: string, body: string, ageMs: number) {
  return prisma.crewMessage.create({
    data: { crewId, authorId, body, createdAt: new Date(Date.now() - ageMs) },
  });
}

let owner: { userId: string; cookie: string };
let friend: { userId: string; cookie: string };
let outsider: { userId: string; cookie: string };

beforeAll(async () => {
  await resetDatabase();
  owner = await loginByEmail('digest-owner@plot-test.invalid');
  friend = await loginByEmail('digest-friend@plot-test.invalid');
  outsider = await loginByEmail('digest-outsider@plot-test.invalid');
});

describe('runMessageNotificationSweep', () => {
  test('notifies (and marks lastEmailNotifiedAt) once a message has sat unread past the quiet window', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);
    const msg = await sendBackdatedMessage(crewId, friend.userId, 'anyone free Saturday?', MESSAGE_NOTIFICATION_QUIET_WINDOW_MS + 60_000);

    await runMessageNotificationSweep();

    const membership = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: owner.userId } } });
    expect(membership?.lastEmailNotifiedAt?.getTime()).toBe(msg.createdAt.getTime());
  });

  test('does NOT notify while the newest unread message is still inside the quiet window', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);
    // 30s old — well inside the 5-minute quiet window, so the recipient might still open the app themselves.
    await sendBackdatedMessage(crewId, friend.userId, 'just sent this', 30_000);

    await runMessageNotificationSweep();

    const membership = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: owner.userId } } });
    expect(membership?.lastEmailNotifiedAt).toBeNull();
  });

  test('never re-notifies for a backlog already covered by a previous email', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);
    await sendBackdatedMessage(crewId, friend.userId, 'first message', MESSAGE_NOTIFICATION_QUIET_WINDOW_MS + 60_000);

    await runMessageNotificationSweep();
    const after1 = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: owner.userId } } });
    const firstNotifiedAt = after1?.lastEmailNotifiedAt;
    expect(firstNotifiedAt).not.toBeNull();

    // A second sweep with nothing new since — must not touch lastEmailNotifiedAt again.
    await runMessageNotificationSweep();
    const after2 = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: owner.userId } } });
    expect(after2?.lastEmailNotifiedAt?.getTime()).toBe(firstNotifiedAt!.getTime());
  });

  test('a genuinely new message after the last email produces a real second notification', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);
    const msg1 = await sendBackdatedMessage(crewId, friend.userId, 'first batch', MESSAGE_NOTIFICATION_QUIET_WINDOW_MS + 5 * 60_000);
    await runMessageNotificationSweep();
    const after1 = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: owner.userId } } });
    expect(after1?.lastEmailNotifiedAt?.getTime()).toBe(msg1.createdAt.getTime());

    const msg2 = await sendBackdatedMessage(crewId, friend.userId, 'second batch, later', MESSAGE_NOTIFICATION_QUIET_WINDOW_MS + 60_000);
    await runMessageNotificationSweep();
    const after2 = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: owner.userId } } });
    expect(after2?.lastEmailNotifiedAt?.getTime()).toBe(msg2.createdAt.getTime());
  });

  test('never notifies your own messages back to you', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);
    await sendBackdatedMessage(crewId, owner.userId, 'talking to myself', MESSAGE_NOTIFICATION_QUIET_WINDOW_MS + 60_000);

    await runMessageNotificationSweep();

    const membership = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: owner.userId } } });
    expect(membership?.lastEmailNotifiedAt).toBeNull();
  });

  test('respects a real, working opt-out', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);
    await prisma.crewMember.update({
      where: { crewId_userId: { crewId, userId: owner.userId } },
      data: { emailNotificationsEnabled: false },
    });
    await sendBackdatedMessage(crewId, friend.userId, 'you will not hear about this', MESSAGE_NOTIFICATION_QUIET_WINDOW_MS + 60_000);

    await runMessageNotificationSweep();

    const membership = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: owner.userId } } });
    expect(membership?.lastEmailNotifiedAt).toBeNull();
  });

  test('someone who already read the message before the sweep runs is never notified', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);
    await sendBackdatedMessage(crewId, friend.userId, 'already seen this', MESSAGE_NOTIFICATION_QUIET_WINDOW_MS + 60_000);
    // Real "I already opened it myself" — the exact same write POST /crews/:id/read performs.
    await prisma.crewMember.update({ where: { crewId_userId: { crewId, userId: owner.userId } }, data: { lastReadAt: new Date() } });

    await runMessageNotificationSweep();

    const membership = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: owner.userId } } });
    expect(membership?.lastEmailNotifiedAt).toBeNull();
  });
});

describe('PATCH /crews/:id/notifications', () => {
  test('a member can turn their own email notifications off and back on', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);

    const offRes = await app.inject({
      method: 'PATCH',
      url: `/crews/${crewId}/notifications`,
      headers: { cookie: owner.cookie },
      payload: { emailNotificationsEnabled: false },
    });
    expect(offRes.statusCode).toBe(200);

    const detailRes = await app.inject({ method: 'GET', url: `/crews/${crewId}`, headers: { cookie: owner.cookie } });
    const { crew } = detailRes.json() as { crew: { myEmailNotificationsEnabled: boolean } };
    expect(crew.myEmailNotificationsEnabled).toBe(false);

    const onRes = await app.inject({
      method: 'PATCH',
      url: `/crews/${crewId}/notifications`,
      headers: { cookie: owner.cookie },
      payload: { emailNotificationsEnabled: true },
    });
    expect(onRes.statusCode).toBe(200);
    const detail2 = await app.inject({ method: 'GET', url: `/crews/${crewId}`, headers: { cookie: owner.cookie } });
    expect((detail2.json() as { crew: { myEmailNotificationsEnabled: boolean } }).crew.myEmailNotificationsEnabled).toBe(true);
  });

  test('a non-member cannot toggle notifications for a crew they are not in', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);

    const res = await app.inject({
      method: 'PATCH',
      url: `/crews/${crewId}/notifications`,
      headers: { cookie: outsider.cookie },
      payload: { emailNotificationsEnabled: false },
    });
    expect(res.statusCode).toBe(403);
  });

  test('defaults to enabled for a brand-new membership', async () => {
    const crewId = await makeCrew(owner.cookie, friend.cookie);
    const detailRes = await app.inject({ method: 'GET', url: `/crews/${crewId}`, headers: { cookie: friend.cookie } });
    const { crew } = detailRes.json() as { crew: { myEmailNotificationsEnabled: boolean } };
    expect(crew.myEmailNotificationsEnabled).toBe(true);
  });
});
