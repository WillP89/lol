import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * The new social-first surfaces from the "PLOT — product re-architecture" milestone: the
 * pre-auth invite preview, native poll objects, manual (non-ticketed) Plans, and the explicit
 * lock-in transition. Same integration-test-against-real-Postgres approach as golden-path.
 */

const app = buildApp();

async function loginByEmail(email: string): Promise<{ userId: string; cookie: string }> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  const { user } = callbackRes.json() as { user: { id: string } };
  return { userId: user.id, cookie: `${cookie.name}=${cookie.value}` };
}

describe('social v2: invite preview, polls, manual plans, lock-in', () => {
  let will: { userId: string; cookie: string };
  let sam: { userId: string; cookie: string };
  let crewId = '';
  let inviteCode = '';

  beforeAll(async () => {
    await resetDatabase();
    will = await loginByEmail('will@plot-test.invalid');
    sam = await loginByEmail('sam-v2@plot-test.invalid');

    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: will.cookie },
      payload: { name: 'Weekend Crew', defaultCity: 'Stafford' },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    crewId = crew.id;
    inviteCode = crew.inviteCode;
  });

  test('the invite preview is public — no auth required — and never leaks message content', async () => {
    const res = await app.inject({ method: 'GET', url: `/crews/preview/${inviteCode}` });
    expect(res.statusCode).toBe(200);
    const { preview } = res.json() as { preview: { name: string; memberCount: number; memberInitials: string[] } };
    expect(preview.name).toBe('Weekend Crew');
    expect(preview.memberCount).toBe(1);
    expect(preview.memberInitials.length).toBe(1);
    expect(JSON.stringify(preview)).not.toMatch(/@/); // no email addresses in the public payload
  });

  test('an invalid invite code 404s, not 500s', async () => {
    const res = await app.inject({ method: 'GET', url: '/crews/preview/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  test('a non-member cannot vote on a poll that does not belong to their Crew (IDOR check)', async () => {
    const otherCrewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: sam.cookie },
      payload: { name: "Sam's Other Crew" },
    });
    const { crew: otherCrew } = otherCrewRes.json() as { crew: { id: string } };

    const pollRes = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/polls`,
      headers: { cookie: will.cookie },
      payload: { question: 'Which night?', options: ['Friday', 'Saturday', 'Sunday'] },
    });
    expect(pollRes.statusCode).toBe(201);
    const { message } = pollRes.json() as { message: { id: string; poll: { options: string[] } } };

    // Sam is a member of `otherCrew`, not `crewId` — voting via otherCrew's id must 404, not
    // silently succeed against a poll id they guessed/enumerated.
    const voteRes = await app.inject({
      method: 'POST',
      url: `/crews/${otherCrew.id}/messages/${message.id}/poll-vote`,
      headers: { cookie: sam.cookie },
      payload: { option: 'Friday' },
    });
    expect(voteRes.statusCode).toBe(404);
  });

  test('join Sam into the Crew, then poll create + vote + live tally', async () => {
    const joinRes = await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: sam.cookie }, payload: { inviteCode } });
    expect(joinRes.statusCode).toBe(200);

    const pollRes = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/polls`,
      headers: { cookie: will.cookie },
      payload: { question: 'Food festival or comedy?', options: ['Food festival', 'Comedy'] },
    });
    expect(pollRes.statusCode).toBe(201);
    const { message } = pollRes.json() as { message: { id: string; poll: { options: string[]; counts: Record<string, number> } } };
    expect(message.poll.options).toEqual(['Food festival', 'Comedy']);
    expect(message.poll.counts['Food festival']).toBe(0);

    const vote1 = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages/${message.id}/poll-vote`,
      headers: { cookie: will.cookie },
      payload: { option: 'Food festival' },
    });
    expect(vote1.statusCode).toBe(200);

    const vote2 = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages/${message.id}/poll-vote`,
      headers: { cookie: sam.cookie },
      payload: { option: 'Food festival' },
    });
    const { poll } = vote2.json() as { poll: { counts: Record<string, number>; totalVotes: number; myVote: string } };
    expect(poll.counts['Food festival']).toBe(2);
    expect(poll.totalVotes).toBe(2);
    expect(poll.myVote).toBe('Food festival');

    // Both members should now see the poll (with live tallies) in the message list.
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crewId}/messages`, headers: { cookie: sam.cookie } });
    const { messages } = messagesRes.json() as { messages: { id: string; poll: { counts: Record<string, number> } | null }[] };
    const pollMessage = messages.find((m) => m.id === message.id);
    expect(pollMessage?.poll?.counts['Food festival']).toBe(2);
  });

  test('a manual (non-ticketed) Plan can be created, shared to chat, voted on, and locked in', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/plans/manual`,
      headers: { cookie: will.cookie },
      payload: { title: 'Pub Saturday', venueName: "Katie Fitzgerald's, Stafford", startsAt: new Date(Date.now() + 86400000).toISOString() },
    });
    expect(createRes.statusCode).toBe(201);
    const { plan } = createRes.json() as { plan: { id: string; publicSlug: string; status: string; manualVenueName: string } };
    expect(plan.status).toBe('SHARED');
    expect(plan.manualVenueName).toBe("Katie Fitzgerald's, Stafford");

    // It should have posted into chat, same as a real Experience share does.
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crewId}/messages`, headers: { cookie: sam.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Pub Saturday'))).toBe(true);

    const lockRes = await app.inject({ method: 'POST', url: `/plans/${plan.id}/lock`, headers: { cookie: will.cookie } });
    expect(lockRes.statusCode).toBe(200);
    const { plan: locked } = lockRes.json() as { plan: { status: string } };
    // LOCKED, not BOOKED — a real bug this test used to bake in as "correct": Lock It In used
    // to set status straight to BOOKED, which made the booking page falsely claim a manual
    // plan (nothing to book, ever) was "✓ Booked — Added to everyone's calendar". LOCKED means
    // the Crew's decision is final; BOOKED is reserved for a real deep-link booking actually
    // being confirmed — see docs/DECISIONS.md#booking-status-split.
    expect(locked.status).toBe('LOCKED');

    // Locking should have posted a system moment into the conversation.
    const messagesAfterLock = await app.inject({ method: 'GET', url: `/crews/${crewId}/messages`, headers: { cookie: sam.cookie } });
    const { messages: afterLock } = messagesAfterLock.json() as { messages: { body: string }[] };
    expect(afterLock.some((m) => m.body.includes('locked in'))).toBe(true);

    // The manual Plan should now show up on both members' "Plans" / Home hero surface.
    const upcomingRes = await app.inject({ method: 'GET', url: '/plans/upcoming', headers: { cookie: sam.cookie } });
    const { plans } = upcomingRes.json() as { plans: { publicSlug: string; venueName: string | null }[] };
    expect(plans.some((p) => p.publicSlug === plan.publicSlug && p.venueName === "Katie Fitzgerald's, Stafford")).toBe(true);
  });

  test('a non-member cannot lock a Plan in a Crew they are not in', async () => {
    const outsider = await loginByEmail('outsider-v2@plot-test.invalid');
    const createRes = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/plans/manual`,
      headers: { cookie: will.cookie },
      payload: { title: 'Sunday walk' },
    });
    const { plan } = createRes.json() as { plan: { id: string } };

    const res = await app.inject({ method: 'POST', url: `/plans/${plan.id}/lock`, headers: { cookie: outsider.cookie } });
    expect(res.statusCode).toBe(403);
  });

  test('UK place search returns real UK towns, not just London, and Stafford ranks first for "staf"', async () => {
    const res = await app.inject({ method: 'GET', url: '/locations/search?q=staf', headers: { cookie: will.cookie } });
    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: { name: string }[] };
    expect(results[0]?.name).toBe('Stafford');

    const ukRes = await app.inject({ method: 'GET', url: '/locations/search?q=manch', headers: { cookie: will.cookie } });
    const { results: ukResults } = ukRes.json() as { results: { name: string }[] };
    expect(ukResults.some((r) => r.name === 'Manchester')).toBe(true);
  });

  test('setting a home city on the profile persists and comes back from /users/me', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: will.cookie },
      payload: { displayName: 'Will', homeCity: 'Stafford', homeLat: 52.8062, homeLng: -2.1169 },
    });
    expect(res.statusCode).toBe(200);

    const meRes = await app.inject({ method: 'GET', url: '/users/me', headers: { cookie: will.cookie } });
    const { user } = meRes.json() as { user: { displayName: string; profile: { homeCity: string } } };
    expect(user.displayName).toBe('Will');
    expect(user.profile.homeCity).toBe('Stafford');
  });

  test('Explore with no city falls back to the viewer\'s home city, not a hardcoded London', async () => {
    const res = await app.inject({ method: 'GET', url: '/explore/experiences', headers: { cookie: will.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { city: string };
    expect(body.city).toBe('Stafford');
  });
});
