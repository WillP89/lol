import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../middleware/auth';
import { createCrew, joinCrewByInviteCode, listCrewsForUser, getCrewDetail } from '../services/crew';
import { sendCrewMessage, listCrewMessages, toggleReaction, ChatError } from '../services/chat';
import { track } from '../services/analytics';

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

  app.post('/crews/join', async (request, reply) => {
    if (!requireUser(request, reply)) return;
    const parsed = JoinCrewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const result = await joinCrewByInviteCode(request.user.id, parsed.data.inviteCode);
    if (!result) return reply.code(404).send({ error: 'not_found', message: 'Invalid invite code.' });
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
}
