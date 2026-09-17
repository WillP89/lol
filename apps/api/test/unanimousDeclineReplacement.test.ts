import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * The real, live-tested gap Cycle 9 found (docs/PILOT_READINESS_AUDIT.md): a Crew where every
 * active member votes OUT on the current recommendation is an unambiguous "this one's dead"
 * signal, but nothing reacted to it — the Crew just waited out the same 36h/weekly-cap cadence as
 * if no one had responded at all. `MIN_HOURS_AFTER_UNANIMOUS_DECLINE` (crewRecommendations.ts) is
 * the fix: a shorter, still-deliberate cadence floor that applies ONLY when every currently active
 * member has voted, and 100% of those votes are OUT. Every scenario here is one the mission brief
 * asked for by name: all PASS, mixed IN/PASS, one member never responds, weekly cap interaction.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';

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

async function setUpMember(email: string, city: { city: string; lat: number; lng: number }): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: city.city, homeLat: city.lat, homeLng: city.lng },
  });
  return member;
}

async function seedExperience(name: string, category: string, subcategories: string[], city: { city: string; lat: number; lng: number }) {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category,
      subcategories,
      venueName: `${name} Venue`,
      city: city.city,
      latitude: city.lat,
      longitude: city.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience;
}

async function sweep(crewId: string) {
  return app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId } });
}

async function explain(crewId: string) {
  const res = await app.inject({ method: 'GET', url: `/admin/crews/${crewId}/explain-recommendation`, headers: { 'x-admin-key': ADMIN_KEY } });
  return res.json() as { outcome: string; minHoursBetween?: number; unanimousDeclineOverride?: boolean; recentCount?: number; maxPerWeek?: number };
}

// Both category AND interest preferences — a category-only match tops out at matchScore 50,
// below MIN_RECOMMENDATION_SCORE (55), which starved every fixture in this suite's first draft
// regardless of cadence (a real, useful lesson: this test's own weak fixtures, not the cadence
// logic under test, which was already behaving correctly). Mirrors the interest-plus-category
// pattern crewFirstValueDerivation.test.ts's own working fixtures use.
async function setExplicitTaste(crewId: string, cookie: string, categoryPreferences: string[], interestPreferences: string[]) {
  await app.inject({
    method: 'PATCH',
    url: `/crews/${crewId}/recommendation-settings`,
    headers: { cookie },
    payload: { categoryPreferences, interestPreferences },
  });
}

async function getLatestRecommendation(crewId: string) {
  const res = await sweep(crewId);
  const body = res.json() as { recommendation: { id: string; experienceId: string; planId: string } | null };
  return body.recommendation;
}

// Setting a Crew's taste for the first time fires its own unawaited, fire-and-forget
// guaranteeFirst trigger (crewRecommendations.ts#updateSettings) — the same real background job
// the 1->2-member join trigger uses, and the same 500ms settle pattern every other test in this
// suite that exercises it uses (see crewFirstValueDerivation.test.ts /
// guaranteedFirstRecommendation.test.ts). Reading the result straight from the database avoids a
// genuine race between that background trigger and a second, explicit sweep call landing at
// nearly the same instant — whichever wins delivers the real recommendation; the loser correctly
// sees `too_soon` a moment later, which is real cadence protection working, not a bug, but not
// what THIS helper needs to observe.
async function firstRecommendationFromBackgroundTrigger(crewId: string) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return prisma.crewRecommendation.findFirst({ where: { crewId }, orderBy: { createdAt: 'desc' } });
}

async function votePlan(planId: string, cookie: string, vote: 'in' | 'maybe' | 'out') {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  const res = await app.inject({ method: 'POST', url: `/plans/public/${plan.publicSlug}/vote`, headers: { cookie }, payload: { vote } });
  expect(res.statusCode).toBe(200);
}

async function backdateRecommendation(recommendationId: string, hoursAgo: number) {
  await prisma.crewRecommendation.update({ where: { id: recommendationId }, data: { createdAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) } });
}

describe('Unanimous-decline early replacement', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('all PASS (both members vote out): the Crew becomes eligible for a replacement well before the normal 36h floor', async () => {
    const city = { city: 'Decline City', lat: 51.2, lng: -0.5 };
    const owner = await setUpMember('decline-owner@plot-test.invalid', city);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Decline Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    const mate = await setUpMember('decline-mate@plot-test.invalid', city);
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await seedExperience('First Pick Gig', 'LIVE_MUSIC', ['rock'], city);
    await setExplicitTaste(crew.id, owner.cookie, ['LIVE_MUSIC'], ['rock']);
    const first = await firstRecommendationFromBackgroundTrigger(crew.id);
    expect(first).not.toBeNull();

    // Both active members vote OUT ("Can't make it") — a genuine unanimous decline.
    await votePlan(first!.planId!, owner.cookie, 'out');
    await votePlan(first!.planId!, mate.cookie, 'out');

    // 10h later: past MIN_HOURS_AFTER_UNANIMOUS_DECLINE (8h) but well short of the normal 36h floor.
    await backdateRecommendation(first!.id, 10);

    const explainBefore = await explain(crew.id);
    expect(explainBefore.outcome).not.toBe('too_soon'); // the shorter floor has already passed

    await seedExperience('Replacement Gig', 'LIVE_MUSIC', ['rock'], city);
    const replacement = await getLatestRecommendation(crew.id);
    expect(replacement).not.toBeNull();
    expect(replacement!.experienceId).not.toBe(first!.experienceId); // genuinely different, never a near-duplicate of the declined one
  });

  test('mixed IN/PASS is not unanimous: normal 36h cadence still applies, not the shorter floor', async () => {
    const city = { city: 'Mixed City', lat: 51.3, lng: -0.4 };
    const owner = await setUpMember('mixed-owner@plot-test.invalid', city);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Mixed Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    const mate = await setUpMember('mixed-mate@plot-test.invalid', city);
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await seedExperience('Mixed Pick Gig', 'LIVE_MUSIC', ['rock'], city);
    await setExplicitTaste(crew.id, owner.cookie, ['LIVE_MUSIC'], ['rock']);
    const first = await firstRecommendationFromBackgroundTrigger(crew.id);
    expect(first).not.toBeNull();

    await votePlan(first!.planId!, owner.cookie, 'in');
    await votePlan(first!.planId!, mate.cookie, 'out');

    await backdateRecommendation(first!.id, 10); // past the 8h override, still short of 36h

    const explainResult = await explain(crew.id);
    expect(explainResult.outcome).toBe('too_soon');
    expect(explainResult.unanimousDeclineOverride).toBe(false);
    expect(explainResult.minHoursBetween).toBe(36);
  });

  test('one member never responds: not unanimous, normal 36h cadence still applies', async () => {
    const city = { city: 'Silent City', lat: 51.4, lng: -0.3 };
    const owner = await setUpMember('silent-owner@plot-test.invalid', city);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Silent Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    const mate = await setUpMember('silent-mate@plot-test.invalid', city);
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await seedExperience('Silent Pick Gig', 'LIVE_MUSIC', ['rock'], city);
    await setExplicitTaste(crew.id, owner.cookie, ['LIVE_MUSIC'], ['rock']);
    const first = await firstRecommendationFromBackgroundTrigger(crew.id);
    expect(first).not.toBeNull();

    // Only the owner responds — the mate never votes at all.
    await votePlan(first!.planId!, owner.cookie, 'out');

    await backdateRecommendation(first!.id, 10);

    const explainResult = await explain(crew.id);
    expect(explainResult.outcome).toBe('too_soon');
    expect(explainResult.unanimousDeclineOverride).toBe(false); // silence is not rejection
    expect(explainResult.minHoursBetween).toBe(36);
  });

  test('weekly cap is still respected after a unanimous decline — the shorter floor never bypasses it', async () => {
    const city = { city: 'Capped City', lat: 51.5, lng: -0.2 };
    const owner = await setUpMember('capped-owner@plot-test.invalid', city);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Capped Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    const mate = await setUpMember('capped-mate@plot-test.invalid', city);
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await seedExperience('Cap Pick 1', 'LIVE_MUSIC', ['rock'], city);
    await setExplicitTaste(crew.id, owner.cookie, ['LIVE_MUSIC'], ['rock']);
    const rec1 = await firstRecommendationFromBackgroundTrigger(crew.id);
    expect(rec1).not.toBeNull();
    await votePlan(rec1!.planId!, owner.cookie, 'out');
    await votePlan(rec1!.planId!, mate.cookie, 'out');
    await backdateRecommendation(rec1!.id, 10);

    await seedExperience('Cap Pick 2', 'LIVE_MUSIC', ['rock'], city);
    const rec2 = await getLatestRecommendation(crew.id);
    expect(rec2).not.toBeNull();
    expect(rec2!.id).not.toBe(rec1!.id);
    await votePlan(rec2!.planId, owner.cookie, 'out');
    await votePlan(rec2!.planId, mate.cookie, 'out');
    await backdateRecommendation(rec2!.id, 10);

    await seedExperience('Cap Pick 3', 'LIVE_MUSIC', ['rock'], city);
    const rec3 = await getLatestRecommendation(crew.id);
    expect(rec3).not.toBeNull();
    expect(rec3!.id).not.toBe(rec2!.id);
    await votePlan(rec3!.planId, owner.cookie, 'out');
    await votePlan(rec3!.planId, mate.cookie, 'out');
    await backdateRecommendation(rec3!.id, 10);

    // maxPerWeek defaults to 3 — a 4th attempt this week must be blocked by the weekly cap,
    // even though the most recent recommendation was itself unanimously declined 10h ago.
    await seedExperience('Cap Pick 4', 'LIVE_MUSIC', ['rock'], city);
    const explainResult = await explain(crew.id);
    expect(explainResult.outcome).toBe('weekly_cap_reached');
    expect(explainResult.recentCount).toBe(3);
    expect(explainResult.maxPerWeek).toBe(3);

    const rec4 = await getLatestRecommendation(crew.id);
    expect(rec4).toBeNull();
  });
});
