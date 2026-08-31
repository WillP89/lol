import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { syncAllProviders } from '../src/services/inventorySync';
import { config } from '../src/lib/config';

/**
 * The one test that must never break (brief §60 "the pilot must not break during the one
 * workflow we exist to solve"): signup -> create Crew -> invite -> Find Us Something ->
 * send to Crew -> votes -> Plan Pulse -> booking -> completion -> Rewind. Runs against the
 * real plot_test Postgres database (see test/setup.ts), not mocks — this is deliberately an
 * integration test, not a unit test with a fake Prisma client, because the thing most likely
 * to break this product is a wrong assumption at a component boundary, and mocking those
 * boundaries out is exactly how you stop catching that.
 */

const app = buildApp();

async function loginByEmail(email: string): Promise<{ userId: string; cookie: string }> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  expect(magicLinkRes.statusCode).toBe(200);
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');

  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  expect(callbackRes.statusCode).toBe(200);
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');

  const { user } = callbackRes.json() as { user: { id: string } };
  return { userId: user.id, cookie: `${cookie.name}=${cookie.value}` };
}

describe('golden path: signup through Rewind', () => {
  const members = ['alex', 'sam', 'jack', 'charlie', 'tom', 'ben'].map((name) => ({
    name,
    email: `${name}@plot-test.invalid`,
  }));
  const sessions: Record<string, { userId: string; cookie: string }> = {};
  let crewId = '';
  let inviteCode = '';
  let planId = '';
  let planSlug = '';
  let bookingId = '';

  beforeAll(async () => {
    await resetDatabase();
    // Seed real inventory through the real provider pipeline — not hand-inserted rows — so
    // this test also exercises fetch -> map -> dedup -> quality-score -> upsert end to end.
    const syncResults = await syncAllProviders('London');
    expect(syncResults.some((r) => r.upserted > 0)).toBe(true);
  });

  test('every member signs up via magic link', async () => {
    for (const member of members) {
      sessions[member.name] = await loginByEmail(member.email);
      expect(sessions[member.name].userId).toBeTruthy();
    }
  });

  test('Alex builds a taste profile favouring live music and clubbing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/taste',
      headers: { cookie: sessions.alex.cookie },
      payload: {
        swipes: [
          { category: 'live_music', choice: 'yes' },
          { category: 'clubbing', choice: 'yes' },
          { category: 'comedy', choice: 'maybe' },
          { category: 'restaurant', choice: 'yes' },
        ],
        budget: { minMinor: 2000, maxMinor: 6000, currency: 'GBP' },
        travelRadiusMeters: 8000,
        energyPreference: 'HIGH',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  test('Alex creates "The Boys" and everyone else joins', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: sessions.alex.cookie },
      payload: { name: 'The Boys', defaultCity: 'London' },
    });
    expect(createRes.statusCode).toBe(201);
    const { crew } = createRes.json() as { crew: { id: string; inviteCode: string } };
    crewId = crew.id;
    inviteCode = crew.inviteCode;

    for (const member of members.filter((m) => m.name !== 'alex')) {
      const joinRes = await app.inject({
        method: 'POST',
        url: '/crews/join',
        headers: { cookie: sessions[member.name].cookie },
        payload: { inviteCode },
      });
      expect(joinRes.statusCode).toBe(200);
    }

    const listRes = await app.inject({ method: 'GET', url: '/crews', headers: { cookie: sessions.alex.cookie } });
    const { crews } = listRes.json() as { crews: { members: unknown[] }[] };
    expect(crews[0].members).toHaveLength(6);
  });

  test('Crew chat: members can post and read messages, polling picks up only what is new', async () => {
    const post = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages`,
      headers: { cookie: sessions.alex.cookie },
      payload: { body: 'anyone free Saturday?' },
    });
    expect(post.statusCode).toBe(201);
    const { message: first } = post.json() as { message: { id: string; body: string; author: { id: string } } };
    expect(first.body).toBe('anyone free Saturday?');
    expect(first.author.id).toBe(sessions.alex.userId);

    const reply = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages`,
      headers: { cookie: sessions.sam.cookie },
      payload: { body: 'I am!' },
    });
    expect(reply.statusCode).toBe(201);

    const listRes = await app.inject({
      method: 'GET',
      url: `/crews/${crewId}/messages`,
      headers: { cookie: sessions.ben.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const { messages } = listRes.json() as { messages: { id: string; body: string }[] };
    expect(messages.map((m) => m.body)).toEqual(['anyone free Saturday?', 'I am!']);

    // Polling with `after` the first message's id returns only what came after it.
    const polled = await app.inject({
      method: 'GET',
      url: `/crews/${crewId}/messages?after=${first.id}`,
      headers: { cookie: sessions.ben.cookie },
    });
    const { messages: newOnly } = polled.json() as { messages: { body: string }[] };
    expect(newOnly.map((m) => m.body)).toEqual(['I am!']);

    const outsider = await loginByEmail('not-in-the-crew@plot-test.invalid');
    const forbidden = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages`,
      headers: { cookie: outsider.cookie },
      payload: { body: 'let me in' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  test('Message reactions: toggle on, aggregate across members, toggle off, switch emoji', async () => {
    const post = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages`,
      headers: { cookie: sessions.alex.cookie },
      payload: { body: 'reaction test message' },
    });
    const { message } = post.json() as { message: { id: string } };

    const samReact = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages/${message.id}/react`,
      headers: { cookie: sessions.sam.cookie },
      payload: { emoji: '👍' },
    });
    expect(samReact.statusCode).toBe(200);
    expect(samReact.json()).toEqual({ reactions: [{ emoji: '👍', count: 1, reactedByMe: true, reactedBy: [sessions.sam.userId] }] });

    const benReact = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages/${message.id}/react`,
      headers: { cookie: sessions.ben.cookie },
      payload: { emoji: '👍' },
    });
    // reactedBy carries the actual named people behind the tally (see docs/DECISIONS.md#in-
    // maybe-pass-who) — order isn't guaranteed, so this checks membership, not array identity.
    const benReactBody = benReact.json() as { reactions: { emoji: string; count: number; reactedByMe: boolean; reactedBy: string[] }[] };
    expect(benReactBody.reactions).toEqual([{ emoji: '👍', count: 2, reactedByMe: true, reactedBy: expect.arrayContaining([sessions.sam.userId, sessions.ben.userId]) }]);

    // A third viewer (Alex, who hasn't reacted) sees the same aggregate count but
    // reactedByMe: false — the flag is per-viewer, not baked into the message.
    const listAsAlex = await app.inject({ method: 'GET', url: `/crews/${crewId}/messages`, headers: { cookie: sessions.alex.cookie } });
    const { messages } = listAsAlex.json() as { messages: { id: string; reactions: { emoji: string; count: number; reactedByMe: boolean; reactedBy: string[] }[] }[] };
    const seen = messages.find((m) => m.id === message.id)!;
    expect(seen.reactions).toEqual([{ emoji: '👍', count: 2, reactedByMe: false, reactedBy: expect.arrayContaining([sessions.sam.userId, sessions.ben.userId]) }]);

    // Sam taps the same emoji again — toggles their own reaction off.
    const samToggleOff = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages/${message.id}/react`,
      headers: { cookie: sessions.sam.cookie },
      payload: { emoji: '👍' },
    });
    expect(samToggleOff.json()).toEqual({ reactions: [{ emoji: '👍', count: 1, reactedByMe: false, reactedBy: [sessions.ben.userId] }] });

    // Ben switches to a different emoji — one reaction per user, not accumulating.
    const benSwitch = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages/${message.id}/react`,
      headers: { cookie: sessions.ben.cookie },
      payload: { emoji: '❤️' },
    });
    expect(benSwitch.json()).toEqual({ reactions: [{ emoji: '❤️', count: 1, reactedByMe: true, reactedBy: [sessions.ben.userId] }] });

    const invalidEmoji = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/messages/${message.id}/react`,
      headers: { cookie: sessions.alex.cookie },
      payload: { emoji: '🍕🍕🍕🍕🍕' },
    });
    expect(invalidEmoji.statusCode).toBe(400);
  });

  test('Ben marks himself busy for the event window; everyone else is implicitly free', async () => {
    const start = new Date();
    start.setDate(start.getDate() + 5);
    start.setHours(19, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 0, 0);

    const res = await app.inject({
      method: 'POST',
      url: '/users/me/availability',
      headers: { cookie: sessions.ben.cookie },
      payload: { windows: [{ startsAt: start.toISOString(), endsAt: end.toISOString(), busy: true }], source: 'MANUAL' },
    });
    expect(res.statusCode).toBe(200);
  });

  test('Find Us Something returns three explainable, ranked options', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/find-us-something`,
      headers: { cookie: sessions.alex.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as { options: { matchScore: number; reasons: unknown[] }[] };
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThanOrEqual(3);
    // Ranked descending by match score.
    for (let i = 1; i < options.length; i++) {
      expect(options[i - 1].matchScore).toBeGreaterThanOrEqual(options[i].matchScore);
    }
  });

  test('Alex sends the top option to the Crew, creating a Plan', async () => {
    const findRes = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/find-us-something`,
      headers: { cookie: sessions.alex.cookie },
    });
    const { options } = findRes.json() as { options: { experience: { id: string } }[] };

    // Fetch the recommendation option id from the DB-shaped response (the route returns
    // MatchOption[], which doesn't include the PlanRecommendationOption id directly — plan
    // creation goes through the experience id via the direct-send path instead, which is
    // exactly the "individual send" code path the Plan Card growth mechanic also uses).
    const planRes = await app.inject({
      method: 'POST',
      url: `/crews/${crewId}/plans/send`,
      headers: { cookie: sessions.alex.cookie },
      payload: { experienceId: options[0].experience.id },
    });
    expect(planRes.statusCode).toBe(201);
    const { plan } = planRes.json() as { plan: { id: string; publicSlug: string; status: string } };
    planId = plan.id;
    planSlug = plan.publicSlug;
    expect(plan.status).toBe('SHARED');
  });

  test('sending the Plan also announces it in Crew chat, with a tappable plan link', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/crews/${crewId}/messages`,
      headers: { cookie: sessions.ben.cookie },
    });
    const { messages } = res.json() as { messages: { body: string; author: { id: string } }[] };
    const announcement = messages.find((m) => m.body.includes(`/plans/${planSlug}`));
    expect(announcement).toBeTruthy();
    expect(announcement!.author.id).toBe(sessions.alex.userId);
  });

  test('GET /crews flags iVoted per-member, not per-Crew — the "needs your attention" signal', async () => {
    // Nobody has voted on the freshly-sent Plan yet.
    const beforeRes = await app.inject({ method: 'GET', url: '/crews', headers: { cookie: sessions.sam.cookie } });
    const before = (beforeRes.json() as { crews: { id: string; activePlan: { iVoted: boolean } | null }[] }).crews.find((c) => c.id === crewId);
    expect(before?.activePlan?.iVoted).toBe(false);

    const voteRes = await app.inject({
      method: 'POST',
      url: `/plans/public/${planSlug}/vote`,
      headers: { cookie: sessions.sam.cookie },
      payload: { vote: 'in' },
    });
    expect(voteRes.statusCode).toBe(200);

    // Sam voted — Sam's iVoted flips true, but Jack (who hasn't voted) still sees false on
    // the exact same Plan, proving this is scoped to the requesting user, not the Crew.
    const afterSamRes = await app.inject({ method: 'GET', url: '/crews', headers: { cookie: sessions.sam.cookie } });
    const afterSam = (afterSamRes.json() as { crews: { id: string; activePlan: { iVoted: boolean } | null }[] }).crews.find((c) => c.id === crewId);
    expect(afterSam?.activePlan?.iVoted).toBe(true);

    const afterJackRes = await app.inject({ method: 'GET', url: '/crews', headers: { cookie: sessions.jack.cookie } });
    const afterJack = (afterJackRes.json() as { crews: { id: string; activePlan: { iVoted: boolean } | null }[] }).crews.find((c) => c.id === crewId);
    expect(afterJack?.activePlan?.iVoted).toBe(false);
  });

  test('the Plan Card is publicly viewable without auth', async () => {
    const res = await app.inject({ method: 'GET', url: `/plans/public/${planSlug}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plan: { title: string }; pulse: { totalMembers: number } };
    expect(body.plan.title).toBeTruthy();
    expect(body.pulse.totalMembers).toBe(6);
  });

  test('votes arrive and Plan Pulse crosses the READY threshold', async () => {
    const inVoters = ['alex', 'sam', 'jack', 'tom', 'charlie'];
    let lastPulse;
    for (const name of inVoters) {
      const res = await app.inject({
        method: 'POST',
        url: `/plans/public/${planSlug}/vote`,
        headers: { cookie: sessions[name].cookie },
        payload: { vote: 'in' },
      });
      expect(res.statusCode).toBe(200);
      lastPulse = (res.json() as { pulse: { level: number; status: string } }).pulse;
    }

    const benRes = await app.inject({
      method: 'POST',
      url: `/plans/public/${planSlug}/vote`,
      headers: { cookie: sessions.ben.cookie },
      payload: { vote: 'maybe' },
    });
    expect(benRes.statusCode).toBe(200);

    expect(lastPulse?.status).toBe('READY');
    expect(lastPulse?.level).toBeCloseTo(5 / 6, 5);
  });

  test('an unauthenticated respondent can vote by email alone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/plans/public/${planSlug}/vote`,
      payload: { vote: 'maybe', email: 'friend-of-a-friend@plot-test.invalid' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { devMagicLinkUrl?: string };
    // A magic link is issued so they CAN convert — but the vote above already succeeded
    // without them ever using it.
    expect(body.devMagicLinkUrl).toBeTruthy();
  });

  test('the plan is booked for the crew (deep-link model)', async () => {
    const participantUserIds = ['alex', 'sam', 'jack', 'tom', 'charlie'].map((n) => sessions[n].userId);
    const startRes = await app.inject({
      method: 'POST',
      url: `/plans/${planId}/bookings`,
      headers: { cookie: sessions.alex.cookie },
      payload: { participantUserIds },
    });
    expect(startRes.statusCode).toBe(201);
    const { bookingId: id, externalUrl } = startRes.json() as { bookingId: string; externalUrl: string };
    bookingId = id;
    expect(externalUrl).toMatch(/^https?:\/\//);

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/bookings/${bookingId}/confirm`,
      headers: { cookie: sessions.alex.cookie },
    });
    expect(confirmRes.statusCode).toBe(200);
  });

  test('the Home surface (GET /crews) and Crew page (GET /crews/:id) both surface the upcoming Plan and recent chat', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/crews', headers: { cookie: sessions.alex.cookie } });
    const { crews } = listRes.json() as {
      crews: {
        id: string;
        latestMessage: { body: string; authorName: string } | null;
        activePlan: { id: string } | null;
        upcomingPlan: { id: string; title: string; venueName: string | null } | null;
      }[];
    };
    const crew = crews[0];
    // Booked, not one of the still-deciding statuses — should no longer show as an open
    // decision, and should show as the upcoming Plan instead.
    expect(crew.activePlan).toBeNull();
    expect(crew.upcomingPlan?.id).toBe(planId);
    expect(crew.latestMessage?.body).toContain('/plans/');

    const detailRes = await app.inject({ method: 'GET', url: `/crews/${crewId}`, headers: { cookie: sessions.alex.cookie } });
    const { crew: detail } = detailRes.json() as { crew: { recentMessages: { body: string }[] } };
    expect(detail.recentMessages.length).toBeGreaterThan(0);
    expect(detail.recentMessages[detail.recentMessages.length - 1].body).toContain('/plans/');
  });

  test('GET /plans/upcoming surfaces the booked Plan for the standalone Plans destination', async () => {
    const res = await app.inject({ method: 'GET', url: '/plans/upcoming', headers: { cookie: sessions.alex.cookie } });
    expect(res.statusCode).toBe(200);
    const { plans } = res.json() as { plans: { id: string; crew: { id: string; name: string } }[] };
    const upcoming = plans.find((p) => p.id === planId);
    expect(upcoming).toBeTruthy();
    expect(upcoming?.crew.id).toBe(crewId);
  });

  test('the plan moves to BOOKED, then COMPLETED, and Rewind can be submitted', async () => {
    const planViewRes = await app.inject({ method: 'GET', url: `/plans/public/${planSlug}` });
    expect((planViewRes.json() as { plan: { status: string } }).plan.status).toBe('BOOKED');

    const completeRes = await app.inject({
      method: 'POST',
      url: `/plans/${planId}/complete`,
      headers: { cookie: sessions.alex.cookie },
    });
    expect(completeRes.statusCode).toBe(200);

    const rewindRes = await app.inject({
      method: 'POST',
      url: `/plans/${planId}/rewind`,
      headers: { cookie: sessions.alex.cookie },
      payload: { rating: 'love', reasons: ['great_venue'] },
    });
    expect(rewindRes.statusCode).toBe(201);
  });

  test('Crew DNA reflects the completed plan (low confidence — only one so far)', async () => {
    const res = await app.inject({ method: 'GET', url: `/crews/${crewId}`, headers: { cookie: sessions.alex.cookie } });
    const { crew } = res.json() as { crew: { dna: { confidence: string } } };
    expect(crew.dna.confidence).toBe('LOW');
  });

  test('Explore returns real, geolocated experiences for the map', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/explore/experiences?city=London',
      headers: { cookie: sessions.alex.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { experiences } = res.json() as {
      experiences: { name: string; venue: { latitude: number; longitude: number; city: string } }[];
    };
    expect(experiences.length).toBeGreaterThan(0);
    for (const experience of experiences) {
      expect(experience.venue.city).toBe('London');
      expect(typeof experience.venue.latitude).toBe('number');
      expect(typeof experience.venue.longitude).toBe('number');
    }
  });

  test('the operating dashboard reflects the whole run', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: { 'x-admin-key': config.ADMIN_API_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { users: number; crews: number; bookingsConfirmed: number; plansByStatus: Record<string, number> };
    expect(body.users).toBe(8); // 6 members + the unauthenticated email voter + the chat-test outsider
    expect(body.crews).toBe(1);
    expect(body.bookingsConfirmed).toBe(1);
    expect(body.plansByStatus.COMPLETED).toBe(1);
  });
});

describe('magic-link "next" redirect (invite-join flow)', () => {
  test('a safe relative next is embedded in the magic link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/magic-link',
      payload: { email: 'next-safe@plot-test.invalid', next: '/crews/join/abc123' },
    });
    expect(res.statusCode).toBe(200);
    const { devMagicLinkUrl } = res.json() as { devMagicLinkUrl: string };
    expect(devMagicLinkUrl).toContain(`next=${encodeURIComponent('/crews/join/abc123')}`);
  });

  test('an absolute URL in next is dropped, not embedded — open-redirect guard', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/magic-link',
      payload: { email: 'next-unsafe@plot-test.invalid', next: 'https://evil.example/phish' },
    });
    expect(res.statusCode).toBe(200);
    const { devMagicLinkUrl } = res.json() as { devMagicLinkUrl: string };
    expect(devMagicLinkUrl).not.toContain('evil.example');
    expect(devMagicLinkUrl).not.toContain('next=');
  });
});

describe('account lifecycle: sign out, deactivate, delete', () => {
  test('/users/me returns identity with createdAt for the Profile page', async () => {
    const session = await loginByEmail('profile-me@plot-test.invalid');
    const res = await app.inject({ method: 'GET', url: '/users/me', headers: { cookie: session.cookie } });
    expect(res.statusCode).toBe(200);
    const { user } = res.json() as { user: { email: string; createdAt: string } };
    expect(user.email).toBe('profile-me@plot-test.invalid');
    expect(new Date(user.createdAt).toString()).not.toBe('Invalid Date');
  });

  test('logout revokes the session and clears the cookie', async () => {
    const session = await loginByEmail('profile-logout@plot-test.invalid');

    const logoutRes = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: session.cookie } });
    expect(logoutRes.statusCode).toBe(200);
    const cleared = logoutRes.cookies.find((c) => c.name === 'plot_session');
    expect(cleared?.value).toBe('');

    const meRes = await app.inject({ method: 'GET', url: '/users/me', headers: { cookie: session.cookie } });
    expect(meRes.statusCode).toBe(401);
  });

  test('deactivate revokes the session and clears the cookie', async () => {
    const session = await loginByEmail('profile-deactivate@plot-test.invalid');

    const deactivateRes = await app.inject({ method: 'POST', url: '/users/me/deactivate', headers: { cookie: session.cookie } });
    expect(deactivateRes.statusCode).toBe(200);
    const cleared = deactivateRes.cookies.find((c) => c.name === 'plot_session');
    expect(cleared?.value).toBe('');

    const meRes = await app.inject({ method: 'GET', url: '/users/me', headers: { cookie: session.cookie } });
    expect(meRes.statusCode).toBe(401);
  });

  test('delete scrubs identifying details and revokes the session', async () => {
    const email = 'profile-delete@plot-test.invalid';
    const session = await loginByEmail(email);

    const deleteRes = await app.inject({ method: 'POST', url: '/users/me/delete', headers: { cookie: session.cookie } });
    expect(deleteRes.statusCode).toBe(200);
    const cleared = deleteRes.cookies.find((c) => c.name === 'plot_session');
    expect(cleared?.value).toBe('');

    // Logging in again with the same email creates a fresh account — the old one is gone,
    // not just hidden — because delete rewrites the email so it can never resolve again.
    const meRes = await app.inject({ method: 'GET', url: '/users/me', headers: { cookie: session.cookie } });
    expect(meRes.statusCode).toBe(401);
    const relogin = await loginByEmail(email);
    expect(relogin.userId).not.toBe(session.userId);
  });
});

describe('suggest-to-chat: the core loop puts suggestions straight into the conversation', () => {
  test('POST /crews/:id/suggest-to-chat creates Plans and posts each one into chat directly — no separate review screen', async () => {
    const owner = await loginByEmail('suggest-owner@plot-test.invalid');
    const createRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Suggest Test Crew', defaultCity: 'London' },
    });
    const { crew } = createRes.json() as { crew: { id: string } };

    const res = await app.inject({ method: 'POST', url: `/crews/${crew.id}/suggest-to-chat`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const { plans } = res.json() as { plans: { id: string; status: string }[] };
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((p) => p.status === 'SHARED')).toBe(true);

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    // One chat announcement per suggested Plan, each carrying a tappable Plan link — exactly
    // what a member would see if they'd reviewed and sent each option by hand.
    const planLinks = messages.filter((m) => m.body.includes('/plans/'));
    expect(planLinks.length).toBe(plans.length);
  });

  test('a non-member cannot trigger suggestions for a Crew they are not in', async () => {
    const outsider = await loginByEmail('suggest-outsider@plot-test.invalid');
    const owner2 = await loginByEmail('suggest-owner2@plot-test.invalid');
    const createRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner2.cookie },
      payload: { name: 'Private Suggest Crew', defaultCity: 'London' },
    });
    const { crew } = createRes.json() as { crew: { id: string } };

    const res = await app.inject({ method: 'POST', url: `/crews/${crew.id}/suggest-to-chat`, headers: { cookie: outsider.cookie } });
    expect(res.statusCode).toBe(403);
  });
});
