import { prisma } from '../lib/prisma';
import { computeCrewDna } from './crewDna';
import { track } from './analytics';
import { displayNameOf } from '../lib/displayName';

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
 * The three extra pieces of context that turn a Crew from "a name in a list" into something
 * that answers "what's actually going on here?" without opening it — see docs/DECISIONS.md
 * #home-surface. Three cheap, independent queries per Crew rather than one large join: at
 * pilot scale (a handful of Crews per user) this is simpler to read and reason about than a
 * hand-tuned join, and each piece degrades independently (a Crew with no messages yet just
 * gets `latestMessage: null`, not a broken row).
 */
async function crewSummaryExtras(crewId: string, requestingUserId: string) {
  const [latestMessage, activePlan, upcomingPlan] = await Promise.all([
    prisma.crewMessage.findFirst({
      where: { crewId },
      orderBy: { createdAt: 'desc' },
      select: { body: true, createdAt: true, author: { select: { displayName: true, email: true } } },
    }),
    prisma.plan.findFirst({
      where: { crewId, status: { in: [...ACTIVE_DECISION_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      include: { votes: true, members: true },
    }),
    prisma.plan.findFirst({
      where: { crewId, status: 'BOOKED' },
      orderBy: { createdAt: 'desc' },
      include: { experience: { include: { venue: true } } },
    }),
  ]);

  return {
    latestMessage: latestMessage
      ? { body: latestMessage.body, authorName: displayNameOf(latestMessage.author.displayName, latestMessage.author.email), createdAt: latestMessage.createdAt }
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
        }
      : null,
    upcomingPlan: upcomingPlan
      ? {
          id: upcomingPlan.id,
          title: upcomingPlan.title,
          publicSlug: upcomingPlan.publicSlug,
          startsAt: upcomingPlan.experience?.startsAt ?? null,
          venueName: upcomingPlan.experience?.venue?.name ?? null,
          category: upcomingPlan.experience?.category ?? null,
          imageUrl: upcomingPlan.experience?.imageUrl ?? null,
        }
      : null,
  };
}

export async function listCrewsForUser(userId: string) {
  const crews = await prisma.crew.findMany({
    where: { members: { some: { userId, status: 'ACTIVE' } }, archivedAt: null },
    include: {
      members: { where: { status: 'ACTIVE' }, include: { user: { select: { id: true, displayName: true, email: true } } } },
      dna: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  return Promise.all(crews.map(async (crew) => ({ ...crew, ...(await crewSummaryExtras(crew.id, userId)) })));
}

/**
 * Every confirmed (BOOKED) Plan across every Crew the user belongs to, soonest first — the
 * data behind the standalone "Plans" destination (brief: "confirmed plans should not disappear
 * inside chat"). A Plan can go BOOKED without ever having an Experience attached (a soft plan
 * booked by hand) — those are kept, just with `startsAt: null`, sorted after ones with a real
 * date rather than dropped.
 */
export async function listUpcomingPlansForUser(userId: string) {
  const plans = await prisma.plan.findMany({
    where: { status: 'BOOKED', crew: { members: { some: { userId, status: 'ACTIVE' } } } },
    include: { crew: { select: { id: true, name: true } }, experience: { include: { venue: true } } },
    orderBy: { updatedAt: 'desc' },
  });

  return plans
    .map((plan) => ({
      id: plan.id,
      publicSlug: plan.publicSlug,
      title: plan.title,
      crew: plan.crew,
      startsAt: plan.experience?.startsAt ?? null,
      venueName: plan.experience?.venue?.name ?? null,
      venueCity: plan.experience?.venue?.city ?? null,
      category: plan.experience?.category ?? null,
      imageUrl: plan.experience?.imageUrl ?? null,
      priceMinMinor: plan.experience?.priceMinMinor ?? null,
      currency: plan.experience?.currency ?? 'GBP',
    }))
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
        members: { include: { user: { select: { id: true, displayName: true, email: true } } } },
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
      select: { id: true, body: true, createdAt: true, author: { select: { id: true, displayName: true, email: true } } },
    }),
  ]);
  if (!crew) return null;

  return { ...crew, recentMessages: recentMessages.reverse() };
}

export async function isCrewMember(crewId: string, userId: string): Promise<boolean> {
  const membership = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId } } });
  return Boolean(membership && membership.status === 'ACTIVE');
}
