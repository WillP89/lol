import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real bug found running /admin/reset-to-real-accounts against production for the first time:
 * this schema had never had a genuine hard-delete exercised against it before (account deletion
 * is a soft anonymising update — see routes/users.ts), so several relations that silently
 * defaulted to Postgres's RESTRICT behaviour had never been caught. Deleting a Crew whose Plan
 * had a real Booking failed outright with a raw P2003 foreign key violation. This reproduces
 * that exact scenario end-to-end (through real HTTP, not raw Prisma) plus every other
 * independently-blocking row found in the same audit (IntentSignal, FeedbackSignal, AuditEvent,
 * Referral, RewindSignal) — and confirms the analytics/audit-trail rows correctly SURVIVE with
 * their user reference cleared (SetNull), not silently deleted along with the account.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';

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

describe('hard-delete cascades: the exact production failure, reproduced and fixed', () => {
  let ownerId = '';
  let ownerCookie = '';
  let planId = '';

  beforeAll(async () => {
    await resetDatabase();
    const owner = await loginByEmail('hard-delete-owner@plot-test.invalid');
    ownerId = owner.userId;
    ownerCookie = owner.cookie;

    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: ownerCookie }, payload: { name: 'Hard Delete Crew' } });
    const { crew } = crewRes.json() as { crew: { id: string } };

    // A real Booking (with a Payment and a BookingParticipant) via direct writes — the manual
    // Lock It In -> book flow needs a real live-provider deep link to complete end-to-end, which
    // this test environment doesn't have; the point here is the schema's cascade behaviour, not
    // re-testing the booking flow itself (already covered elsewhere).
    const venue = await prisma.venue.create({ data: { name: 'HD Venue', city: 'Stafford', latitude: 52.8, longitude: -2.1 } });
    const exp = await prisma.experience.create({
      data: {
        canonicalKey: 'hard-delete-exp::v::2026-09-10', name: 'HD Exp', description: 'x', category: 'LIVE_MUSIC', subcategories: [],
        venueId: venue.id, startsAt: new Date('2026-09-10T20:00:00Z'), timezone: 'Europe/London', currency: 'GBP', bookingStatus: 'AVAILABLE', tags: {}, qualityScore: 70,
      },
    });
    const plan = await prisma.plan.create({
      data: { crewId: crew.id, experienceId: exp.id, title: 'HD Plan', status: 'LOCKED', publicSlug: 'hd-plan-' + Date.now(), proposedByUserId: ownerId },
    });
    planId = plan.id;
    const booking = await prisma.booking.create({ data: { planId: plan.id, model: 'DEEP_LINK', status: 'PENDING' } });
    await prisma.payment.create({ data: { bookingId: booking.id, amountMinor: 1000, currency: 'GBP', status: 'SUCCEEDED' } });
    await prisma.bookingParticipant.create({ data: { bookingId: booking.id, userId: ownerId } });

    // The other independently-blocking rows, tied to the user directly.
    await prisma.intentSignal.create({ data: { name: 'hd_test_event', userId: ownerId, payload: {} } });
    await prisma.feedbackSignal.create({ data: { userId: ownerId, context: 'hd_test', category: 'NOT_MY_VIBE' } });
    await prisma.auditEvent.create({ data: { actorUserId: ownerId, action: 'hd.test.action' } });
    await prisma.referral.create({ data: { senderId: ownerId, channel: 'link' } });
    await prisma.rewindSignal.create({ data: { planId: plan.id, userId: ownerId, rating: 'LIKE', reasons: [] } });
  });

  test('the reset endpoint succeeds instead of 500ing on the FK violation', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/reset-to-real-accounts?confirm=DELETE_ALL_TEST_DATA',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { dryRun: boolean; deletedCrewCount: number; deletedUserCount: number };
    expect(body.dryRun).toBe(false);
    expect(body.deletedCrewCount).toBeGreaterThan(0);
    expect(body.deletedUserCount).toBeGreaterThan(0);
  });

  test('analytics/audit rows survive with their user reference cleared, not deleted', async () => {
    const intent = await prisma.intentSignal.findFirst({ where: { name: 'hd_test_event' } });
    expect(intent).not.toBeNull();
    expect(intent!.userId).toBeNull();

    const feedback = await prisma.feedbackSignal.findFirst({ where: { context: 'hd_test' } });
    expect(feedback).not.toBeNull();
    expect(feedback!.userId).toBeNull();

    const audit = await prisma.auditEvent.findFirst({ where: { action: 'hd.test.action' } });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBeNull();
  });

  test('the Referral (required sender, no sensible null state) is correctly cascade-removed, not orphaned', async () => {
    const referral = await prisma.referral.findFirst({ where: { channel: 'link' } });
    expect(referral).toBeNull();
  });

  test('the Booking/Payment/BookingParticipant chain is fully gone with the Plan/Crew', async () => {
    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    expect(plan).toBeNull();
    const bookings = await prisma.booking.count({ where: { planId } });
    expect(bookings).toBe(0);
  });
});
