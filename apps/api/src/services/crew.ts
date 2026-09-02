import { prisma } from '../lib/prisma';
import { computeCrewDna } from './crewDna';
import { track } from './analytics';
import { displayNameOf } from '../lib/displayName';
import { getPlotSystemUserId } from './crewRecommendations';

// A Plan in one of these statuses is an open, unresolved decision the Crew is still working
// out — the thing Home/Crew surfaces should foreground so a member never has to reconstruct
// "what are we deciding?" by scrolling chat history. BOOKED/COMPLETED/CANCELLED/IDEA are not
// "active decisions": BOOKED already has an answer, IDEA has no real option attached yet.
const ACTIVE_DECISION_STATUSES = ['SHARED', 'GATHERING_INTEREST', 'LIKELY', 'READY'] as const;

export async function createCrew(userId: string, name: string, defaultCity?: string) {
  const crew = await prisma.crew.create({
    data: {
      name,
      defaultCity,
      createdById: userId,
      members: { create: { userId, role: 'OWNER', status: 'ACTIVE' } },
    },
    include: { members: true },
  });

  await computeCrewDna(crew.id);
  await track('CrewCreated', { crewId: crew.id, userId, memberCount: 1 }, { userId, crewId: crew.id });

  return crew;
}

export async function joinCrewByInviteCode(userId: string, inviteCode: string) {
  const crew = await prisma.crew.findUnique({ where: { inviteCode } });
  if (!crew || crew.archivedAt) return null;

  const member = await prisma.crewMember.upsert({
    where: { crewId_userId: { crewId: crew.id, userId } },
    update: { status: 'ACTIVE' },
    create: { crewId: crew.id, userId, role: 'MEMBER', status: 'ACTIVE' },
  });

  await computeCrewDna(crew.id);
  await track('CrewJoined', { crewId: crew.id, userId, viaInvite: true }, { userId, crewId: crew.id });

  return { crew, member };
}

/**
 * The pre-auth invite preview — "Will invited you to Weekend Crew, 6 people are already here"
 * — needs to render BEFORE anyone signs in, so this is deliberately public: no membership
 * check, no `requireUser`. Returns the absolute minimum that's safe to show a stranger (name,
 * member count, first-initial avatars) — never message content, never the full member list
 * with emails. See docs/DECISIONS.md#invite-preview.
 */
/**
 * The invite landing screen's "Will invited you to Weekend Crew" needs a real name to attribute
 * to, not just the Crew's — a bare "You're invited to Weekend Crew" is a colder, less trustworthy
 * moment than naming who it's from (brief: the invite is "one of Plot's most important growth
 * surfaces"). `inviteCode` is crew-level (one shared link, not a personalised per-invite token —
 * see Crew.inviteCode in schema.prisma), so there's no record of literally who tapped "share"
 * for this specific link; the Crew's creator is the honest, always-real signal available instead
 * of fabricating one.
 */
export async function getCrewPreviewByInviteCode(inviteCode: string) {
  const crew = await prisma.crew.findUnique({
    where: { inviteCode },
    select: {
      id: true,
      name: true,
      imageUrl: true,
      archivedAt: true,
      createdById: true,
      members: {
        where: { status: 'ACTIVE' },
        select: { user: { select: { displayName: true, email: true, avatarUrl: true } } },
        orderBy: { joinedAt: 'asc' },
        take: 6,
      },
      _count: { select: { members: true } },
    },
  });
  if (!crew || crew.archivedAt) return null;

  const creator = await prisma.user.findUnique({
    where: { id: crew.createdById },
    select: { displayName: true, email: true },
  });

  return {
    name: crew.name,
    imageUrl: crew.imageUrl,
    memberCount: crew._count.members,
    memberInitials: crew.members.map((m) => (m.user.displayName?.trim() || m.user.email).charAt(0).toUpperCase()),
    // Real identity for the invite screen's member row (brief: show who I'd be joining, not
    // just a count) — deliberately NOT the raw email (this endpoint is public, no-auth, and a
    // pre-existing test correctly caught the first version of this leaking it). A resolved
    // display name only — same "first-name-or-nothing-identifying" rule the rest of the public
    // invite preview already follows.
    members: crew.members.map((m) => ({ displayName: displayNameOf(m.user.displayName, m.user.email).split(' ')[0], avatarUrl: m.user.avatarUrl })),
    invitedByName: creator ? displayNameOf(creator.displayName, creator.email).split(' ')[0] : null,
  };
}

/**
 * The three extra pieces of context that turn a Crew from "a name in a list" into something
 * that answers "what's actually going on here?" without opening it — see docs/DECISIONS.md
 * #home-surface. Three cheap, independent queries per Crew rather than one large join: at
 * pilot scale (a handful of Crews per user) this is simpler to read and reason about than a
 * hand-tuned join, and each piece degrades independently (a Crew with no messages yet just
 * gets `latestMessage: null`, not a broken row).
 */
async function crewSummaryExtras(crewId: string, requestingUserId: string) {
  const [latestMessage, activePlan, upcomingPlan, membership] = await Promise.all([
    prisma.crewMessage.findFirst({
      where: { crewId },
      orderBy: { createdAt: 'desc' },
      select: { body: true, createdAt: true, author: { select: { displayName: true, email: true, avatarUrl: true } } },
    }),
    prisma.plan.findFirst({
      where: { crewId, status: { in: [...ACTIVE_DECISION_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      // `experience` wasn't fetched here before — Home's own branded "Plot found this" card
      // (home/page.tsx) needs the real photo/category for a still-undecided Plot recommendation,
      // not just once it's locked (upcomingPlan, below, already had this).
      include: { votes: true, members: true, experience: { include: { venue: true } } },
    }),
    prisma.plan.findFirst({
      // LOCKED, not just BOOKED — a manual plan ("Pub Saturday") stays LOCKED forever (nothing
      // to book) and a ticketed one starts LOCKED before any real payment happens (see
      // services/plan.ts#lockPlan). Both are equally "the Crew is actually doing this" for
      // Home/Crews-list display purposes; BOOKED is reserved for confirmed real transactions.
      where: { crewId, status: { in: ['LOCKED', 'BOOKED'] } },
      orderBy: { createdAt: 'desc' },
      include: { experience: { include: { venue: true } } },
    }),
    prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: requestingUserId } }, select: { lastReadAt: true } }),
  ]);

  // Real, persisted unread count — never faked in the client. `lastReadAt: null` (never opened
  // this Crew's chat, or joined before it existed) counts everything ever sent as unread, same
  // as a fresh WhatsApp/iMessage thread. Your own messages never count as unread to yourself.
  const unreadCount = await prisma.crewMessage.count({
    where: {
      crewId,
      authorId: { not: requestingUserId },
      ...(membership?.lastReadAt ? { createdAt: { gt: membership.lastReadAt } } : {}),
    },
  });

  // Whether a Plan came from Plot's own automatic recommendation engine, not a member sharing
  // something themselves — the exact same signal the Plan Card page already exposes (GET
  // /plans/public/:slug's own `recommendation` field), just cheaper here: the recommendation
  // engine always posts as the Plot system user (crewRecommendations.ts#createRecommendationPlanForCrew),
  // so comparing `proposedByUserId` avoids a second query per Plan. Home's own branded "Plot
  // found this" notification card (home/page.tsx) reads this to tell itself apart from an
  // ordinary vote-needed/locked-plan card a real person proposed.
  const plotSystemUserId = await getPlotSystemUserId();
  const plotFoundPlanId =
    (activePlan?.proposedByUserId === plotSystemUserId && activePlan?.id) ||
    (upcomingPlan?.proposedByUserId === plotSystemUserId && upcomingPlan?.id) ||
    null;
  // The real "why" — the same reasonText the Plan Card page and the in-chat recommendation card
  // already show (crewRecommendations.ts#explanationFor), fetched only when there's actually a
  // Plot-found Plan to explain, so this stays a no-op query for the common case.
  const plotFoundReason = plotFoundPlanId
    ? (await prisma.crewRecommendation.findUnique({ where: { planId: plotFoundPlanId }, select: { reasonText: true } }))?.reasonText ?? null
    : null;

  return {
    unreadCount,
    latestMessage: latestMessage
      ? {
          body: latestMessage.body,
          authorName: displayNameOf(latestMessage.author.displayName, latestMessage.author.email),
          authorAvatarUrl: latestMessage.author.avatarUrl,
          createdAt: latestMessage.createdAt,
        }
      : null,
    activePlan: activePlan
      ? {
          id: activePlan.id,
          title: activePlan.title,
          publicSlug: activePlan.publicSlug,
          inCount: activePlan.votes.filter((v) => v.vote === 'IN').length,
          totalMembers: activePlan.members.length,
          // Whether the requesting user still owes this decision a vote — Home's "needs your
          // attention" list (docs/DECISIONS.md#home-surface) is only useful if it's actually
          // scoped to *you*, not "someone in the Crew hasn't voted yet".
          iVoted: activePlan.votes.some((v) => v.userId === requestingUserId),
          isPlotFound: activePlan.proposedByUserId === plotSystemUserId,
          plotReasonText: activePlan.proposedByUserId === plotSystemUserId ? plotFoundReason : null,
          imageUrl: activePlan.experience?.imageUrl ?? null,
          category: activePlan.experience?.category ?? null,
          venueName: activePlan.experience?.venue?.name ?? activePlan.manualVenueName ?? null,
        }
      : null,
    upcomingPlan: upcomingPlan
      ? {
          id: upcomingPlan.id,
          title: upcomingPlan.title,
          publicSlug: upcomingPlan.publicSlug,
          // Real gap this closes: a manually-proposed locked Plan ("Pub Saturday", no Experience
          // at all — see plans/[slug]/page.tsx's own comment on the same shape) fell through to
          // null here even though it has its own manualStartsAt/manualVenueName, same as the
          // /plans/upcoming list a few lines below already falls back to. Home's own "Locked in"
          // notification card (home/page.tsx) reads straight off this field.
          startsAt: upcomingPlan.experience?.startsAt ?? upcomingPlan.manualStartsAt ?? null,
          venueName: upcomingPlan.experience?.venue?.name ?? upcomingPlan.manualVenueName ?? null,
          category: upcomingPlan.experience?.category ?? null,
          imageUrl: upcomingPlan.experience?.imageUrl ?? null,
          isPlotFound: upcomingPlan.proposedByUserId === plotSystemUserId,
          plotReasonText: upcomingPlan.proposedByUserId === plotSystemUserId ? plotFoundReason : null,
        }
      : null,
  };
}

export async function listCrewsForUser(userId: string) {
  const crews = await prisma.crew.findMany({
    where: { members: { some: { userId, status: 'ACTIVE' } }, archivedAt: null },
    include: {
      members: { where: { status: 'ACTIVE' }, include: { user: { select: { id: true, displayName: true, email: true, avatarUrl: true } } } },
      dna: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  return Promise.all(crews.map(async (crew) => ({ ...crew, ...(await crewSummaryExtras(crew.id, userId)) })));
}

/**
 * Every confirmed Plan (LOCKED or BOOKED) across every Crew the user belongs to, soonest first —
 * the data behind the standalone "Plans" destination (brief: "confirmed plans should not
 * disappear inside chat"). LOCKED means the Crew's decision is final (see
 * services/plan.ts#lockPlan); BOOKED additionally means a real payment/booking transaction
 * happened. Both belong here — a manual plan ("Pub Saturday") never becomes BOOKED (nothing to
 * book) and would otherwise never appear on this page at all, which is the majority of real
 * plans. A Plan can be confirmed without ever having an Experience attached (a soft plan decided
 * by hand) — those are kept, just with `startsAt: null`, sorted after ones with a real date
 * rather than dropped.
 */
export async function listUpcomingPlansForUser(userId: string) {
  const plans = await prisma.plan.findMany({
    where: { status: { in: ['LOCKED', 'BOOKED'] }, crew: { members: { some: { userId, status: 'ACTIVE' } } } },
    include: {
      crew: { select: { id: true, name: true, imageUrl: true } },
      experience: { include: { venue: true } },
      votes: { include: { user: { select: { id: true, displayName: true, email: true, avatarUrl: true } } } },
      members: { include: { user: { select: { id: true, displayName: true, email: true, avatarUrl: true } } } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  return plans
    .map((plan) => {
      // Real faces, not a bare number: whoever actually voted IN, falling back to the full
      // invited-member list for a Plan nobody voted on before it was booked (a manually-
      // confirmed soft plan) — same fallback logic as the count below, just keeping the people.
      const inVoters = plan.votes.filter((v) => v.vote === 'IN').map((v) => v.user);
      const going = inVoters.length > 0 ? inVoters : plan.members.map((m) => m.user);
      return {
        id: plan.id,
        publicSlug: plan.publicSlug,
        title: plan.title,
        crew: plan.crew,
        startsAt: plan.experience?.startsAt ?? plan.manualStartsAt ?? null,
        venueName: plan.experience?.venue?.name ?? plan.manualVenueName ?? null,
        venueCity: plan.experience?.venue?.city ?? null,
        category: plan.experience?.category ?? null,
        imageUrl: plan.experience?.imageUrl ?? null,
        priceMinMinor: plan.experience?.priceMinMinor ?? null,
        currency: plan.experience?.currency ?? 'GBP',
        // "5 going" on the Home hero — real signal, not decoration.
        goingCount: inVoters.length || plan.members.length,
        goingMembers: going.slice(0, 5),
      };
    })
    .sort((a, b) => {
      if (a.startsAt && b.startsAt) return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
      if (a.startsAt) return -1;
      if (b.startsAt) return 1;
      return 0;
    });
}

export async function getCrewDetail(crewId: string, requestingUserId: string) {
  const membership = await prisma.crewMember.findUnique({
    where: { crewId_userId: { crewId, userId: requestingUserId } },
  });
  if (!membership || membership.status !== 'ACTIVE') return null;

  const [crew, recentMessages] = await Promise.all([
    prisma.crew.findUnique({
      where: { id: crewId },
      include: {
        // Someone who left (or was removed) is real history for the account that left, not
        // something every OTHER member of the Crew should still see in a member list/count —
        // filtered here, the one place the whole member list is assembled, rather than at every
        // call site that reads `crew.members`.
        members: { where: { status: 'ACTIVE' }, include: { user: { select: { id: true, displayName: true, email: true, avatarUrl: true } } }, orderBy: { joinedAt: 'asc' } },
        dna: true,
        plans: { orderBy: { createdAt: 'desc' }, take: 10, include: { experience: { include: { venue: true } }, votes: true, members: true } },
      },
    }),
    // A 3-message preview so the Crew page can answer "what's the conversation about right
    // now?" without making someone open Chat first — see docs/DECISIONS.md#home-surface.
    prisma.crewMessage.findMany({
      where: { crewId },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, body: true, createdAt: true, author: { select: { id: true, displayName: true, email: true, avatarUrl: true } } },
    }),
  ]);
  if (!crew) return null;

  return { ...crew, recentMessages: recentMessages.reverse() };
}

export async function isCrewMember(crewId: string, userId: string): Promise<boolean> {
  const membership = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId } } });
  return Boolean(membership && membership.status === 'ACTIVE');
}

/**
 * The one place `CrewMember.lastReadAt` is ever written — real, persisted unread state, not
 * something the client fakes by remembering which Crews it's scrolled through this session (that
 * resets on every reload/new device, and can't power a badge on Home before the Crew's chat has
 * ever been opened on THIS load). Called by the frontend when a member opens a Crew's chat and
 * again as new messages arrive while they're actively looking at it — see
 * docs/DECISIONS.md#unread-state for exactly when.
 */
export async function markCrewRead(crewId: string, userId: string): Promise<void> {
  await prisma.crewMember.updateMany({
    where: { crewId, userId, status: 'ACTIVE' },
    data: { lastReadAt: new Date() },
  });
}

export class CrewMembershipError extends Error {
  constructor(
    public code: 'not_owner' | 'not_found' | 'cannot_remove_self',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Owner-only removal. Soft (status → LEFT, same as leaving voluntarily) — this pilot never
 * hard-deletes a CrewMember row, so message history ("Sam voted IN") still resolves a real
 * name/avatar for someone no longer in the Crew, same as any group chat.
 */
export async function removeCrewMember(crewId: string, actingUserId: string, targetUserId: string) {
  if (targetUserId === actingUserId) {
    throw new CrewMembershipError('cannot_remove_self', 'Use leave instead of remove for yourself.');
  }
  const acting = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: actingUserId } } });
  if (!acting || acting.status !== 'ACTIVE' || acting.role !== 'OWNER') {
    throw new CrewMembershipError('not_owner', 'Only the Crew owner can remove members.');
  }
  const target = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId: targetUserId } } });
  if (!target || target.status !== 'ACTIVE') {
    throw new CrewMembershipError('not_found', 'That person is not an active member of this Crew.');
  }
  await prisma.crewMember.update({ where: { id: target.id }, data: { status: 'LEFT' } });
  await computeCrewDna(crewId);
  await track('CrewMemberRemoved', { crewId, removedUserId: targetUserId, userId: actingUserId }, { userId: actingUserId, crewId });
}

/**
 * Voluntary leave, any role including the owner. An owner who leaves hands OWNER to whoever
 * joined next-longest-ago among the remaining active members, so a Crew is never left with zero
 * owners while it still has people in it (the last person out just leaves — nobody left to hand
 * it to).
 */
export async function leaveCrew(crewId: string, userId: string) {
  const membership = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId } } });
  if (!membership || membership.status !== 'ACTIVE') {
    throw new CrewMembershipError('not_found', 'You are not an active member of this Crew.');
  }
  if (membership.role === 'OWNER') {
    const successor = await prisma.crewMember.findFirst({
      where: { crewId, status: 'ACTIVE', userId: { not: userId } },
      orderBy: { joinedAt: 'asc' },
    });
    if (successor) await prisma.crewMember.update({ where: { id: successor.id }, data: { role: 'OWNER' } });
  }
  await prisma.crewMember.update({ where: { id: membership.id }, data: { status: 'LEFT' } });
  await computeCrewDna(crewId);
  await track('CrewLeft', { crewId, userId }, { userId, crewId });
}
