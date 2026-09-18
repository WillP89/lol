import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * THE Crew-E "first value" fix, proven end-to-end. See services/crewTasteDerivation.ts's own
 * header comment for the algorithm and its three safety rules. Every scenario here is one the
 * live mission brief specified verbatim: solo Crew, two genuinely aligned members, a highly
 * conflicted trio, an explicit override of a derived guess, and the full realistic acceptance
 * journey (create user -> taste -> Crew -> invite -> join -> chat -> NO manual rescue ->
 * relevant recommendation delivered with a truthful reason).
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

async function setUpMember(
  email: string,
  city: { city: string; lat: number; lng: number },
  interests: { interestId: string; strength: 'love' | 'like' | 'open' | 'not_for_me' }[],
): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: city.city, homeLat: city.lat, homeLng: city.lng },
  });
  if (interests.length > 0) {
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie: member.cookie },
      payload: { updates: interests },
    });
  }
  return member;
}

async function seedExperience(name: string, category: string, subcategories: string[], city: { city: string; lat: number; lng: number }, description?: string) {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: description ?? `${name} — a real test fixture with enough description to pass quality scoring.`,
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

async function getSettings(crewId: string, cookie: string) {
  const res = await app.inject({ method: 'GET', url: `/crews/${crewId}/recommendation-settings`, headers: { cookie } });
  return (res.json() as { settings: { categoryPreferences: string[]; interestPreferences: string[]; preferencesSetAt: string | null; preferencesSource: string | null } }).settings;
}

async function sweep(crewId: string) {
  return app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId } });
}

describe('Crew first-value derivation — the mission-specified scenarios', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('NEW CREW — ONE MEMBER: a solo Crew safely derives its own creator\'s real taste, no forced consensus needed', async () => {
    const city = { city: 'Solo Derivation City', lat: 51.05, lng: -0.6 };
    const owner = await setUpMember('solo-owner@plot-test.invalid', city, [
      { interestId: 'rock', strength: 'love' },
      { interestId: 'alternative', strength: 'love' },
      { interestId: 'live_gigs', strength: 'love' },
    ]);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Solo Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string } };

    await sweep(crew.id); // too_few_members, but derivation runs before that gate

    const settings = await getSettings(crew.id, owner.cookie);
    expect(settings.preferencesSource).toBe('DERIVED');
    expect(settings.preferencesSetAt).not.toBeNull();
    expect(new Set(settings.interestPreferences)).toEqual(new Set(['rock', 'alternative', 'live_gigs']));
  });

  test('NEW CREW — TWO ALIGNED MEMBERS: real shared taste (rock) becomes the derived direction; each member\'s own solo interests do not leak in', async () => {
    const city = { city: 'Aligned Derivation City', lat: 51.06, lng: -0.61 };
    const owner = await setUpMember('aligned-a@plot-test.invalid', city, [
      { interestId: 'rock', strength: 'love' },
      { interestId: 'alternative', strength: 'love' },
      { interestId: 'comedy', strength: 'love' },
    ]);
    const mate = await setUpMember('aligned-b@plot-test.invalid', city, [
      { interestId: 'rock', strength: 'love' },
      { interestId: 'live_gigs', strength: 'love' },
      { interestId: 'pubs', strength: 'love' },
    ]);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Aligned Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500)); // let the post-join trigger settle

    const settings = await getSettings(crew.id, owner.cookie);
    expect(settings.preferencesSource).toBe('DERIVED');
    // The one thing genuinely shared by BOTH members — not 'comedy'/'live_gigs'/'pubs', each of
    // which only one member ever expressed an opinion on (see pickSafeOverlap's minAgreement
    // rule — real agreement from 2+ members, never one enthusiast alone).
    expect(settings.interestPreferences).toEqual(['rock']);

    // And it actually finds something real: seed a genuinely rock-tagged event alongside an
    // unrelated one, confirm the rock one is what gets delivered.
    await seedExperience('Amplitude: Rock Night', 'LIVE_MUSIC', ['rock'], city);
    await seedExperience('Unrelated Jazz Set', 'LIVE_MUSIC', ['jazz'], city);
    await sweep(crew.id);
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Amplitude: Rock Night'))).toBe(true);
    expect(messages.some((m) => m.body.includes('Unrelated Jazz Set'))).toBe(false);
  });

  test('NEW CREW — CONFLICTED MEMBERS: zero real overlap never fabricates a consensus pick', async () => {
    const city = { city: 'Conflicted Derivation City', lat: 51.07, lng: -0.62 };
    const owner = await setUpMember('conflict-a@plot-test.invalid', city, [
      { interestId: 'football', strength: 'love' },
      { interestId: 'boxing', strength: 'love' },
      { interestId: 'pubs', strength: 'love' },
    ]);
    const memberB = await setUpMember('conflict-b@plot-test.invalid', city, [
      { interestId: 'theatre', strength: 'love' },
      { interestId: 'restaurants', strength: 'love' },
      { interestId: 'markets', strength: 'love' },
    ]);
    const memberC = await setUpMember('conflict-c@plot-test.invalid', city, [
      { interestId: 'live_gigs', strength: 'love' },
      { interestId: 'comedy', strength: 'love' },
    ]);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Conflicted Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: memberB.cookie }, payload: { inviteCode: crew.inviteCode } });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: memberC.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await sweep(crew.id);

    const settings = await getSettings(crew.id, owner.cookie);
    // No forced pick from any single member's isolated taste — real overlap genuinely doesn't
    // exist here (every interest above is held by exactly one of the three), so derivation
    // correctly stays empty rather than fabricating a "consensus".
    expect(settings.categoryPreferences).toEqual([]);
    expect(settings.interestPreferences).toEqual([]);
    expect(settings.preferencesSource).toBeNull();
    expect(settings.preferencesSetAt).toBeNull();

    // And critically: no bad recommendation was silently sent from one member's isolated taste.
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes(' — /plans/'))).toBe(false);
  });

  test('EXPLICIT OVERRIDE: a Crew that already has a DERIVED guess adopts an explicit, materially different pick quickly — the guarantee re-fires', async () => {
    const city = { city: 'Override Derivation City', lat: 51.08, lng: -0.63 };
    const owner = await setUpMember('override-a@plot-test.invalid', city, [{ interestId: 'rock', strength: 'love' }]);
    const mate = await setUpMember('override-b@plot-test.invalid', city, [{ interestId: 'rock', strength: 'love' }]);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Override Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const beforeOverride = await getSettings(crew.id, owner.cookie);
    expect(beforeOverride.preferencesSource).toBe('DERIVED');
    expect(beforeOverride.interestPreferences).toEqual(['rock']);

    // Seed a food candidate only AFTER the derived rock guess is in place, so the guaranteed-
    // first delivery it already triggered (if any) can't accidentally be what this test proves.
    await seedExperience('Riverside Food Market', 'RESTAURANT', ['markets'], city);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['RESTAURANT'], interestPreferences: ['markets'] },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json() as { settings: { preferencesSource: string | null; categoryPreferences: string[] } };
    expect(patched.settings.preferencesSource).toBe('EXPLICIT');
    expect(patched.settings.categoryPreferences).toEqual(['RESTAURANT']);

    await new Promise((resolve) => setTimeout(resolve, 500)); // explicit-set fires its own guarantee

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Riverside Food Market'))).toBe(true);

    // The explicit choice sticks — a later sweep must never let derivation quietly revert it.
    await sweep(crew.id);
    const afterSweep = await getSettings(crew.id, owner.cookie);
    expect(afterSweep.preferencesSource).toBe('EXPLICIT');
    expect(afterSweep.categoryPreferences).toEqual(['RESTAURANT']);
  });

  test('MEMBER CHANGES: a 3rd member joining refines a DERIVED guess without touching an already-EXPLICIT one', async () => {
    const city = { city: 'Member Change City', lat: 51.09, lng: -0.64 };
    const owner = await setUpMember('change-a@plot-test.invalid', city, [
      { interestId: 'rock', strength: 'love' },
      { interestId: 'jazz', strength: 'love' },
    ]);
    const mate = await setUpMember('change-b@plot-test.invalid', city, [
      { interestId: 'rock', strength: 'love' },
    ]);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Change Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const afterTwo = await getSettings(crew.id, owner.cookie);
    expect(afterTwo.preferencesSource).toBe('DERIVED');
    expect(afterTwo.interestPreferences).toEqual(['rock']);

    // A 3rd member who ALSO loves jazz creates new real 2-person agreement on jazz too.
    const memberC = await setUpMember('change-c@plot-test.invalid', city, [{ interestId: 'jazz', strength: 'love' }]);
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: memberC.cookie }, payload: { inviteCode: crew.inviteCode } });
    await sweep(crew.id); // refines the DERIVED guess

    const afterThree = await getSettings(crew.id, owner.cookie);
    expect(afterThree.preferencesSource).toBe('DERIVED');
    expect(new Set(afterThree.interestPreferences)).toEqual(new Set(['rock', 'jazz']));

    // Now prove an EXPLICIT crew is immune to this refinement entirely.
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { interestPreferences: ['techno'] },
    });
    const memberD = await setUpMember('change-d@plot-test.invalid', city, [{ interestId: 'rock', strength: 'love' }]);
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: memberD.cookie }, payload: { inviteCode: crew.inviteCode } });
    await sweep(crew.id);
    const afterExplicit = await getSettings(crew.id, owner.cookie);
    expect(afterExplicit.preferencesSource).toBe('EXPLICIT');
    expect(afterExplicit.interestPreferences).toEqual(['techno']); // untouched by the new member's own rock taste
  });

  test('FIRST-VALUE ACCEPTANCE TEST: the full realistic journey reaches a truthful first recommendation with zero manual rescue', async () => {
    const city = { city: 'Acceptance Test City', lat: 51.1, lng: -0.65 };

    // CREATE USER -> SET PERSONAL TASTE
    const owner = await setUpMember('acceptance-owner@plot-test.invalid', city, [
      { interestId: 'techno', strength: 'love' },
      { interestId: 'house', strength: 'love' },
    ]);

    // CREATE CREW
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Acceptance Crew', defaultCity: city.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    // INVITE SECOND MEMBER -> SECOND MEMBER JOINS (their own real taste genuinely overlaps)
    const mate = await setUpMember('acceptance-mate@plot-test.invalid', city, [
      { interestId: 'techno', strength: 'like' },
      { interestId: 'clubbing', strength: 'love' },
    ]);
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });

    // CHAT — an ordinary message, never a manual preference rescue.
    await app.inject({ method: 'POST', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie }, payload: { body: 'excited for this crew!' } });

    // Real inventory Plot can actually search — seeded AFTER the Crew/members exist, same
    // isolation pattern every other real-pipeline test here uses.
    // P0-FINAL-1: CLUBBING is a "place-like" category (a generic nightclub listing is no more a
    // reason to interrupt a Crew's chat than an ordinary restaurant is) — a genuine club-night
    // signal in its own text is what makes this a real occasion, not just "there's a nightclub".
    await seedExperience('Warehouse Techno Session', 'CLUBBING', ['techno'], city, 'Warehouse Techno Session — a real techno club night, with enough description to pass quality scoring.');
    await seedExperience('Unrelated Folk Night', 'LIVE_MUSIC', ['folk'], city);

    // NO MANUAL CREW-PREFERENCE RESCUE — only the ordinary automatic sweep, exactly like
    // production's periodic cadence would.
    await sweep(crew.id);

    // PLOT HAS ENOUGH UNDERSTANDING TO SEARCH -> RELEVANT OPPORTUNITY FOUND -> DELIVERED
    const settings = await getSettings(crew.id, owner.cookie);
    expect(settings.preferencesSource).toBe('DERIVED');
    expect(settings.preferencesSetAt).not.toBeNull();

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes('Warehouse Techno Session'));
    expect(announcement).toBeDefined();
    expect(messages.some((m) => m.body.includes('Unrelated Folk Night'))).toBe(false);

    // REASON IS TRUTHFUL — never a fabricated score, never claiming a false crew-wide consensus
    // it can't back up; explains the real match.
    const slug = announcement!.body.match(/\/plans\/([a-zA-Z0-9-]+)$/)![1];
    const planRes = await app.inject({ method: 'GET', url: `/plans/public/${slug}` });
    const { recommendation } = planRes.json() as { recommendation: { reasonText: string } | null };
    expect(recommendation!.reasonText.length).toBeGreaterThan(0);
    expect(recommendation!.reasonText).not.toMatch(/\d{1,3}\s*(%|\/100|points)/); // never a raw score

    // THEN: CREW EXPLICITLY SETS ITS OWN TASTE -> RECOMMENDATION MODEL UPDATES APPROPRIATELY.
    // Real cadence spacing (MIN_HOURS_BETWEEN_RECOMMENDATIONS = 36h) correctly protects this
    // Crew from a second send moments after its first — that's working as designed, not
    // something an explicit preference edit should bypass (re-sending on every settings tweak
    // would be exactly the "spam" this cadence exists to prevent). So this proves the model
    // genuinely updated two ways: (1) the settings themselves, immediately; (2) what the very
    // next eligible send would actually pick, by backdating the one prior CrewRecommendation
    // past the cadence window — the same real cadence gate, not a bypass of it.
    await seedExperience('Riverside Jazz Evening', 'LIVE_MUSIC', ['jazz'], city);
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['LIVE_MUSIC'], interestPreferences: ['jazz'] },
    });
    expect(patchRes.statusCode).toBe(200);
    const afterExplicit = await getSettings(crew.id, owner.cookie);
    expect(afterExplicit.preferencesSource).toBe('EXPLICIT');
    expect(afterExplicit.categoryPreferences).toEqual(['LIVE_MUSIC']);
    expect(afterExplicit.interestPreferences).toEqual(['jazz']);

    await prisma.crewRecommendation.updateMany({
      where: { crewId: crew.id },
      data: { createdAt: new Date(Date.now() - 40 * 60 * 60 * 1000) },
    });
    await sweep(crew.id);

    const messagesAfter = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages: laterMessages } = messagesAfter.json() as { messages: { body: string }[] };
    expect(laterMessages.some((m) => m.body.includes('Riverside Jazz Evening'))).toBe(true);
  });
});
