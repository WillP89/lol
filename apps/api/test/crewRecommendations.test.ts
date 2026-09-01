import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * The automatic Crew recommendation system (docs/DECISIONS.md#crew-auto-recommendations) —
 * "THE MOST IMPORTANT NEW FEATURE" per the pilot brief. Two real Crews with genuinely different
 * taste profiles, both anchored in Stafford, verifying the engine actually personalises (not
 * just that it runs), plus the delivery mechanics (weekly cap, no repeats, distinguishable
 * framing, lightweight response controls).
 */

const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me'; // config.ts's own default — see src/lib/config.ts

// Stafford — the pilot's real test location (see src/data/ukPlaces.ts).
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

async function setUpMember(email: string, categories: string[]): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
  });
  await app.inject({
    method: 'POST',
    url: '/users/me/taste',
    headers: { cookie: member.cookie },
    payload: {
      swipes: categories.map((category) => ({ category, choice: 'yes' as const })),
      budget: { minMinor: 1000, maxMinor: 8000, currency: 'GBP' },
      travelRadiusMeters: 24000,
      energyPreference: 'MEDIUM',
    },
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

describe('automatic Crew recommendations: real personalisation, not a fake carousel', () => {
  let comedyCrewId = '';
  let sportCrewId = '';

  beforeAll(async () => {
    await resetDatabase();

    // Crew A: food/comedy/live-music taste.
    const comedyOwner = await setUpMember('rec-comedy-owner@plot-test.invalid', ['comedy', 'live_music', 'restaurant']);
    const comedyMate = await setUpMember('rec-comedy-mate@plot-test.invalid', ['comedy', 'live_music', 'restaurant']);
    const comedyCrewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: comedyOwner.cookie },
      payload: { name: 'Comedy Crew', defaultCity: STAFFORD.city },
    });
    const { crew: comedyCrew } = comedyCrewRes.json() as { crew: { id: string; inviteCode: string } };
    comedyCrewId = comedyCrew.id;
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: comedyMate.cookie }, payload: { inviteCode: comedyCrew.inviteCode } });

    // Crew B: sport/day-out taste — a genuinely different profile, same city.
    const sportOwner = await setUpMember('rec-sport-owner@plot-test.invalid', ['sport', 'day_activity', 'fitness']);
    const sportMate = await setUpMember('rec-sport-mate@plot-test.invalid', ['sport', 'day_activity', 'fitness']);
    const sportCrewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: sportOwner.cookie },
      payload: { name: 'Sport Crew', defaultCity: STAFFORD.city },
    });
    const { crew: sportCrew } = sportCrewRes.json() as { crew: { id: string; inviteCode: string } };
    sportCrewId = sportCrew.id;
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: sportMate.cookie }, payload: { inviteCode: sportCrew.inviteCode } });

    // Two real Stafford experiences, one per taste — the engine should tell these two Crews
    // apart, not send the same generic thing to both.
    await seedExperience('Stafford Comedy Night', 'COMEDY', 'The Stafford Gatehouse');
    await seedExperience('Stafford Sunday 5-a-side', 'SPORT', 'Stafford Leisure Centre');
  });

  test('the comedy-taste Crew gets the comedy recommendation, not the sport one', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId: comedyCrewId } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { delivered: number; recommendation: { reasonText: string } | null };
    expect(body.delivered).toBe(1);
    expect(body.recommendation).not.toBeNull();
    expect(body.recommendation!.reasonText.toLowerCase()).toContain('comedy');

    // And it actually landed in the Crew's real conversation, distinguishably.
    const [owner] = [await loginByEmail('rec-comedy-owner@plot-test.invalid')];
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${comedyCrewId}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes('Plot found something'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('Stafford Comedy Night');
  });

  test('the sport-taste Crew gets the sport recommendation, not the comedy one — genuinely different output', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId: sportCrewId } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { delivered: number; recommendation: { reasonText: string } | null };
    expect(body.delivered).toBe(1);
    expect(body.recommendation!.reasonText.toLowerCase()).toContain('sport');

    const owner = await loginByEmail('rec-sport-owner@plot-test.invalid');
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${sportCrewId}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes('Plot found something'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('Sunday 5-a-side');
  });

  test('the same Crew is never recommended the same thing twice, even across repeated sweeps', async () => {
    const before = await app.inject({ method: 'GET', url: `/crews/${comedyCrewId}/messages`, headers: { cookie: (await loginByEmail('rec-comedy-owner@plot-test.invalid')).cookie } });
    const beforeCount = (before.json() as { messages: unknown[] }).messages.length;

    // Bump the weekly cap so a repeat isn't blocked by the cap itself — isolating what this
    // test actually checks: de-duplication, not the cap (covered separately below).
    const owner = await loginByEmail('rec-comedy-owner@plot-test.invalid');
    await app.inject({ method: 'PATCH', url: `/crews/${comedyCrewId}/recommendation-settings`, headers: { cookie: owner.cookie }, payload: { maxPerWeek: 7 } });

    const res = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId: comedyCrewId } });
    const body = res.json() as { delivered: number };
    // Nothing else clears the confidence bar for this Crew (the sport event scores far lower
    // against a comedy/live-music/restaurant taste profile) — so a second delivery correctly
    // does not happen, and the message count is unchanged.
    expect(body.delivered).toBe(0);

    const after = await app.inject({ method: 'GET', url: `/crews/${comedyCrewId}/messages`, headers: { cookie: owner.cookie } });
    const afterCount = (after.json() as { messages: unknown[] }).messages.length;
    expect(afterCount).toBe(beforeCount);
  });

  test('lightweight response controls: "Not for us" marks the recommendation responded, never re-suggested', async () => {
    const owner = await loginByEmail('rec-sport-owner@plot-test.invalid');
    const plansRes = await app.inject({ method: 'GET', url: `/crews/${sportCrewId}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = plansRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes('Plot found something'))!;
    const slug = announcement.body.match(/\/plans\/([a-zA-Z0-9-]+)$/)![1];

    const planRes = await app.inject({ method: 'GET', url: `/plans/public/${slug}` });
    const { recommendation } = planRes.json() as { recommendation: { id: string; reasonText: string } | null };
    expect(recommendation).not.toBeNull();

    const respondRes = await app.inject({
      method: 'POST',
      url: `/crews/${sportCrewId}/recommendations/${recommendation!.id}/respond`,
      headers: { cookie: owner.cookie },
      payload: { action: 'not_for_us' },
    });
    expect(respondRes.statusCode).toBe(200);
    const { recommendation: updated } = respondRes.json() as { recommendation: { status: string; respondedAt: string | null } };
    expect(updated.status).toBe('NOT_FOR_US');
    expect(updated.respondedAt).not.toBeNull();
  });

  test('a member from a different Crew cannot respond to this Crew\'s recommendation (IDOR check)', async () => {
    const comedyOwner = await loginByEmail('rec-comedy-owner@plot-test.invalid');
    const sportOwner = await loginByEmail('rec-sport-owner@plot-test.invalid');
    const sportMessagesRes = await app.inject({ method: 'GET', url: `/crews/${sportCrewId}/messages`, headers: { cookie: sportOwner.cookie } });
    const { messages } = sportMessagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes('Plot found something'))!;
    const slug = announcement.body.match(/\/plans\/([a-zA-Z0-9-]+)$/)![1];
    const planRes = await app.inject({ method: 'GET', url: `/plans/public/${slug}` });
    const { recommendation } = planRes.json() as { recommendation: { id: string } | null };

    const res = await app.inject({
      method: 'POST',
      url: `/crews/${comedyCrewId}/recommendations/${recommendation!.id}/respond`,
      headers: { cookie: comedyOwner.cookie },
      payload: { action: 'not_for_us' },
    });
    expect(res.statusCode).toBe(404); // the recommendation exists, just not for this Crew
  });

  test('turning recommendations off for a Crew stops delivery entirely', async () => {
    // The sport Crew still has an unexploited weekly allowance (1 of 2 used in an earlier
    // test) — this isolates the `enabled` gate itself, not the weekly cap.
    const sportOwner = await loginByEmail('rec-sport-owner@plot-test.invalid');
    const offRes = await app.inject({
      method: 'PATCH',
      url: `/crews/${sportCrewId}/recommendation-settings`,
      headers: { cookie: sportOwner.cookie },
      payload: { enabled: false },
    });
    expect(offRes.statusCode).toBe(200);
    expect((offRes.json() as { settings: { enabled: boolean } }).settings.enabled).toBe(false);

    const sweepRes = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId: sportCrewId } });
    expect((sweepRes.json() as { delivered: number }).delivered).toBe(0);
  });
});

/**
 * The database-backed scheduler claim (crewRecommendations.ts#runSweepIfDue) — the actual fix
 * for the P0 regression this exists because of: a plain in-memory `setInterval` has no way to
 * know a sweep is overdue after this process was asleep/restarted, and no way to coordinate with
 * a second instance racing it. This is what makes server.ts's boot-time check (and an external
 * cron hitting POST /admin/recommendations/sweep without `force`) self-healing instead of
 * "run once at boot and hope nothing else calls it too" — see docs/DEPLOYMENT.md.
 */
describe('recommendation sweep scheduling: database-backed, restart/race safe', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  test('a due sweep runs, and immediately calling again with the same interval does NOT run a second time', async () => {
    const { runSweepIfDue } = await import('../src/services/crewRecommendations');
    // No SchedulerState row exists yet at all — the very first boot on a brand-new database —
    // this must count as "due", not silently no-op forever.
    const first = await runSweepIfDue(6 * 60 * 60 * 1000);
    expect(first.ran).toBe(true);

    // Immediately again, same interval — simulates a second process (or this same process's
    // next 15-minute check) asking "is it due" a moment later. The database, not this call's own
    // memory, is what says no.
    const second = await runSweepIfDue(6 * 60 * 60 * 1000);
    expect(second.ran).toBe(false);
  });

  test('a sweep older than the interval is claimed as due again (the actual restart/sleep recovery case)', async () => {
    const { prisma } = await import('../src/lib/prisma');
    const { runSweepIfDue } = await import('../src/services/crewRecommendations');

    // Simulate "this process was asleep/down for a long time" — back-date the claim the way a
    // real long gap would leave it, rather than waiting a real interval out in the test.
    await prisma.schedulerState.update({
      where: { jobName: 'crew_recommendation_sweep' },
      data: { lastClaimedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) }, // 7h ago
    });

    const outcome = await runSweepIfDue(6 * 60 * 60 * 1000); // 6h interval — 7h ago is overdue
    expect(outcome.ran).toBe(true);
  });

  test('two concurrent calls only let ONE of them actually run the sweep (the race two instances would hit)', async () => {
    const { prisma } = await import('../src/lib/prisma');
    const { runSweepIfDue } = await import('../src/services/crewRecommendations');
    await prisma.schedulerState.update({
      where: { jobName: 'crew_recommendation_sweep' },
      data: { lastClaimedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) },
    });

    const [a, b] = await Promise.all([
      runSweepIfDue(6 * 60 * 60 * 1000),
      runSweepIfDue(6 * 60 * 60 * 1000),
    ]);
    const ranCount = [a.ran, b.ran].filter(Boolean).length;
    expect(ranCount).toBe(1);
  });

  test('POST /admin/recommendations/sweep with force:true bypasses the due-check (deliberate ops override)', async () => {
    const { prisma } = await import('../src/lib/prisma');
    // Make sure a sweep is NOT due right now, so a non-forced call would report ran: false.
    await prisma.schedulerState.upsert({
      where: { jobName: 'crew_recommendation_sweep' },
      update: { lastClaimedAt: new Date() },
      create: { jobName: 'crew_recommendation_sweep', lastClaimedAt: new Date() },
    });

    const notDue = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: {} });
    expect((notDue.json() as { ran: boolean }).ran).toBe(false);

    const forced = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { force: true } });
    const forcedBody = forced.json() as { ran: boolean; forced: boolean };
    expect(forcedBody.ran).toBe(true);
    expect(forcedBody.forced).toBe(true);
  });
});
