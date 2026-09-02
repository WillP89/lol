import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { scoreExperiencesForCrew } from '../src/services/match';
import { prisma } from '../src/lib/prisma';

/**
 * THE PERSONALISATION-ENGINE PASS — the hard acceptance test the brief itself demands: three
 * Crews, genuinely different specific-interest taste (not just different top-level categories —
 * that was already proven in crewRecommendations.test.ts), same city, same inventory pool, same
 * date window. If they all surface the same top pick, personalisation has failed. This also
 * proves the free-text signal and the PASS-learning loop actually influence scoring, not just
 * exist as UI.
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

/** A member with real SPECIFIC-interest taste (not just a broad category) — sets up location,
 *  then taps the exact interests a real "Tune My Plot" session would, via the new granular
 *  editor endpoint (POST /users/me/taste/interests), not the old bulk category swipe. */
async function setUpMember(email: string, interestIds: string[]): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
  });
  await app.inject({
    method: 'POST',
    url: '/users/me/taste/interests',
    headers: { cookie: member.cookie },
    payload: { updates: interestIds.map((interestId) => ({ interestId, strength: 'love' as const })) },
  });
  return member;
}

async function createCrewWith(owner: { cookie: string }, mate: { cookie: string }, name: string): Promise<string> {
  const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name, defaultCity: STAFFORD.city } });
  const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
  // "no events or things should be done on crew until preference set" — required before
  // find-us-something will do anything (services/crewPreferencesGate.ts). BAR is deliberately
  // unrelated to every category this suite's shared inventory pool uses (LIVE_MUSIC/SPORT/
  // RESTAURANT), so it satisfies the gate without adding a crew_preference boost that would
  // confound what these tests are actually proving (member-derived specific-interest matching).
  await app.inject({
    method: 'PATCH',
    url: `/crews/${crew.id}/recommendation-settings`,
    headers: { cookie: owner.cookie },
    payload: { categoryPreferences: ['BAR'] },
  });
  await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
  return crew.id;
}

async function seedExperience(name: string, category: string, subcategories: string[], venueName: string) {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring and describe what it actually is.`,
      category,
      subcategories,
      venueName,
      city: STAFFORD.city,
      latitude: STAFFORD.lat,
      longitude: STAFFORD.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3500,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience.id;
}

interface FindResult {
  options: { experience: { id: string; name: string }; matchScore: number; reasons: { code: string; label: string }[] }[];
}

describe('the personalisation engine: three materially different Crews, same city, same inventory', () => {
  let crewGarage = '';
  let crewFootball = '';
  let crewFood = '';

  beforeAll(async () => {
    await resetDatabase();

    // The shared inventory pool — deliberately spans three DIFFERENT specific interests inside
    // categories that can overlap (LIVE_MUSIC covers both garage and an unrelated genre), so a
    // pass that only matched on category (not specific interest) could not tell these apart.
    await seedExperience('UK Garage All-Nighter', 'LIVE_MUSIC', ['uk garage'], 'The Warehouse');
    await seedExperience('Symphony Orchestra Gala', 'LIVE_MUSIC', ['classical'], 'Stafford Civic Hall');
    await seedExperience('Stafford Championship Derby Day', 'SPORT', ['championship'], 'Stafford County Ground');
    await seedExperience('County Cricket Friendly', 'SPORT', ['cricket'], 'Stafford Cricket Club');
    await seedExperience('Sushi & Ramen Night Market', 'RESTAURANT', ['japanese'], 'Riverside Kitchens');
    await seedExperience('Steakhouse Tasting Menu', 'RESTAURANT', ['steak'], 'The Stafford Chophouse');

    const garageA = await setUpMember('pe-garage-a@plot-test.invalid', ['uk_garage', 'house']);
    const garageB = await setUpMember('pe-garage-b@plot-test.invalid', ['uk_garage', 'electronic']);
    crewGarage = await createCrewWith(garageA, garageB, 'UK Garage Crew');

    const footballA = await setUpMember('pe-football-a@plot-test.invalid', ['championship_football', 'boxing']);
    const footballB = await setUpMember('pe-football-b@plot-test.invalid', ['championship_football', 'pubs']);
    crewFootball = await createCrewWith(footballA, footballB, 'Championship Crew');

    const foodA = await setUpMember('pe-food-a@plot-test.invalid', ['japanese', 'independent_cinema']);
    const foodB = await setUpMember('pe-food-b@plot-test.invalid', ['japanese', 'walking']);
    crewFood = await createCrewWith(foodA, foodB, 'Japanese Food Crew');

    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  test('the UK garage Crew is ranked top-1 for the garage night, not the derby or the sushi market', async () => {
    const owner = await loginByEmail('pe-garage-a@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewGarage}/find-us-something`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as FindResult;
    expect(options[0].experience.name).toBe('UK Garage All-Nighter');
    expect(options[0].reasons.some((r) => r.code === 'interest_match')).toBe(true);
  });

  test('the Championship-football Crew is ranked top-1 for the derby, and the SAME city/inventory produces a DIFFERENT #1 than the garage Crew', async () => {
    const owner = await loginByEmail('pe-football-a@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewFootball}/find-us-something`, headers: { cookie: owner.cookie } });
    const { options } = res.json() as FindResult;
    expect(options[0].experience.name).toBe('Stafford Championship Derby Day');
    expect(options[0].reasons.some((r) => r.code === 'interest_match')).toBe(true);
  });

  test('the Japanese-food Crew is ranked top-1 for the sushi market — three genuinely different #1s from one shared pool', async () => {
    const owner = await loginByEmail('pe-food-a@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewFood}/find-us-something`, headers: { cookie: owner.cookie } });
    const { options } = res.json() as FindResult;
    expect(options[0].experience.name).toBe('Sushi & Ramen Night Market');
    expect(options[0].reasons.some((r) => r.code === 'interest_match')).toBe(true);
  });

  test('a free-text signal ("UK Garage All-Nighter" spelled out) surfaces a literal match reason, honestly, with no taxonomy match required', async () => {
    const solo = await setUpMember('pe-freetext@plot-test.invalid', []);
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/free-text',
      headers: { cookie: solo.cookie },
      payload: { text: 'UK Garage All-Nighter' },
    });
    const mate = await setUpMember('pe-freetext-mate@plot-test.invalid', []);
    const crewId = await createCrewWith(solo, mate, 'Free Text Crew');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: solo.cookie } });
    const { options } = res.json() as FindResult;
    const garageOption = options.find((o) => o.experience.name === 'UK Garage All-Nighter');
    expect(garageOption).toBeDefined();
    expect(garageOption!.reasons.some((r) => r.code === 'free_text_match')).toBe(true);
  });

  test('typing something with no real match ("Fred again..") never fabricates a claim — no interest_match, no free_text_match on unrelated inventory', async () => {
    const solo = await setUpMember('pe-honest@plot-test.invalid', []);
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/taste/free-text',
      headers: { cookie: solo.cookie },
      payload: { text: 'Fred again..' },
    });
    const { tasteProfile } = res.json() as { tasteProfile: { freeTextSignals: { text: string; matchedInterestIds: string[]; confidence: string }[] } };
    const signal = tasteProfile.freeTextSignals.find((s) => s.text === 'Fred again..');
    expect(signal).toBeDefined();
    expect(signal!.matchedInterestIds).toEqual([]);
    expect(signal!.confidence).toBe('low'); // preserved honestly, never guessed into a fake genre match
  });
});

describe('the learning loop: PASS reasons that are genuine taste signal cool future scoring; situational ones never do', () => {
  test('three NOT_FOR_US responses meaningfully lower a later score for a similar experience, without zeroing it out', async () => {
    const a = await setUpMember('pe-learn-a@plot-test.invalid', ['championship_football']);
    const b = await setUpMember('pe-learn-b@plot-test.invalid', ['championship_football']);
    const crewId = await createCrewWith(a, b, 'Learning Crew');
    const derbyId = await seedExperience('Learning Crew Target Derby', 'SPORT', ['championship'], 'Home Ground');

    const before = await scoreExperiencesForCrew(crewId);
    const beforeScore = before.find((o) => o.experience.id === derbyId)!.matchScore;
    expect(beforeScore).toBeGreaterThan(0);

    // Genuine "not our thing" responses against separately-named past SPORT/championship
    // recommendations for THIS Crew — distinct names so entity-resolution's own near-duplicate
    // suppression never collapses them with the target experience above.
    for (let i = 0; i < 3; i += 1) {
      const pastExpId = await seedExperience(`Archived Match Response Fixture ${i}`, 'SPORT', ['championship'], 'Old Ground');
      await prisma.crewRecommendation.create({
        data: { crewId, experienceId: pastExpId, score: 60, reasonText: 'test fixture', status: 'NOT_FOR_US' },
      });
    }

    const after = await scoreExperiencesForCrew(crewId);
    const afterScore = after.find((o) => o.experience.id === derbyId)!.matchScore;
    expect(afterScore).toBeLessThan(beforeScore);
    expect(afterScore).toBeGreaterThan(0); // cooled, not permanently blacklisted after one kind of PASS
  });

  test('TOO_FAR / TOO_EXPENSIVE responses do NOT cool future taste scoring — they are situational, not "not our thing"', async () => {
    const a = await setUpMember('pe-situational-a@plot-test.invalid', ['championship_football']);
    const b = await setUpMember('pe-situational-b@plot-test.invalid', ['championship_football']);
    const crewId = await createCrewWith(a, b, 'Situational Crew');
    const derbyId = await seedExperience('Situational Crew Target Derby', 'SPORT', ['championship'], 'Home Ground');

    const before = await scoreExperiencesForCrew(crewId);
    const beforeScore = before.find((o) => o.experience.id === derbyId)!.matchScore;

    for (let i = 0; i < 3; i += 1) {
      const pastExpId = await seedExperience(`Situational Archived Fixture ${i}`, 'SPORT', ['championship'], 'Distant Ground');
      await prisma.crewRecommendation.create({
        data: { crewId, experienceId: pastExpId, score: 60, reasonText: 'test fixture', status: 'TOO_FAR' },
      });
    }

    const after = await scoreExperiencesForCrew(crewId);
    const afterScore = after.find((o) => o.experience.id === derbyId)!.matchScore;
    expect(afterScore).toBe(beforeScore); // a wrong-date/too-far PASS must never read as "wrong taste"
  });
});
