import type { AnalyticsEventName, AnalyticsEventPayloads } from '@plot/shared';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

/**
 * The single write path for IntentSignal rows. Every call site imports the event NAME from
 * `@plot/shared` (never a raw string) so a typo can't silently create a new, unqueryable event
 * name — TypeScript will refuse to compile `track('CrewCraeted', ...)`.
 *
 * This is intentionally synchronous-looking but fire-and-forget from the caller's perspective:
 * analytics must never be the reason a user-facing request fails. Failures are logged, not
 * thrown. See docs/ARCHITECTURE.md §Analytics.
 */
export async function track<K extends AnalyticsEventName>(
  name: K,
  payload: AnalyticsEventPayloads[K],
  context: { userId?: string; anonymousId?: string; crewId?: string; planId?: string } = {},
): Promise<void> {
  try {
    await prisma.intentSignal.create({
      data: {
        name,
        userId: context.userId,
        anonymousId: context.anonymousId,
        crewId: context.crewId,
        planId: context.planId,
        payload: payload as object,
      },
    });
  } catch (err) {
    logger.error({ err, event: name }, 'Failed to persist analytics event');
  }
}
