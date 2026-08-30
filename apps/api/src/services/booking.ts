import { prisma } from '../lib/prisma';
import { track } from './analytics';
import { markCompleted as markPlanCompleted } from './plan';

/**
 * Booking Model A: deep link (brief §18). This is the ONLY booking model fully implemented in
 * the pilot — see docs/DECISIONS.md#booking-models for why (no payments compliance surface,
 * works with zero commercial integrations, matches the phased provider-access reality
 * documented in docs/providers/*.md).
 *
 * Honest limitation, written down rather than hidden: without a provider webhook, Plot cannot
 * know for certain the user completed checkout on the external site after being redirected.
 * `confirmBooking` is self-reported — the client calls it after redirect. This is the same
 * imperfect attribution every deep-link affiliate business (including Ticketmaster's own
 * affiliate program, per our market research) lives with; Models B/C get real conversion data
 * once real provider agreements exist.
 */
export async function startDeepLinkBooking(
  planId: string,
  initiatedByUserId: string,
  participantUserIds: string[],
): Promise<{ bookingId: string; externalUrl: string }> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId }, include: { experience: true } });
  if (!plan.experienceId || !plan.experience) {
    throw new Error('Cannot book a Plan with no attached Experience — is this still a soft plan?');
  }

  const listing = await prisma.providerListing.findFirst({
    where: { experienceId: plan.experienceId },
    orderBy: { lastRefreshedAt: 'desc' },
  });
  const externalUrl = listing?.externalUrl ?? `https://example-provider.invalid/experiences/${plan.experienceId}`;

  const perPersonMinor = plan.experience.priceMinMinor ?? 0;
  const amountMinor = perPersonMinor * participantUserIds.length;

  const booking = await prisma.booking.create({
    data: {
      planId,
      model: 'DEEP_LINK',
      status: 'PENDING',
      externalUrl,
      externalRef: listing?.providerListingId,
      amountMinor,
      currency: plan.experience.currency,
      participants: { create: participantUserIds.map((userId) => ({ userId })) },
    },
  });

  await track('BookingStarted', { planId, userId: initiatedByUserId, model: 'deep_link' }, {
    userId: initiatedByUserId,
    planId,
    crewId: plan.crewId,
  });

  return { bookingId: booking.id, externalUrl };
}

export async function confirmDeepLinkBooking(bookingId: string, confirmingUserId: string): Promise<void> {
  const booking = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'CONFIRMED', confirmedAt: new Date() },
    include: { plan: true, participants: true },
  });

  await prisma.plan.update({ where: { id: booking.planId }, data: { status: 'BOOKED' } });

  await track(
    'BookingCompleted',
    {
      planId: booking.planId,
      bookingId: booking.id,
      participantCount: booking.participants.length,
      amountMinor: booking.amountMinor ?? 0,
      currency: booking.currency,
    },
    { userId: confirmingUserId, planId: booking.planId, crewId: booking.plan.crewId },
  );
}

export async function failBooking(bookingId: string, reason: string): Promise<void> {
  const booking = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'FAILED', failedReason: reason },
    include: { plan: true },
  });
  await track('BookingFailed', { planId: booking.planId, reason }, { planId: booking.planId, crewId: booking.plan.crewId });
}

/** Convenience for the pilot's manual "the event happened" step — see admin routes. */
export { markPlanCompleted };
