import { prisma } from '../lib/prisma';
import { computeCrewDna } from './crewDna';
import { track } from './analytics';

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

export async function listCrewsForUser(userId: string) {
  return prisma.crew.findMany({
    where: { members: { some: { userId, status: 'ACTIVE' } }, archivedAt: null },
    include: {
      members: { where: { status: 'ACTIVE' }, include: { user: { select: { id: true, displayName: true, email: true } } } },
      dna: true,
    },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function getCrewDetail(crewId: string, requestingUserId: string) {
  const membership = await prisma.crewMember.findUnique({
    where: { crewId_userId: { crewId, userId: requestingUserId } },
  });
  if (!membership || membership.status !== 'ACTIVE') return null;

  return prisma.crew.findUnique({
    where: { id: crewId },
    include: {
      members: { include: { user: { select: { id: true, displayName: true, email: true } } } },
      dna: true,
      plans: { orderBy: { createdAt: 'desc' }, take: 10, include: { experience: true } },
    },
  });
}

export async function isCrewMember(crewId: string, userId: string): Promise<boolean> {
  const membership = await prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId } } });
  return Boolean(membership && membership.status === 'ACTIVE');
}
