import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, SESSION_COOKIE } from '../middleware/auth';
import { submitTasteSwipes, setLocationPreferences } from '../services/taste';
import { track } from '../services/analytics';
import { prisma } from '../lib/prisma';
import { revokeAllSessionsForUser } from '../services/auth';

const SwipeSchema = z.object({
  swipes: z.array(z.object({ category: z.string(), choice: z.enum(['yes', 'maybe', 'no']) })).min(1),
  budget: z.object({ minMinor: z.number().int().nonnegative(), maxMinor: z.number().int().nonnegative(), currency: z.string().length(3) }),
  travelRadiusMeters: z.number().int().positive(),
  energyPreference: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});

const LocationSchema = z.object({
  prefs: z
    .array(
      z.object({
        kind: z.enum(['HOME', 'WORK', 'FAVOURITE', 'CITY']),
        label: z.string().min(1),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
      }),
    )
    .min(1),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users/me', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true,
        email: true,
        displayName: true,
        createdAt: true,
        tasteProfile: true,
        locationPrefs: { orderBy: { createdAt: 'asc' } },
      },
    });
    return reply.send({ user });
  });

  app.post('/users/me/taste', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = SwipeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });

    await track('TasteStarted', { userId: request.user.id }, { userId: request.user.id });
    await submitTasteSwipes(
      request.user.id,
      parsed.data.swipes,
      parsed.data.budget,
      parsed.data.travelRadiusMeters,
      parsed.data.energyPreference,
    );
    const tasteProfile = await prisma.tasteProfile.findUnique({ where: { userId: request.user.id } });
    return reply.send({ tasteProfile });
  });

  app.post('/users/me/locations', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = LocationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    await setLocationPreferences(request.user.id, parsed.data.prefs);
    return reply.send({ ok: true });
  });

  /**
   * Calendar connect: no real Google/Apple/Microsoft OAuth wired (see docs/providers/oauth.md
   * — the calendar-read scopes need the same OAuth app setup as sign-in, plus
   * calendar.readonly consent screen review for Google). This endpoint records a connection
   * and seeds AvailabilityWindow rows from client-submitted free/busy so the rest of the
   * product (Match's availability layer, Crew availability strip) is fully real against
   * whatever availability data exists — manual or synced use the identical downstream path.
   */
  const AvailabilitySchema = z.object({
    windows: z.array(z.object({ startsAt: z.string(), endsAt: z.string(), busy: z.boolean() })),
    source: z.enum(['CALENDAR_SYNC', 'MANUAL']).default('MANUAL'),
  });
  app.post('/users/me/availability', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = AvailabilitySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    await prisma.availabilityWindow.createMany({
      data: parsed.data.windows.map((w) => ({
        userId: request.user!.id,
        startsAt: new Date(w.startsAt),
        endsAt: new Date(w.endsAt),
        busy: w.busy,
        source: parsed.data.source,
      })),
    });

    if (parsed.data.source === 'CALENDAR_SYNC') {
      await track('CalendarConnected', { userId: request.user.id, provider: 'google' }, { userId: request.user.id });
    }
    return reply.send({ ok: true });
  });

  app.post('/users/me/calendar-skip', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    await track('CalendarSkipped', { userId: request.user.id }, { userId: request.user.id });
    return reply.send({ ok: true });
  });

  /** Account deactivation — reversible, revokes all sessions immediately (brief §9/§27). */
  app.post('/users/me/deactivate', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    await prisma.user.update({ where: { id: request.user.id }, data: { status: 'DEACTIVATED' } });
    await revokeAllSessionsForUser(request.user.id);
    // Sessions are revoked server-side either way, but also clearing the cookie here (rather
    // than leaving the browser holding a now-dead session id) means the client doesn't need a
    // separate logout call chained after this one to end up in a clean signed-out state.
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  /**
   * Account deletion — hard-deletes PII, keeps an anonymised audit trail. IntentSignal rows
   * are retained with userId nulled (aggregate analytics survive; the person doesn't remain
   * identifiable) rather than cascade-deleted, per data-retention practice described in
   * docs/PRIVACY.md.
   */
  app.post('/users/me/delete', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const userId = request.user.id;
    await revokeAllSessionsForUser(userId);
    await prisma.intentSignal.updateMany({ where: { userId }, data: { userId: null } });
    await prisma.auditEvent.create({ data: { actorUserId: null, action: 'user.delete', targetType: 'User', targetId: userId } });
    await prisma.user.update({
      where: { id: userId },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        email: `deleted-${userId}@plot.invalid`,
        phone: null,
        displayName: null,
      },
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
}
