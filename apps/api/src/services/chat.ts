import { prisma } from '../lib/prisma';
import { isCrewMember } from './crew';
import { track } from './analytics';

const MESSAGE_LIST_LIMIT = 100;
const MESSAGE_BODY_MAX_LEN = 2000;

export class ChatError extends Error {
  constructor(
    message: string,
    public code: 'not_a_member' | 'invalid_body',
  ) {
    super(message);
  }
}

const messageAuthorSelect = {
  id: true,
  authorId: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, displayName: true, email: true } },
} as const;

/**
 * Membership (not authorship) gates both read and write — any ACTIVE CrewMember can post and
 * read. See docs/DECISIONS.md#crew-chat.
 */
export async function sendCrewMessage(crewId: string, authorId: string, body: string) {
  if (!(await isCrewMember(crewId, authorId))) {
    throw new ChatError('Not a member of this Crew.', 'not_a_member');
  }
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > MESSAGE_BODY_MAX_LEN) {
    throw new ChatError(`Message must be between 1 and ${MESSAGE_BODY_MAX_LEN} characters.`, 'invalid_body');
  }

  const message = await prisma.crewMessage.create({
    data: { crewId, authorId, body: trimmed },
    select: messageAuthorSelect,
  });

  await track('CrewMessageSent', { crewId, userId: authorId }, { userId: authorId, crewId });

  return message;
}

/**
 * `afterId` supports cheap polling: the web client passes the id of the last message it
 * already has and only gets back what's new, instead of re-fetching and re-rendering the
 * whole history every poll tick.
 */
export async function listCrewMessages(crewId: string, requestingUserId: string, afterId?: string) {
  if (!(await isCrewMember(crewId, requestingUserId))) {
    throw new ChatError('Not a member of this Crew.', 'not_a_member');
  }

  let afterCreatedAt: Date | undefined;
  if (afterId) {
    const afterMessage = await prisma.crewMessage.findUnique({ where: { id: afterId }, select: { createdAt: true } });
    afterCreatedAt = afterMessage?.createdAt;
  }

  return prisma.crewMessage.findMany({
    where: { crewId, ...(afterCreatedAt ? { createdAt: { gt: afterCreatedAt } } : {}) },
    orderBy: { createdAt: 'asc' },
    take: afterCreatedAt ? undefined : -MESSAGE_LIST_LIMIT, // no afterId → last N messages, oldest first
    select: messageAuthorSelect,
  });
}
