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
  // Who, not just how many — see docs/DECISIONS.md#in-maybe-pass-who: the pilot-readiness pass
  // requires tapping any group tally (reaction, vote, poll option, RSVP) to reveal the actual
  // named people behind it, not just a number.
  reactedBy: string[];
}

function aggregateReactions(reactions: RawReaction[], viewerId: string): ReactionSummary[] {
  const byEmoji = new Map<string, { count: number; reactedByMe: boolean; reactedBy: string[] }>();
  for (const r of reactions) {
    const entry = byEmoji.get(r.emoji) ?? { count: 0, reactedByMe: false, reactedBy: [] };
    entry.count += 1;
    entry.reactedBy.push(r.userId);
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
  poll: {
    select: {
      id: true,
      question: true,
      options: true,
      kind: true,
      votes: { select: { userId: true, option: true } },
    },
  },
} as const;

type RawPoll = { id: string; question: string; options: unknown; kind: string; votes: { userId: string; option: string }[] };
type RawMessage = {
  id: string;
  authorId: string;
  body: string;
  createdAt: Date;
  author: { id: string; displayName: string | null; email: string };
  reactions: RawReaction[];
  poll: RawPoll | null;
};

/** A poll's own conversational object — one native decision object with live tallies, not a
 * separate "results" screen. Each option's count plus which one (if any) the viewer picked. */
function summarisePoll(poll: RawPoll | null, viewerId: string) {
  if (!poll) return null;
  const options = poll.options as string[];
  const counts = Object.fromEntries(options.map((o) => [o, 0])) as Record<string, number>;
  // Who voted for what, not just how many — the client uses this to show the actual group
  // forming around an option (small avatar chips beside it), not just a bare number. The vote
  // rows were already being fetched for `counts`/`myVote`; this reshapes the same data instead
  // of a second query.
  const votersByOption: Record<string, string[]> = Object.fromEntries(options.map((o) => [o, []]));
  let myVote: string | null = null;
  for (const v of poll.votes) {
    if (counts[v.option] !== undefined) {
      counts[v.option] += 1;
      votersByOption[v.option].push(v.userId);
    }
    if (v.userId === viewerId) myVote = v.option;
  }
  return {
    id: poll.id,
    question: poll.question,
    options,
    kind: poll.kind,
    counts,
    votersByOption,
    totalVotes: poll.votes.length,
    myVote,
  };
}

function withReactionSummary(message: RawMessage, viewerId: string) {
  const { reactions, poll, ...rest } = message;
  return { ...rest, reactions: aggregateReactions(reactions, viewerId), poll: summarisePoll(poll, viewerId) };
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
 * Posts into the conversation on behalf of Plot itself — the automatic Crew recommendation
 * engine's delivery mechanism (services/crewRecommendations.ts), never called from a route
 * handler on a real user's behalf. Deliberately skips the `isCrewMember` gate `sendCrewMessage`
 * enforces: the system author is never a CrewMember (so it never appears in member lists, vote
 * pulses, or "who's in the Crew" — see docs/DECISIONS.md#crew-auto-recommendations), which
 * `sendCrewMessage`'s membership check would otherwise correctly reject.
 */
export async function sendSystemMessage(crewId: string, systemUserId: string, body: string) {
  const message = await prisma.crewMessage.create({
    data: { crewId, authorId: systemUserId, body: body.trim() },
    select: messageAuthorSelect,
  });
  return withReactionSummary(message, systemUserId);
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
    await track('ReactionAdded', { crewId, messageId, emoji, userId }, { userId, crewId });
  }

  const reactions = await prisma.messageReaction.findMany({ where: { messageId }, select: { emoji: true, userId: true } });
  return aggregateReactions(reactions, userId);
}

const MAX_POLL_OPTIONS = 6;

/**
 * A poll (or an availability check-in — same mechanic, `kind: 'AVAILABILITY'`) lives ON a
 * CrewMessage, one-to-one — a native conversational object, not a separate feature bolted next
 * to chat. See docs/DECISIONS.md#decision-objects.
 */
export async function createPoll(
  crewId: string,
  authorId: string,
  question: string,
  options: string[],
  kind: 'GENERAL' | 'AVAILABILITY' = 'GENERAL',
) {
  if (!(await isCrewMember(crewId, authorId))) {
    throw new ChatError('Not a member of this Crew.', 'not_a_member');
  }
  const trimmedQuestion = question.trim();
  const cleanOptions = [...new Set(options.map((o) => o.trim()).filter(Boolean))].slice(0, MAX_POLL_OPTIONS);
  if (!trimmedQuestion || cleanOptions.length < 2) {
    throw new ChatError('A poll needs a question and at least two options.', 'invalid_body');
  }

  const message = await prisma.crewMessage.create({
    data: {
      crewId,
      authorId,
      body: trimmedQuestion,
      poll: { create: { question: trimmedQuestion, options: cleanOptions, kind } },
    },
    select: messageAuthorSelect,
  });

  await track('CrewMessageSent', { crewId, userId: authorId }, { userId: authorId, crewId });
  await track('PollCreated', { crewId, messageId: message.id, kind, optionCount: cleanOptions.length }, { userId: authorId, crewId });

  return withReactionSummary(message, authorId);
}

/** Re-voting replaces the previous option (one live choice per person), same toggle-and-replace
 * semantics as reactions — except voting the SAME option again does nothing (a poll vote isn't
 * a toggle-off the way a reaction is; "I changed my mind back" just re-picks the same answer). */
export async function votePoll(crewId: string, messageId: string, userId: string, option: string) {
  if (!(await isCrewMember(crewId, userId))) {
    throw new ChatError('Not a member of this Crew.', 'not_a_member');
  }
  const message = await prisma.crewMessage.findUnique({ where: { id: messageId }, select: { crewId: true, poll: true } });
  if (!message || message.crewId !== crewId || !message.poll) {
    throw new ChatError('Poll not found in this Crew.', 'not_found');
  }
  const options = message.poll.options as string[];
  if (!options.includes(option)) {
    throw new ChatError('Not a valid option for this poll.', 'invalid_body');
  }

  await prisma.messagePollVote.upsert({
    where: { pollId_userId: { pollId: message.poll.id, userId } },
    update: { option },
    create: { pollId: message.poll.id, userId, option },
  });

  await track('PollVoted', { crewId, messageId, option }, { userId, crewId });

  const votes = await prisma.messagePollVote.findMany({ where: { pollId: message.poll.id }, select: { userId: true, option: true } });
  return summarisePoll(
    { id: message.poll.id, question: message.poll.question, options: message.poll.options, kind: message.poll.kind, votes },
    userId,
  );
}
