import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * Reliability fix (services/chat.ts#listCrewMessages): the `after` catch-up query used to have
 * NO row cap at all, unlike the initial-load case. The web client polls this endpoint on a ~3s
 * interval using the previous response's own last message id (apps/web/src/app/crews/[id]/
 * page.tsx#poll) — a client reconnecting after a long gap (phone offline overnight, tab
 * backgrounded for hours) against a genuinely busy Crew could have pulled an unboundedly large
 * single response. Proves the cap is real and that catching up still delivers every message,
 * in order, across however many polls it now takes — never silently drops one.
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

describe('GET /crews/:id/messages catch-up pagination', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('an `after` query spanning more than the page size is capped, not returned unbounded, but nothing is lost across repeated polls', async () => {
    const owner = await loginByEmail('msgpage-owner@plot-test.invalid');
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Message Pagination Crew' } });
    const { crew } = crewRes.json() as { crew: { id: string } };

    const base = Date.now() - 1_000_000;
    const TOTAL = 130; // > the 100-row page size, so a real client reconnecting after a long gap exercises more than one catch-up page
    await prisma.crewMessage.createMany({
      data: Array.from({ length: TOTAL }, (_, i) => ({
        crewId: crew.id,
        authorId: owner.userId,
        body: `Message ${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    });

    // A client that has never polled before (no `after`) — the existing, already-correct
    // initial-load cap.
    const firstPage = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages: initial } = firstPage.json() as { messages: { id: string; body: string }[] };
    expect(initial.length).toBe(100);
    expect(initial[0].body).toBe('Message 30'); // last 100 of 130 (0-indexed), oldest first

    // Now simulate a client reconnecting from the very beginning via `after` on the very first
    // message ever sent (the createdAt=0 seed row is never included — the client already saw it
    // before going offline) — this is the unbounded case the fix targets.
    const allMessages = await prisma.crewMessage.findMany({ where: { crewId: crew.id }, orderBy: { createdAt: 'asc' } });
    const veryFirstId = allMessages[0].id;

    const catchUp1 = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages?after=${veryFirstId}`, headers: { cookie: owner.cookie } });
    const { messages: page1 } = catchUp1.json() as { messages: { id: string; body: string }[] };
    expect(page1.length).toBe(100); // capped — not all 129 remaining rows in one response
    expect(page1[0].body).toBe('Message 1'); // oldest-first from right after the cursor

    const catchUp2 = await app.inject({
      method: 'GET',
      url: `/crews/${crew.id}/messages?after=${page1[page1.length - 1].id}`,
      headers: { cookie: owner.cookie },
    });
    const { messages: page2 } = catchUp2.json() as { messages: { id: string; body: string }[] };
    expect(page2.length).toBe(29); // the real remainder — 130 total, minus the 1 seed cursor, minus the 100 already caught up

    // Nothing lost or duplicated across the two catch-up polls, exactly matching real chat
    // history minus the very first (already-seen) message.
    const caughtUpIds = new Set([...page1, ...page2].map((m) => m.id));
    expect(caughtUpIds.size).toBe(TOTAL - 1);
    expect([...caughtUpIds].every((id) => allMessages.slice(1).some((m) => m.id === id))).toBe(true);
  });
});
