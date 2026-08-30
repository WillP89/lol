import { prisma } from '../lib/prisma';
import { isCrewMember } from './crew';
import { track } from './analytics';

const MESSAGE_LIST_LIMIT = 100;
const MESSAGE_BODY_MAX_LEN = 2000;
// A fixed, small palette rather than a full emoji picker — this is a lightweight interest
// signal on a message, not a general-purpose reaction system. See
// docs/DECISIONS.md#message-reactions.
export const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '🎉'] as const;
export type ReactionEmoji = (typeof ALLOWED_REACTIONS)[number];

export class ChatError extends Error {
  constructor(
    message: string,
    public code: 'not_a_member' | 'invalid_body' | 'invalid_emoji' | 'not_found',
  ) {
    super(message);
  }
}

interface RawReaction {
  emoji: string;
  userId: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

function aggregateReactions(reactions: RawReaction[], viewerId: string): ReactionSummary[] {
  const byEmoji = new Map<string, { count: number; reactedByMe: boolean }>();
  for (const r of reactions) {
    const entry = byEmoji.get(r.emoji) ?? { count: 0, reactedByMe: false };
    entry.count += 1;
    if (r.userId === viewerId) entry.reactedByMe = true;
    byEmoji.set(r.emoji, entry);
  }
  return [...byEmoji.entries()]
    .map(([emoji, v]) => ({ emoji, ...v }))
    .sort((a, b) => b.count - a.count);
}

const messageAuthorSelect = {
  id: true,
  authorId: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, displayName: true, email: true } },
  reactions: { select: { emoji: true, userId: true } },
} as const;

type RawMessage = {
  id: string;
  authorId: string;
  body: string;
  createdAt: Date;
  author: { id: string; displayName: string | null; email: string };
  reactions: RawReaction[];
};

function withReactionSummary(message: RawMessage, viewerId: string) {
  const { reactions, ...rest } = message;
  return { ...rest, reactions: aggregateReactions(reactions, viewerId) };
}

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

  return withReactionSummary(message, authorId);
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

  const messages = await prisma.crewMessage.findMany({
    where: { crewId, ...(afterCreatedAt ? { createdAt: { gt: afterCreatedAt } } : {}) },
    orderBy: { createdAt: 'asc' },
    take: afterCreatedAt ? undefined : -MESSAGE_LIST_LIMIT, // no afterId → last N messages, oldest first
    select: messageAuthorSelect,
  });

  return messages.map((m) => withReactionSummary(m, requestingUserId));
}

/**
 * Toggle: tapping the emoji you already reacted with removes it; tapping a different one
 * switches your single reaction on this message to it. `crewId` is checked against the
 * message's own crew, not just "is this user a member of *some* crew" — otherwise a member of
 * Crew A could react to a message id belonging to Crew B just by guessing/enumerating ids.
 */
export async function toggleReaction(crewId: string, messageId: string, userId: string, emoji: string) {
  if (!(await isCrewMember(crewId, userId))) {
    throw new ChatError('Not a member of this Crew.', 'not_a_member');
  }
  if (!ALLOWED_REACTIONS.includes(emoji as ReactionEmoji)) {
    throw new ChatError('Not a supported reaction.', 'invalid_emoji');
  }

  const message = await prisma.crewMessage.findUnique({ where: { id: messageId }, select: { crewId: true } });
  if (!message || message.crewId !== crewId) {
    throw new ChatError('Message not found in this Crew.', 'not_found');
  }

  const existing = await prisma.messageReaction.findUnique({ where: { messageId_userId: { messageId, userId } } });
  if (existing?.emoji === emoji) {
    await prisma.messageReaction.delete({ where: { id: existing.id } });
  } else {
    await prisma.messageReaction.upsert({
      where: { messageId_userId: { messageId, userId } },
      update: { emoji },
      create: { messageId, userId, emoji },
    });
  }

  const reactions = await prisma.messageReaction.findMany({ where: { messageId }, select: { emoji: true, userId: true } });
  return aggregateReactions(reactions, userId);
}
