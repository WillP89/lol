import { prisma } from '../lib/prisma';
import { track } from './analytics';
import { computeCrewDna } from './crewDna';
import { requestMagicLink } from './auth';
import { sendCrewMessage, sendSystemMessage } from './chat';
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
 * IDEA and LOCKED/BOOKED/COMPLETED/CANCELLED are NOT derived here — those are set explicitly by
 * createSoftPlan / lockPlan / confirmDeepLinkBooking / markCompleted / cancelPlan, since they
 * represent actions outside the voting loop (a soft plan with no venue yet, the Crew committing
 * regardless of the vote tally, or a booking that already happened).
 */
export function derivePulseStatus(inFraction: number, currentStatus: PlanStatusValue): PlanStatusValue {
  if (['LOCKED', 'BOOKED', 'COMPLETED', 'CANCELLED', 'IDEA'].includes(currentStatus)) return currentStatus;
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
  // so "talk it over" has somewhere to happen. Only skip this for a genuinely vague IDEA-status
  // soft plan with nothing on it yet — everything else (a real Experience, OR a manual plan
  // with just a title and no venue/time filled in) is a real thing the Crew should see.
  //
  // Real bug found via a fresh test (not assumed): this used to check `manualVenueName`
  // specifically rather than `status`, so logging a manual plan with only a title (no venue, no
  // time — a completely normal thing to do: "Pub Saturday", venue TBC) created a real Plan row
  // but silently posted NOTHING to chat. The plan existed in the database but was invisible to
  // the group — the exact "nothing happens" failure mode, just one screen over from the booking
  // bug this same pass fixed. See docs/DECISIONS.md#booking-status-split.
  if (data.status !== 'IDEA') {
    // No emoji prefix — same brand-pass gap as lockPlan's message below. This exact string is
    // pattern-matched client-side (MEMBER_PLAN_ANNOUNCEMENT in crews/[id]/page.tsx and
    // lib/messagePreview.ts) to swap in the real EventCard UI, so it's never shown verbatim
    // anyway; keep those two regexes in sync with this template if it ever changes again.
    await sendCrewMessage(crewId, proposedByUserId, `Sent "${plan.title}" to the Crew — /plans/${plan.publicSlug}`).catch(() => {});
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

/**
 * The automatic recommendation engine's own delivery path (services/crewRecommendations.ts) —
 * everything `sendExperienceToCrew` does (a real Plan, votable/lockable exactly like a
 * member-shared idea), except the announcement is posted by the Plot system user via
 * `sendSystemMessage` with distinct copy and emoji, so it never reads as if a real person
 * shared it. Returns the chat message's id alongside the Plan so the caller can link the
 * CrewRecommendation row to it. See docs/DECISIONS.md#crew-auto-recommendations.
 */
export async function createRecommendationPlanForCrew(
  crewId: string,
  experienceId: string,
  systemUserId: string,
): Promise<{ plan: Plan; messageId: string }> {
  const experience = await prisma.experience.findUniqueOrThrow({ where: { id: experienceId } });
  const members = await prisma.crewMember.findMany({ where: { crewId, status: 'ACTIVE' } });

  const plan = await prisma.plan.create({
    data: {
      crewId,
      proposedByUserId: systemUserId,
      title: experience.name,
      experienceId,
      status: 'SHARED',
      members: { create: members.map((m) => ({ userId: m.userId })) },
    },
    include: { experience: true },
  });

  await track('SentToCrew', { crewId, planId: plan.id, source: 'recommendation' }, { userId: systemUserId, crewId, planId: plan.id });

  // No sparkle emoji — the exact "AI sparkle mark for a recommendation" the brand pass named as
  // wrong, just missed in the icon-system audit because this is a chat message string, not a
  // rendered icon (the EventCard badge itself was already fixed to IconGathering). Client-side
  // regex match (RECOMMENDATION_PLAN_ANNOUNCEMENT) updated to match.
  const message = await sendSystemMessage(
    crewId,
    systemUserId,
    `Plot found something your Crew might like: "${plan.title}" — /plans/${plan.publicSlug}`,
  );

  return { plan, messageId: message.id };
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
 * commitment. Transitions to LOCKED, not BOOKED — a real bug found via a fresh live test (not
 * assumed): setting BOOKED here made the booking page immediately claim "✓ Booked — Added to
 * everyone's calendar" for a plan nobody had actually paid for or booked anywhere (no calendar
 * integration exists at all), and made the real deep-link booking flow unreachable from the
 * normal Lock It In path — see docs/DECISIONS.md#booking-status-split. LOCKED means "the Crew's
 * decision is final"; BOOKED is now reserved for confirmDeepLinkBooking, i.e. a real booking
 * transaction actually happened. A manual Plan ("Pub Saturday") has nothing to book and stays
 * at LOCKED forever, correctly — that's not a lesser state, it's the correct terminal one for a
 * plan with no ticket to buy. Posts a system message so the moment shows up in the conversation
 * itself, the same way a Plan being sent does. See docs/DECISIONS.md#decision-objects.
 */
export async function lockPlan(planId: string, userId: string): Promise<Plan> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  if (plan.status === 'LOCKED' || plan.status === 'BOOKED' || plan.status === 'COMPLETED' || plan.status === 'CANCELLED') return plan;

  const updated = await prisma.plan.update({ where: { id: planId }, data: { status: 'LOCKED' } });
  await track('PlanLocked', { planId, crewId: plan.crewId, userId }, { userId, crewId: plan.crewId, planId });
  // Real gap caught via a live screenshot during the brand pass: this system message stored a
  // literal 🔒 emoji as part of its plain-text body — exactly the "Lock It In uses a lock
  // emoji, remove it" case the brief named specifically, just missed during the icon-system
  // audit because it lives in a chat message string, not a rendered React icon. The words
  // "locked in" already carry the meaning; removed outright rather than icon-replaced, same as
  // every other decorative emoji this codebase found with nothing real left to represent once
  // stripped. See docs/DECISIONS.md#plot-brand-system.
  await sendCrewMessage(plan.crewId, userId, `"${plan.title}" was locked in — see you there.`).catch(() => {});
  return updated;
}

// `listings` capped to 1, most-recently-refreshed provider first — an Experience can have more
// than one ProviderListing (Ticketmaster AND Skiddle both matching the same real event), but the
// Plan Card/booking pages only need ONE real "view it at the source" link, not every provider's
// own copy of it. `externalUrl` lives on ProviderListing, not Experience itself (a canonical
// Experience is provider-agnostic by design — see entityResolution.ts) — this is the one place
// that needs a real link out, so it reaches in for it rather than duplicating the field.
const EXPERIENCE_INCLUDE = { include: { venue: true, listings: { orderBy: { lastRefreshedAt: 'desc' as const }, take: 1 } } };

export async function getPlanById(planId: string) {
  return prisma.plan.findUnique({
    where: { id: planId },
    include: {
      experience: EXPERIENCE_INCLUDE,
      crew: { select: { id: true, name: true } },
      members: { include: { user: { select: { id: true, displayName: true, email: true, avatarUrl: true } } } },
      votes: true,
      bookings: true,
    },
  });
}

export async function getPlanBySlug(slug: string) {
  return prisma.plan.findUnique({
    where: { publicSlug: slug },
    include: {
      experience: EXPERIENCE_INCLUDE,
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
