import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../middleware/auth';
import { createCrew, joinCrewByInviteCode, listCrewsForUser, getCrewDetail, getCrewPreviewByInviteCode, isCrewMember } from '../services/crew';
import { sendCrewMessage, listCrewMessages, toggleReaction, createPoll, votePoll, ChatError } from '../services/chat';
import { track } from '../services/analytics';
import { getOrCreateSettings, updateSettings, respondToRecommendation, RecommendationError } from '../services/crewRecommendations';
import { saveUpload, deleteUpload, MediaValidationError } from '../lib/mediaStorage';
import { prisma } from '../lib/prisma';

const CreateCrewSchema = z.object({ name: z.string().min(1).max(60), defaultCity: z.string().optional() });
const JoinCrewSchema = z.object({ inviteCode: z.string().min(1) });

export async function crewRoutes(app: FastifyInstance): Promise<void> {
  app.post('/crews', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = CreateCrewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });

    const crew = await createCrew(request.user.id, parsed.data.name, parsed.data.defaultCity);
    return reply.code(201).send({ crew });
  });

  app.get('/crews', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const crews = await listCrewsForUser(request.user.id);
    return reply.send({ crews });
  });

  app.get('/crews/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    const crew = await getCrewDetail(id, request.user.id);
    if (!crew) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ crew });
  });

  // Real Crew identity — the schema already had `imageUrl` (unused until now, always null),
  // and every Crew fell back to the same "initials in a coloured circle" every person also
  // used, with zero way to tell a group from a person at a glance. Gated the same way every
  // other Crew-mutating action is (isCrewMember, not an owner-only check) — consistent with
  // this codebase's existing pilot-scale permission model, not a new one invented for this.
  app.post('/crews/:id/image', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!(await isCrewMember(id, request.user.id))) return reply.code(403).send({ error: 'forbidden' });
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'invalid_request', message: 'No image provided.' });
    const buffer = await file.toBuffer();
    try {
      const imageUrl = await saveUpload({ buffer, mimeType: file.mimetype, kind: 'crew' });
      const previous = await prisma.crew.findUnique({ where: { id }, select: { imageUrl: true } });
      await prisma.crew.update({ where: { id }, data: { imageUrl } });
      await deleteUpload(previous?.imageUrl);
      return reply.send({ imageUrl });
    } catch (err) {
      if (err instanceof MediaValidationError) return reply.code(400).send({ error: 'invalid_request', message: err.message });
      throw err;
    }
  });

  app.delete('/crews/:id/image', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!(await isCrewMember(id, request.user.id))) return reply.code(403).send({ error: 'forbidden' });
    const previous = await prisma.crew.findUnique({ where: { id }, select: { imageUrl: true } });
    await prisma.crew.update({ where: { id }, data: { imageUrl: null } });
    await deleteUpload(previous?.imageUrl);
    return reply.send({ ok: true });
  });

  // Deliberately public — no requireUser — so tapping an invite link shows who/what you're
  // joining before forcing sign-in, not a generic login wall. See getCrewPreviewByInviteCode's
  // own comment for exactly what this does and doesn't expose.
  app.get('/crews/preview/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const preview = await getCrewPreviewByInviteCode(code);
    if (!preview) return reply.code(404).send({ error: 'not_found' });
    await track('InviteOpened', { inviteCode: code, authenticated: Boolean(request.user) }, { userId: request.user?.id });
    return reply.send({ preview });
  });

  app.post('/crews/join', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = JoinCrewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const result = await joinCrewByInviteCode(request.user.id, parsed.data.inviteCode);
    if (!result) return reply.code(404).send({ error: 'not_found', message: 'Invalid invite code.' });
    await track('InviteAccepted', { crewId: result.crew.id, userId: request.user.id }, { userId: request.user.id, crewId: result.crew.id });
    return reply.send(result);
  });

  app.post('/crews/:id/invites', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    const BodySchema = z.object({ channel: z.enum(['link', 'whatsapp', 'imessage', 'sms', 'other']) });
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const crew = await getCrewDetail(id, request.user.id);
    if (!crew) return reply.code(404).send({ error: 'not_found' });

    await track('CrewInviteSent', { crewId: id, channel: parsed.data.channel }, { userId: request.user.id, crewId: id });

    return reply.send({ inviteUrl: `${process.env.WEB_APP_URL ?? ''}/crews/join/${crew.inviteCode}` });
  });

  app.get('/crews/:id/messages', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    const { after } = request.query as { after?: string };

    try {
      const messages = await listCrewMessages(id, request.user.id, after);
      return reply.send({ messages });
    } catch (err) {
      if (err instanceof ChatError) return reply.code(403).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/crews/:id/messages', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    const BodySchema = z.object({ body: z.string().min(1).max(2000) });
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });

    try {
      const message = await sendCrewMessage(id, request.user.id, parsed.data.body);
      return reply.code(201).send({ message });
    } catch (err) {
      if (err instanceof ChatError) {
        const status = err.code === 'not_a_member' ? 403 : 400;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // A poll (or an availability check-in — `kind: AVAILABILITY`, same mechanic, different
  // options/label) is a native conversational object, not a form bolted next to chat — see
  // docs/DECISIONS.md#decision-objects. Both routes 404 rather than 403 on "poll not found in
  // this Crew" so a member of one Crew can't probe whether a given message id belongs to
  // another Crew's poll.
  app.post('/crews/:id/polls', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    const BodySchema = z.object({
      question: z.string().min(1).max(200),
      options: z.array(z.string().min(1).max(60)).min(2).max(6),
      kind: z.enum(['GENERAL', 'AVAILABILITY']).optional(),
    });
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });

    try {
      const message = await createPoll(id, request.user.id, parsed.data.question, parsed.data.options, parsed.data.kind);
      return reply.code(201).send({ message });
    } catch (err) {
      if (err instanceof ChatError) {
        const status = err.code === 'not_a_member' ? 403 : 400;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/crews/:id/messages/:messageId/poll-vote', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id, messageId } = request.params as { id: string; messageId: string };
    const BodySchema = z.object({ option: z.string().min(1).max(60) });
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    try {
      const poll = await votePoll(id, messageId, request.user.id, parsed.data.option);
      return reply.send({ poll });
    } catch (err) {
      if (err instanceof ChatError) {
        const status = err.code === 'not_a_member' ? 403 : err.code === 'not_found' ? 404 : 400;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/crews/:id/messages/:messageId/react', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id, messageId } = request.params as { id: string; messageId: string };
    const BodySchema = z.object({ emoji: z.string().min(1).max(8) });
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    try {
      const reactions = await toggleReaction(id, messageId, request.user.id, parsed.data.emoji);
      return reply.send({ reactions });
    } catch (err) {
      if (err instanceof ChatError) {
        const status = err.code === 'not_a_member' ? 403 : err.code === 'not_found' ? 404 : 400;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // The auto-recommendation system's lightweight Crew-level controls (brief: "on/off,
  // frequency, travel range") — deliberately just these three, not a settings page. See
  // docs/DECISIONS.md#crew-auto-recommendations.
  app.get('/crews/:id/recommendation-settings', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!(await isCrewMember(id, request.user.id))) return reply.code(403).send({ error: 'forbidden' });
    const settings = await getOrCreateSettings(id);
    return reply.send({ settings });
  });

  const UpdateSettingsSchema = z.object({
    enabled: z.boolean().optional(),
    maxPerWeek: z.number().int().min(0).max(7).optional(),
    // Explicit null clears the override (back to per-member-average); undefined leaves it
    // untouched — the schema can't express "clear vs. don't touch" with .optional() alone.
    travelRadiusMeters: z.number().int().positive().nullable().optional(),
  });
  app.patch('/crews/:id/recommendation-settings', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!(await isCrewMember(id, request.user.id))) return reply.code(403).send({ error: 'forbidden' });
    const parsed = UpdateSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    const settings = await updateSettings(id, parsed.data);
    return reply.send({ settings });
  });

  const RespondSchema = z.object({
    action: z.enum(['more_like_this', 'not_for_us', 'too_far', 'too_expensive', 'wrong_vibe']),
  });
  app.post('/crews/:id/recommendations/:recId/respond', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const { id, recId } = request.params as { id: string; recId: string };
    if (!(await isCrewMember(id, request.user.id))) return reply.code(403).send({ error: 'forbidden' });
    const parsed = RespondSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    try {
      const recommendation = await respondToRecommendation(id, recId, request.user.id, parsed.data.action);
      return reply.send({ recommendation });
    } catch (err) {
      if (err instanceof RecommendationError) {
        return reply.code(err.code === 'not_found' ? 404 : 400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
