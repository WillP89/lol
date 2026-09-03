import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config, providerReadiness } from '../lib/config';
import { sendEmail, crewMessageDigestBody } from '../lib/email';
import { displayNameOf } from '../lib/displayName';
import { track } from './analytics';
import { Prisma } from '@prisma/client';

/**
 * The email half of "notifications of messages in crews that you're in" — a real, explicit
 * product request, implemented as a debounced DIGEST, not one email per message. Sending one
 * email per message would flood an inbox the moment a Crew's chat gets genuinely active (exactly
 * the kind of thing that trains people to ignore, then block, product email) — this instead
 * waits for a real quiet window after the newest unread message before considering someone
 * "not about to check it themselves", then sends at most ONE email covering everything they
 * missed since their last one. See runMessageNotificationSweepIfDue's own comment for the
 * scheduling half of this, mirroring services/crewRecommendations.ts's DB-backed scheduler
 * pattern exactly (SchedulerState.lastClaimedAt, not a bare in-memory setInterval — see that
 * file's own comment for the full reasoning, which applies identically here).
 *
 * Deliberately on by default (CrewMember.emailNotificationsEnabled, migration
 * `crew_member_email_notifications`) per the explicit request to "bake this in" — but always a
 * real, working opt-out (PATCH /crews/:id/notifications), never a dark pattern.
 */

// How long a message has to sit unread before it's fair to assume the recipient isn't about to
// open the app themselves in the next moment — short enough that the email still feels timely,
// long enough that a normal back-and-forth conversation doesn't trigger one.
export const MESSAGE_NOTIFICATION_QUIET_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// How overdue (per the database, not this process's own uptime) a sweep has to be before it's
// worth running — deliberately much shorter than the other sweeps in this codebase (hours):
// this one is a near-real-time digest, not a periodic batch job, so it needs to check often for
// newly-quiet backlogs. See crewRecommendations.ts#runSweepIfDue for why DUE and CHECK are two
// separate numbers at all.
export const MESSAGE_NOTIFICATION_SWEEP_DUE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

// Bounds how far back this ever looks for "unread" activity — a Crew that's been silent for
// weeks has nothing this sweep needs to consider, so there's no reason to scan its entire
// history every 3 minutes. Generous relative to the quiet window above so nothing genuinely
// pending ever falls outside it.
const ACTIVITY_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

const MAX_PREVIEW_ITEMS = 5;
const PREVIEW_LENGTH = 90;

function truncate(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > PREVIEW_LENGTH ? `${oneLine.slice(0, PREVIEW_LENGTH - 1)}…` : oneLine;
}

export interface MessageNotificationSweepResult {
  crewsScanned: number;
  membersConsidered: number;
  emailsSent: number;
  errors: number;
}

/**
 * The one function that ever actually sends digest emails — server.ts's periodic check and
 * POST /admin/message-notifications/sweep both call this indirectly via
 * runMessageNotificationSweepIfDue below, never this directly, so there's exactly one path that
 * can double-send.
 */
export async function runMessageNotificationSweep(): Promise<MessageNotificationSweepResult> {
  const emailReady = providerReadiness.resendEmail || providerReadiness.smtpEmail || providerReadiness.postmarkEmail;
  const now = new Date();
  const quietCutoff = new Date(now.getTime() - MESSAGE_NOTIFICATION_QUIET_WINDOW_MS);
  const activitySince = new Date(now.getTime() - ACTIVITY_LOOKBACK_MS);

  // Only Crews with SOME recent activity even need considering — bounds the scan to real
  // candidates instead of every Crew that's ever existed.
  const crews = await prisma.crew.findMany({
    where: { archivedAt: null, messages: { some: { createdAt: { gte: activitySince } } } },
    select: {
      id: true,
      name: true,
      messages: {
        where: { createdAt: { gte: activitySince } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, createdAt: true, authorId: true, author: { select: { displayName: true, email: true } } },
      },
      members: {
        where: { status: 'ACTIVE' },
        select: {
          userId: true,
          lastReadAt: true,
          emailNotificationsEnabled: true,
          lastEmailNotifiedAt: true,
          user: { select: { email: true, displayName: true, status: true } },
        },
      },
    },
  });

  let membersConsidered = 0;
  let emailsSent = 0;
  let errors = 0;

  for (const crew of crews) {
    for (const member of crew.members) {
      if (!member.emailNotificationsEnabled) continue;
      if (member.user.status !== 'ACTIVE') continue;

      const sinceAt = member.lastReadAt ?? new Date(0);
      const unread = crew.messages.filter((m) => m.authorId !== member.userId && m.createdAt > sinceAt);
      if (unread.length === 0) continue;

      membersConsidered++;

      const latest = unread[unread.length - 1];
      if (latest.createdAt > quietCutoff) continue; // still might check it themselves any second
      if (member.lastEmailNotifiedAt && member.lastEmailNotifiedAt >= latest.createdAt) continue; // already covered

      const items = unread.slice(-MAX_PREVIEW_ITEMS).map((m) => ({
        authorName: displayNameOf(m.author.displayName, m.author.email),
        preview: truncate(m.body),
      }));

      try {
        if (emailReady) {
          await sendEmail(
            member.user.email,
            crewMessageDigestBody({
              crewName: crew.name,
              crewUrl: `${config.WEB_APP_URL}/crews/${crew.id}`,
              items,
              totalUnread: unread.length,
            }),
          );
        } else {
          // No provider configured (local/dev) — log loudly instead of silently no-op'ing, same
          // "still testable without real credentials" bar as every other email path here, but
          // logged rather than returned (there's no HTTP caller waiting on this background sweep).
          logger.info({ to: member.user.email, crewId: crew.id, unreadCount: unread.length }, 'Message digest — no email provider configured, logging instead of sending');
        }
        await prisma.crewMember.update({
          where: { crewId_userId: { crewId: crew.id, userId: member.userId } },
          data: { lastEmailNotifiedAt: latest.createdAt },
        });
        await track('CrewMessageDigestEmailSent', { crewId: crew.id, userId: member.userId, messageCount: unread.length }, { userId: member.userId, crewId: crew.id });
        emailsSent++;
      } catch (err) {
        errors++;
        logger.error({ err, crewId: crew.id, userId: member.userId }, 'Message digest email failed');
      }
    }
  }

  return { crewsScanned: crews.length, membersConsidered, emailsSent, errors };
}

const JOB_NAME = 'crew_message_notification_sweep';

/** Same atomic-claim pattern as crewRecommendations.ts#claimSweepIfDue — see that function's own
 * comment for the full "why a database claim, not a bare setInterval" reasoning, which applies
 * identically here. */
async function claimSweepIfDue(dueIntervalMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - dueIntervalMs);
  const now = new Date();

  await prisma.schedulerState.upsert({ where: { jobName: JOB_NAME }, update: {}, create: { jobName: JOB_NAME } });

  const claim = await prisma.schedulerState.updateMany({
    where: { jobName: JOB_NAME, OR: [{ lastClaimedAt: null }, { lastClaimedAt: { lt: cutoff } }] },
    data: { lastClaimedAt: now },
  });

  return claim.count === 1;
}

export async function runMessageNotificationSweepIfDue(
  dueIntervalMs: number,
): Promise<{ ran: boolean; result?: MessageNotificationSweepResult }> {
  const claimed = await claimSweepIfDue(dueIntervalMs);
  if (!claimed) return { ran: false };

  const result = await runMessageNotificationSweep();
  await prisma.schedulerState.update({
    where: { jobName: JOB_NAME },
    data: { lastRunAt: new Date(), lastResult: result as unknown as Prisma.InputJsonValue },
  });
  return { ran: true, result };
}
