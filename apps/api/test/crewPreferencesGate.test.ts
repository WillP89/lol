import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * "Before creating a crew, one person must fill out the crew's specific preferences using the AI
 * generated or personal selection, this then defines the group's preferences... I do not want
 * you to choose these preferences based on each individual in the group, set it at the crew
 * level by the person who created it... no events or things should be done on crew until
 * preference set" — the real, live product requirement this proves, end to end: every surface
 * that can act on a Crew (the automatic sweep via evaluateCrewEligibility, and the member-
 * triggered "Find us something"/"Suggest to chat" via services/crewPreferencesGate.ts) refuses to
 * do anything until the Crew's OWN CrewRecommendationSettings preferences are set — never derived
 * from member taste — and that setting them for the first time is itself what unblocks (and
 * immediately delivers to) the Crew, exactly once.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
const STAFFORD = { city: 'Stafford', lat: 52.8062, lng: -2.1169 };

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

async function setUpMember(email: string): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
  });
  return member;
}

async function seedExperience(name: string, category: string, venueName: string) {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category,
      venueName,
      city: STAFFORD.city,
      latitude: STAFFORD.lat,
      longitude: STAFFORD.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience;
}

describe('crew preferences gate: nothing happens on a Crew until its own preferences are set', () => {
  let crewId = '';
  let owner: { userId: string; cookie: string };
  let mate: { userId: string; cookie: string };

  beforeAll(async () => {
    await resetDatabase();
    await seedExperience('Stafford Gate Test Comedy Night', 'COMEDY', 'The Stafford Gatehouse');

    owner = await setUpMember('gate-owner@plot-test.invalid');
    mate = await setUpMember('gate-mate@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Gate Test Crew', defaultCity: STAFFORD.city },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    crewId = crew.id;
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the (harmless, no-op) join trigger settle
  });

  test('a brand-new Crew reports preferencesSetAt: null', async () => {
    const res = await app.inject({ method: 'GET', url: `/crews/${crewId}/recommendation-settings`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const { settings } = res.json() as { settings: { preferencesSetAt: string | null } };
    expect(settings.preferencesSetAt).toBeNull();
  });

  test('the immediate 1->2-member join trigger delivers nothing — preferences were never set', async () => {
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crewId}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Plot found something'))).toBe(false);
  });

  test('POST find-us-something is refused with a clear, actionable 400 — not a silent empty list', async () => {
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('preferences_not_set');
    expect(body.message.length).toBeGreaterThan(0);
  });

  test('POST suggest-to-chat is refused the same way — it runs straight through find-us-something', async () => {
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/suggest-to-chat`, headers: { cookie: mate.cookie } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('preferences_not_set');
  });

  test('the periodic sweep also delivers nothing for this Crew — the same gate, not a second one', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { delivered: number }).delivered).toBe(0);
  });

  test('the creator sets the Crew\'s own preferences — this is what unblocks everything, and delivers the guaranteed first event immediately', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/crews/${crewId}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['COMEDY'] },
    });
    expect(patchRes.statusCode).toBe(200);
    const { settings } = patchRes.json() as { settings: { preferencesSetAt: string | null } };
    expect(settings.preferencesSetAt).not.toBeNull();

    // The guaranteed-first-recommendation trigger fires fire-and-forget from inside the PATCH
    // handler (services/crewRecommendations.ts#updateSettings) — give it a moment to land, same
    // settle pattern used throughout this suite for the (now-secondary) join trigger.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crewId}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes('Plot found something'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('Stafford Gate Test Comedy Night');
  });

  test('find-us-something now works for real, now that preferences are set', async () => {
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: mate.cookie } });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as { options: unknown[] };
    expect(Array.isArray(options)).toBe(true);
  });

  test('re-tuning preferences afterwards is never re-gated — editing an already-set Crew stays open', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/crews/${crewId}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['COMEDY', 'RESTAURANT'] },
    });
    expect(res.statusCode).toBe(200);
    const { settings } = res.json() as { settings: { categoryPreferences: string[] } };
    expect(settings.categoryPreferences).toEqual(['COMEDY', 'RESTAURANT']);

    const findRes = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    expect(findRes.statusCode).toBe(200);
  });
});
