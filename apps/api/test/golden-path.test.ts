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

  test('the operating dashboard reflects the whole run', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: { 'x-admin-key': config.ADMIN_API_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { users: number; crews: number; bookingsConfirmed: number; plansByStatus: Record<string, number> };
    expect(body.users).toBe(7); // 6 members + the unauthenticated email voter
    expect(body.crews).toBe(1);
    expect(body.bookingsConfirmed).toBe(1);
    expect(body.plansByStatus.COMPLETED).toBe(1);
  });
});
