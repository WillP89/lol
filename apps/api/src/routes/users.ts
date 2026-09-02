import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, SESSION_COOKIE } from '../middleware/auth';
import { submitTasteSwipes, setLocationPreferences } from '../services/taste';
import { applyInterestUpdates, addFreeTextSignal, removeFreeTextSignal, setCategoryBudget, TASTE_TAXONOMY } from '../services/tasteSignals';
import { interpretTasteDescription, AiTasteSetupUnavailableError } from '../services/aiTasteSetup';
import { track } from '../services/analytics';
import { prisma } from '../lib/prisma';
import { revokeAllSessionsForUser } from '../services/auth';
import { saveUpload, deleteUpload, MediaValidationError, MediaStorageUnavailableError } from '../lib/mediaStorage';

const SwipeSchema = z.object({
  swipes: z.array(z.object({ category: z.string(), choice: z.enum(['yes', 'maybe', 'no']) })).min(1),
  budget: z.object({ minMinor: z.number().int().nonnegative(), maxMinor: z.number().int().nonnegative(), currency: z.string().length(3) }),
  travelRadiusMeters: z.number().int().positive(),
  energyPreference: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});

const ProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  homeCity: z.string().trim().min(1).max(120).optional(),
  homeLat: z.number().optional(),
  homeLng: z.number().optional(),
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
        avatarUrl: true,
        createdAt: true,
        tasteProfile: true,
        locationPrefs: { orderBy: { createdAt: 'asc' } },
        profile: true,
      },
    });
    return reply.send({ user });
  });

  // Name + home location — deliberately separate from the taste/swipe wizard (which is about
  // discovery preferences); this is core identity, set once in onboarding and editable from
  // Profile. Upserts Profile since a brand new user has none yet.
  app.post('/users/me/profile', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = ProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { displayName, homeCity, homeLat, homeLng } = parsed.data;

    if (displayName !== undefined) {
      await prisma.user.update({ where: { id: request.user.id }, data: { displayName } });
    }
    if (homeCity !== undefined || homeLat !== undefined || homeLng !== undefined) {
      await prisma.profile.upsert({
        where: { userId: request.user.id },
        update: {
          ...(homeCity !== undefined && { homeCity }),
          ...(homeLat !== undefined && { homeLat }),
          ...(homeLng !== undefined && { homeLng }),
        },
        create: { userId: request.user.id, homeCity: homeCity ?? null, homeLat: homeLat ?? null, homeLng: homeLng ?? null },
      });
    }
    const user = await prisma.user.findUnique({ where: { id: request.user.id }, select: { id: true, displayName: true, email: true, avatarUrl: true, profile: true } });
    return reply.send({ user });
  });

  // Real upload, not a base64 blob in the User row — see lib/mediaStorage.ts. Multipart because
  // this is a binary file, not JSON; requireUser first so an unauthenticated request never even
  // reaches the (comparatively expensive) file-read.
  app.post('/users/me/avatar', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'invalid_request', message: 'No image provided.' });
    const buffer = await file.toBuffer();
    try {
      const avatarUrl = await saveUpload({ buffer, mimeType: file.mimetype, kind: 'avatar' });
      const previous = await prisma.user.findUnique({ where: { id: request.user.id }, select: { avatarUrl: true } });
      await prisma.user.update({ where: { id: request.user.id }, data: { avatarUrl } });
      await deleteUpload(previous?.avatarUrl);
      return reply.send({ avatarUrl });
    } catch (err) {
      if (err instanceof MediaValidationError) return reply.code(400).send({ error: 'invalid_request', message: err.message });
      if (err instanceof MediaStorageUnavailableError) return reply.code(503).send({ error: 'storage_unavailable', message: err.message });
      throw err;
    }
  });

  app.delete('/users/me/avatar', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const previous = await prisma.user.findUnique({ where: { id: request.user.id }, select: { avatarUrl: true } });
    await prisma.user.update({ where: { id: request.user.id }, data: { avatarUrl: null } });
    await deleteUpload(previous?.avatarUrl);
    return reply.send({ ok: true });
  });

  // The second real identity choice, alongside upload: a Plot-drawn avatar (see
  // web/components/PlotAvatars.tsx) — no file at all, just a `plot-avatar:<id>` marker stored
  // in the same column a real photo URL would occupy. Validated server-side against the same
  // fixed set the picker offers, never trusting the client to only ever send a real one.
  const PresetSchema = z.object({ presetId: z.enum(['fox', 'owl', 'bear', 'tiger', 'frog', 'octopus', 'raccoon', 'shark', 'wolf', 'panther', 'seal', 'greyhound']) });
  app.post('/users/me/avatar/preset', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = PresetSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const previous = await prisma.user.findUnique({ where: { id: request.user.id }, select: { avatarUrl: true } });
    const avatarUrl = `plot-avatar:${parsed.data.presetId}`;
    await prisma.user.update({ where: { id: request.user.id }, data: { avatarUrl } });
    await deleteUpload(previous?.avatarUrl); // no-op if `previous` was itself a preset marker, not a real file
    return reply.send({ avatarUrl });
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

  // Public, no auth — the fixed taxonomy structure the "Tune My Plot" editor renders (territory
  // -> interest). Not user data, just the shape the picker is built from; served from the API
  // (rather than duplicated as a static import in the web app) so both stay on exactly the same
  // ids the scoring engine actually keys off (see @plot/shared/tasteTaxonomy.ts).
  app.get('/taste/taxonomy', async (_request, reply) => {
    return reply.send({ territories: TASTE_TAXONOMY });
  });

  const InterestUpdateSchema = z.object({
    updates: z
      .array(z.object({ interestId: z.string(), strength: z.enum(['love', 'like', 'open', 'not_for_me']) }))
      .min(1)
      .max(50),
  });
  // The granular editor's own write path — additive/merging (see tasteSignals.ts#applyInterestUpdates's
  // own comment), unlike the bulk onboarding swipe endpoint above.
  app.post('/users/me/taste/interests', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = InterestUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    const tasteProfile = await applyInterestUpdates(request.user.id, parsed.data.updates);
    return reply.send({ tasteProfile });
  });

  const FreeTextSchema = z.object({ text: z.string().trim().min(1).max(120) });
  app.post('/users/me/taste/free-text', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = FreeTextSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    const tasteProfile = await addFreeTextSignal(request.user.id, parsed.data.text);
    return reply.send({ tasteProfile });
  });

  app.delete('/users/me/taste/free-text', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = FreeTextSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    await removeFreeTextSignal(request.user.id, parsed.data.text);
    return reply.send({ ok: true });
  });

  const CategoryBudgetSchema = z.object({
    category: z.string(),
    // null clears the category-specific override, back to the one global budget range.
    range: z.object({ minMinor: z.number().int().nonnegative(), maxMinor: z.number().int().nonnegative() }).nullable(),
  });
  app.post('/users/me/taste/budget', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = CategoryBudgetSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    const tasteProfile = await setCategoryBudget(request.user.id, parsed.data.category, parsed.data.range);
    return reply.send({ tasteProfile });
  });

  // "Describe yourself and Plot sets up your taste for you" (services/aiTasteSetup.ts) — the
  // fast path onto exactly the same interestAffinity/freeTextSignals a manual Tune My Plot
  // session writes (applyInterestUpdates/addFreeTextSignal below), so what the AI picks is
  // reviewable and editable in that exact same sheet afterwards, never a separate black box.
  const AiSetupSchema = z.object({ description: z.string().trim().min(1).max(600) });
  app.post('/users/me/taste/ai-setup', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = AiSetupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });

    let selection;
    try {
      selection = await interpretTasteDescription(parsed.data.description);
    } catch (err) {
      if (err instanceof AiTasteSetupUnavailableError) return reply.code(503).send({ error: 'ai_unavailable', message: err.message });
      throw err;
    }

    if (selection.interestIds.length > 0) {
      await applyInterestUpdates(request.user.id, selection.interestIds.map((interestId) => ({ interestId, strength: 'like' as const })));
    }
    for (const text of selection.freeText) {
      await addFreeTextSignal(request.user.id, text).catch(() => {}); // best-effort — a dupe/empty entry never fails the whole setup
    }
    await track('AiTasteSetupApplied', { userId: request.user.id, interestCount: selection.interestIds.length, freeTextCount: selection.freeText.length }, { userId: request.user.id });

    const tasteProfile = await prisma.tasteProfile.findUnique({ where: { userId: request.user.id } });
    return reply.send({ tasteProfile, applied: selection });
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
