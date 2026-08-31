import { prisma } from '../lib/prisma';
import { track } from './analytics';
import { computeCrewDna } from './crewDna';
import { requestMagicLink } from './auth';
import { sendCrewMessage } from './chat';
import type { Plan, PlanStatusValue, VoteValue } from '@prisma/client';

const READY_THRESHOLD = 0.6;

export interface PlanPulse {
  inCount: number;
  maybeCount: number;
  outCount: number;
  noResponseCount: number;
  totalMembers: number;
  level: number; // 0-1, inCount/totalMembers — what the UI renders as filled flames
  status: PlanStatusValue;
}

/**
 * The Plan status state machine (brief §15 "Plan Pulse"). Deliberately a pure function over
 * vote counts, not a stored transition table — there is exactly one legal current status for
 * any given vote distribution, computed fresh every time a vote changes. This means the status
 * can never drift out of sync with the votes that supposedly produced it.
 *
 * IDEA and BOOKED/COMPLETED/CANCELLED are NOT derived here — those are set explicitly by
 * createSoftPlan / markBooked / markCompleted / cancelPlan, since they represent actions
 * outside the voting loop (a soft plan with no venue yet, or a booking that already happened).
 */
export function derivePulseStatus(inFraction: number, currentStatus: PlanStatusValue): PlanStatusValue {
  if (['BOOKED', 'COMPLETED', 'CANCELLED', 'IDEA'].includes(currentStatus)) return currentStatus;
  if (inFraction >= READY_THRESHOLD) return 'READY';
  if (inFraction >= 0.5) return 'LIKELY';
  if (inFraction > 0) return 'GATHERING_INTEREST';
  return 'SHARED';
}

export async function computePlanPulse(planId: string): Promise<PlanPulse> {
  const [plan, members, votes] = await Promise.all([
    prisma.plan.findUniqueOrThrow({ where: { id: planId } }),
    prisma.planMember.count({ where: { planId } }),
    prisma.planVote.findMany({ where: { planId } }),
  ]);

  const inCount = votes.filter((v) => v.vote === 'IN').length;
  const maybeCount = votes.filter((v) => v.vote === 'MAYBE').length;
  const outCount = votes.filter((v) => v.vote === 'OUT').length;
  const noResponseCount = Math.max(0, members - votes.length);
  const level = members > 0 ? inCount / members : 0;

  return {
    inCount,
    maybeCount,
    outCount,
    noResponseCount,
    totalMembers: members,
    level,
    status: derivePulseStatus(level, plan.status),
  };
}

async function createPlanForCrew(
  crewId: string,
  proposedByUserId: string,
  data: {
    title: string;
    experienceId?: string;
    sourceOptionId?: string;
    status: PlanStatusValue;
    manualVenueName?: string;
    manualStartsAt?: Date;
  },
): Promise<Plan> {
  const members = await prisma.crewMember.findMany({ where: { crewId, status: 'ACTIVE' } });

  const plan = await prisma.plan.create({
    data: {
      crewId,
      proposedByUserId,
      title: data.title,
      experienceId: data.experienceId,
      sourceOptionId: data.sourceOptionId,
      status: data.status,
      manualVenueName: data.manualVenueName,
      manualStartsAt: data.manualStartsAt,
      members: { create: members.map((m) => ({ userId: m.userId })) },
    },
    include: { experience: true },
  });

  await track('SentToCrew', { crewId, planId: plan.id, source: data.sourceOptionId ? 'find_us_something' : 'individual_send' }, {
    userId: proposedByUserId,
    crewId,
    planId: plan.id,
  });

  // Sending something to the Crew is meaningless if nothing tells the Crew — post it into chat
  // so "talk it over" has somewhere to happen. Only when there's an actual thing attached (a
  // real Experience, or a manual venue/time) — not a vague IDEA-status soft plan with nothing
  // on it yet. Chat posting failing should never take the Plan itself down with it — the Plan
  // exists either way, so log and move on.
  if (data.experienceId || data.manualVenueName) {
    await sendCrewMessage(crewId, proposedByUserId, `📍 Sent "${plan.title}" to the Crew — /plans/${plan.publicSlug}`).catch(() => {});
  }

  return plan;
}

export async function createPlanFromRecommendationOption(crewId: string, optionId: string, userId: string): Promise<Plan> {
  const option = await prisma.planRecommendationOption.findUniqueOrThrow({
    where: { id: optionId },
    include: { experience: true },
  });
  return createPlanForCrew(crewId, userId, {
    title: option.experience.name,
    experienceId: option.experienceId,
    sourceOptionId: option.id,
    status: 'SHARED',
  });
}

export async function sendExperienceToCrew(crewId: string, experienceId: string, userId: string): Promise<Plan> {
  const experience = await prisma.experience.findUniqueOrThrow({ where: { id: experienceId } });
  return createPlanForCrew(crewId, userId, { title: experience.name, experienceId, status: 'SHARED' });
}

export async function createSoftPlan(crewId: string, userId: string, title: string): Promise<Plan> {
  return createPlanForCrew(crewId, userId, { title, status: 'IDEA' });
}

/**
 * A Plan with no Experience behind it at all — "Pub Saturday", "Dinner at Sarah's" — the
 * common case for most real plans, which never come from a ticketed inventory. See
 * docs/DECISIONS.md#manual-plans.
 */
export async function createManualPlanForCrew(
  crewId: string,
  userId: string,
  data: { title: string; venueName?: string; startsAt?: Date },
): Promise<Plan> {
  return createPlanForCrew(crewId, userId, {
    title: data.title,
    status: 'SHARED',
    manualVenueName: data.venueName,
    manualStartsAt: data.startsAt,
  });
}

/**
 * Vote submission. Supports an unauthenticated respondent identified only by email — the
 * Plan Card growth mechanic (brief §16-19) explicitly requires responding without an account.
 * We upsert a User by email (same pattern as the magic-link flow), add them as a PlanMember if
 * they weren't already invited (they arrived via a shared link, not a Crew invite), record the
 * vote, and separately issue a magic link so they CAN convert to a full session — but the vote
 * itself never blocks on that happening.
 */
export async function submitVote(
  planId: string,
  vote: 'in' | 'maybe' | 'out',
  identity: { userId?: string; email?: string },
  requestIp?: string,
): Promise<{ pulse: PlanPulse; devMagicLinkUrl?: string }> {
  let userId = identity.userId;
  let devMagicLinkUrl: string | undefined;

  if (!userId) {
    if (!identity.email) throw new Error('Either userId or email is required to vote.');
    const user = await prisma.user.upsert({
      where: { email: identity.email.toLowerCase() },
      update: {},
      create: { email: identity.email.toLowerCase() },
    });
    userId = user.id;
    const linkResult = await requestMagicLink(identity.email, requestIp);
    devMagicLinkUrl = linkResult.devMagicLinkUrl;
  }

  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });

  await prisma.planMember.upsert({
    where: { planId_userId: { planId, userId } },
    update: {},
    create: { planId, userId },
  });

  await prisma.planVote.upsert({
    where: { planId_userId: { planId, userId } },
    update: { vote: voteToEnum(vote) },
    create: { planId, userId, vote: voteToEnum(vote) },
  });

  await track('VoteSubmitted', { planId, userId, vote: enumToVote(voteToEnum(vote)) }, { userId, planId, crewId: plan.crewId });

  const pulse = await computePlanPulse(planId);

  if (pulse.status !== plan.status) {
    await prisma.plan.update({ where: { id: planId }, data: { status: pulse.status } });
    await track('PlanPulseChanged', { planId, pulseLevel: pulse.level, status: pulse.status }, { planId, crewId: plan.crewId });
    if (pulse.status === 'READY') {
      await track('PlanReady', { planId, crewId: plan.crewId }, { planId, crewId: plan.crewId });
    }
  }

  return { pulse, devMagicLinkUrl };
}

function voteToEnum(v: VoteValue | 'in' | 'maybe' | 'out'): VoteValue {
  if (v === 'in' || v === 'IN') return 'IN';
  if (v === 'maybe' || v === 'MAYBE') return 'MAYBE';
  return 'OUT';
}
function enumToVote(v: VoteValue): 'in' | 'maybe' | 'out' {
  return v === 'IN' ? 'in' : v === 'MAYBE' ? 'maybe' : 'out';
}

/**
 * "Lock it in" — the payoff moment the whole decision loop exists for: an idea becoming a
 * commitment. Deliberately a direct, explicit status transition to BOOKED, not something that
 * only happens as a side effect of creating a real Booking record — a manual Plan ("Pub
 * Saturday") has nothing to book but still needs to be lockable. A ticketed Plan can still go
 * on to a real Booking afterward (see services/booking.ts); this just marks the group's actual
 * decision. Posts a system message so the moment shows up in the conversation itself, the same
 * way a Plan being sent does. See docs/DECISIONS.md#decision-objects.
 */
export async function lockPlan(planId: string, userId: string): Promise<Plan> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  if (plan.status === 'BOOKED' || plan.status === 'COMPLETED' || plan.status === 'CANCELLED') return plan;

  const updated = await prisma.plan.update({ where: { id: planId }, data: { status: 'BOOKED' } });
  await track('PlanLocked', { planId, crewId: plan.crewId, userId }, { userId, crewId: plan.crewId, planId });
  await sendCrewMessage(plan.crewId, userId, `🔒 "${plan.title}" was locked in — see you there.`).catch(() => {});
  return updated;
}

export async function getPlanById(planId: string) {
  return prisma.plan.findUnique({
    where: { id: planId },
    include: {
      experience: { include: { venue: true } },
      crew: { select: { id: true, name: true } },
      members: { include: { user: { select: { id: true, displayName: true, email: true } } } },
      votes: true,
      bookings: true,
    },
  });
}

export async function getPlanBySlug(slug: string) {
  return prisma.plan.findUnique({
    where: { publicSlug: slug },
    include: {
      experience: { include: { venue: true } },
      crew: { select: { id: true, name: true } },
      members: { include: { user: { select: { id: true, displayName: true } } } },
      votes: true,
    },
  });
}

export async function markCompleted(planId: string): Promise<void> {
  const plan = await prisma.plan.update({ where: { id: planId }, data: { status: 'COMPLETED', completedAt: new Date() } });
  await track('PlanCompleted', { planId, crewId: plan.crewId }, { planId, crewId: plan.crewId });
  await computeCrewDna(plan.crewId);

  const priorCompleted = await prisma.plan.count({ where: { crewId: plan.crewId, status: 'COMPLETED', id: { not: planId } } });
  if (priorCompleted === 0) {
    const firstPlan = await prisma.plan.findFirst({ where: { crewId: plan.crewId }, orderBy: { createdAt: 'asc' } });
    if (firstPlan) {
      const days = Math.round((Date.now() - firstPlan.createdAt.getTime()) / (1000 * 60 * 60 * 24));
      await track('CrewSecondPlan', { crewId: plan.crewId, daysSinceFirstPlan: days }, { crewId: plan.crewId });
    }
  }
}

export async function cancelPlan(planId: string): Promise<void> {
  await prisma.plan.update({ where: { id: planId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
}
