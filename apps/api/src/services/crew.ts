import { prisma } from '../lib/prisma';
import { computeCrewDna } from './crewDna';
import { track } from './analytics';

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
async function crewSummaryExtras(crewId: string) {
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
      ? { body: latestMessage.body, authorName: latestMessage.author.displayName ?? latestMessage.author.email, createdAt: latestMessage.createdAt }
      : null,
    activePlan: activePlan
      ? {
          id: activePlan.id,
          title: activePlan.title,
          publicSlug: activePlan.publicSlug,
          inCount: activePlan.votes.filter((v) => v.vote === 'IN').length,
          totalMembers: activePlan.members.length,
        }
      : null,
    upcomingPlan: upcomingPlan
      ? {
          id: upcomingPlan.id,
          title: upcomingPlan.title,
          publicSlug: upcomingPlan.publicSlug,
          startsAt: upcomingPlan.experience?.startsAt ?? null,
          venueName: upcomingPlan.experience?.venue?.name ?? null,
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

  return Promise.all(crews.map(async (crew) => ({ ...crew, ...(await crewSummaryExtras(crew.id)) })));
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
