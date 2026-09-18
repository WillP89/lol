import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * P0 FOUNDATION FAILURE #1 (real, live-reported): a Stafford Crew set its own taste to
 * `Live gigs` + `Rock` — Plot recommended "K Pop Demons". Root cause (services/match.ts): every
 * one of a Crew's own `interestPreferences` was treated as an independent, additive OR condition
 * — `passesPreferenceGate` admits a candidate the moment ANY one pick matches (a K-pop show
 * genuinely, honestly IS "a live gig" — that broad match was never wrong), and nothing ever asked
 * whether the candidate's own confirmed genre data actually CONTRADICTS a Crew's OTHER, more
 * specific pick. `Live gigs` + `Rock` was always scored as "live gigs OR rock", never composed
 * into "live ROCK gigs".
 *
 * The fix: `narrows: true` on a taxonomy interest (packages/shared/src/tasteTaxonomy.ts) marks it
 * as a genuine refinement of its territory (a genre, a cuisine, a sport discipline) rather than a
 * broad/context pick ("Live gigs", "Restaurants", "Watching big matches"). A candidate carrying
 * CONFIRMED evidence (subcategory-sourced, never a loose keyword hit) of a DIFFERENT narrowing
 * interest in the same territory as one a Crew picked — and neither matching it nor a curated
 * `RELATED_INTERESTS` sibling — has its score capped far under MIN_RECOMMENDATION_SCORE and is
 * marked `GENRE_MISMATCH` in the recommendation debugger, never silently hidden. This is every
 * scenario the P0 report asked for by name: the exact reported failure, the broad-only-Crew
 * control case (K-pop must NOT be penalised without a specific pick), and three cross-domain
 * cases (food/cuisine, sport/discipline, nightlife/genre) proving the fix is architectural, not a
 * K-pop-specific patch.
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

async function setUpMember(email: string, personalInterests: { interestId: string; strength: 'love' | 'like' }[] = []): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
  });
  if (personalInterests.length > 0) {
    await app.inject({ method: 'POST', url: '/users/me/taste/interests', headers: { cookie: member.cookie }, payload: { updates: personalInterests } });
  }
  return member;
}

async function createCrew(ownerCookie: string, name: string): Promise<{ id: string; inviteCode: string }> {
  const res = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: ownerCookie }, payload: { name, defaultCity: STAFFORD.city } });
  return (res.json() as { crew: { id: string; inviteCode: string } }).crew;
}

async function joinCrew(inviteCode: string, cookie: string) {
  const res = await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie }, payload: { inviteCode } });
  expect(res.statusCode).toBe(200);
}

async function setInterestPreferences(crewId: string, cookie: string, interestPreferences: string[]) {
  const res = await app.inject({ method: 'PATCH', url: `/crews/${crewId}/recommendation-settings`, headers: { cookie }, payload: { interestPreferences } });
  expect(res.statusCode).toBe(200);
}

async function seedExperience(opts: { name: string; category: string; description: string; subcategories?: string[] }) {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name: opts.name,
      description: opts.description,
      category: opts.category,
      subcategories: opts.subcategories ?? [],
      venueName: `${opts.name} Venue`,
      city: STAFFORD.city,
      latitude: STAFFORD.lat,
      longitude: STAFFORD.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(opts.name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
}

interface DebugCandidate {
  title: string;
  matchScore: number;
  reasons: { code: string; label: string }[];
  rejectionReasons: string[];
  eligible: boolean;
}

async function explain(crewId: string): Promise<{ outcome: string; topCandidates: DebugCandidate[] }> {
  const res = await app.inject({ method: 'GET', url: `/admin/crews/${crewId}/explain-recommendation`, headers: { 'x-admin-key': ADMIN_KEY } });
  expect(res.statusCode).toBe(200);
  return res.json() as { outcome: string; topCandidates: DebugCandidate[] };
}

function byTitle(candidates: DebugCandidate[], title: string): DebugCandidate {
  const found = candidates.find((c) => c.title === title);
  if (!found) throw new Error(`Candidate "${title}" not found among topCandidates: ${candidates.map((c) => c.title).join(', ')}`);
  return found;
}

describe('Taste specificity/hierarchy (P0-1): specific preferences narrow broad ones', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('MANDATORY REGRESSION: Stafford Rock Crew (Live gigs + Rock) does not let K-pop win, and real rock beats it', async () => {
    await seedExperience({
      name: 'K Pop Demons',
      category: 'LIVE_MUSIC',
      description: 'K Pop Demons brings an unmissable live gig experience to Stafford — big vocals, bigger choreography.',
      subcategories: ['k-pop'],
    });
    await seedExperience({
      name: 'Generic Live Music Night',
      category: 'LIVE_MUSIC',
      description: 'A regular live gig night at a Stafford venue — whoever is playing this week.',
      subcategories: [],
    });
    await seedExperience({
      name: 'Stafford Rock Night',
      category: 'LIVE_MUSIC',
      description: 'A real rock night in Stafford, guitars and all.',
      subcategories: ['rock'],
    });
    await seedExperience({
      name: 'Alt Rock Live',
      category: 'LIVE_MUSIC',
      description: 'An alternative rock showcase touring through Stafford.',
      subcategories: ['alternative'],
    });

    const owner = await setUpMember('rock-crew-owner@plot-test.invalid', [{ interestId: 'rock', strength: 'love' }]);
    const mate = await setUpMember('rock-crew-mate@plot-test.invalid', [{ interestId: 'rock', strength: 'love' }]);
    const crew = await createCrew(owner.cookie, 'Rock Crew');
    await setInterestPreferences(crew.id, owner.cookie, ['live_gigs', 'rock']);
    await joinCrew(crew.inviteCode, mate.cookie);

    const { topCandidates } = await explain(crew.id);

    const kpop = byTitle(topCandidates, 'K Pop Demons');
    const generic = byTitle(topCandidates, 'Generic Live Music Night');
    const rockNight = byTitle(topCandidates, 'Stafford Rock Night');
    const altRock = byTitle(topCandidates, 'Alt Rock Live');

    // The specific, contradicting genre pick is caught and named honestly — never silently
    // dropped, never let through on the strength of the broad "Live gigs" pick alone.
    expect(kpop.rejectionReasons).toContain('GENRE_MISMATCH');
    expect(kpop.reasons.some((r) => r.code === 'genre_contradiction')).toBe(true);
    expect(kpop.eligible).toBe(false);

    // The broad pick alone ("Live gigs") is still honestly satisfied by a genuinely untagged
    // event — Plot doesn't know enough to call it wrong, so it must never be penalised the same
    // way a CONFIRMED contradiction is.
    expect(generic.rejectionReasons).not.toContain('GENRE_MISMATCH');

    // Real rock (and its curated close relation, alternative rock) never gets penalised at all.
    expect(rockNight.rejectionReasons).not.toContain('GENRE_MISMATCH');
    expect(altRock.rejectionReasons).not.toContain('GENRE_MISMATCH');

    // THE ORDERING the P0 report asked for: real rock matches score highest, a generic untagged
    // live-music night lands in the middle, and the confirmed K-pop contradiction sits at the
    // bottom — never able to win on unrelated score volume (distance/availability/quality/
    // ticketed) alone.
    expect(rockNight.matchScore).toBeGreaterThan(kpop.matchScore);
    expect(altRock.matchScore).toBeGreaterThan(kpop.matchScore);
    expect(generic.matchScore).toBeGreaterThan(kpop.matchScore);
    expect(kpop.matchScore).toBeLessThan(20 + 1); // capped comfortably under MIN_RECOMMENDATION_SCORE (55)
  });

  test('CONTROL: a Crew with ONLY the broad "Live gigs" pick (no genre) is never penalised for K-pop', async () => {
    await seedExperience({
      name: 'K Pop Demons 2',
      category: 'LIVE_MUSIC',
      description: 'K Pop Demons brings an unmissable live gig experience to Stafford.',
      subcategories: ['k-pop'],
    });
    const owner = await setUpMember('broad-crew-owner@plot-test.invalid');
    const mate = await setUpMember('broad-crew-mate@plot-test.invalid');
    const crew = await createCrew(owner.cookie, 'Broad Live Gigs Crew');
    // Deliberately ONLY the broad pick — no genre at all. The brief's own worked example: "If the
    // Crew preference had ONLY been LIVE GIGS then a local K-pop show could actually be a
    // reasonable recommendation."
    await setInterestPreferences(crew.id, owner.cookie, ['live_gigs']);
    await joinCrew(crew.inviteCode, mate.cookie);

    const { topCandidates } = await explain(crew.id);
    const kpop = byTitle(topCandidates, 'K Pop Demons 2');
    expect(kpop.rejectionReasons).not.toContain('GENRE_MISMATCH');
    expect(kpop.reasons.some((r) => r.code === 'genre_contradiction')).toBe(false);
  });

  test('CROSS-DOMAIN — Food: a Japanese Food Crew is not satisfied by a contradicting cuisine', async () => {
    // P0-FINAL-1 ("The Hidden Chef" fix): an ordinary restaurant is no longer plan-worthy on its
    // own — both fixtures need a genuine specialness signal (a one-off supper club/tasting event)
    // to reach eligibility at all, so this test can still prove its actual point (specific cuisine
    // beats a contradicting one) without depending on behaviour the product deliberately no longer
    // has.
    await seedExperience({
      name: 'Sushi Sakura',
      category: 'RESTAURANT',
      description: "One of Stafford's most-loved supper club tasting nights, specialising in fresh sushi.",
      subcategories: ['japanese'],
    });
    await seedExperience({
      name: 'Bangkok Thai Kitchen',
      category: 'RESTAURANT',
      description: "A genuinely excellent supper club tasting night, part of Stafford's restaurants scene.",
      subcategories: ['thai'],
    });
    const owner = await setUpMember('food-crew-owner@plot-test.invalid', [{ interestId: 'japanese', strength: 'love' }]);
    const mate = await setUpMember('food-crew-mate@plot-test.invalid', [{ interestId: 'japanese', strength: 'love' }]);
    const crew = await createCrew(owner.cookie, 'Japanese Food Crew');
    await setInterestPreferences(crew.id, owner.cookie, ['restaurants', 'japanese']);
    await joinCrew(crew.inviteCode, mate.cookie);

    const { topCandidates } = await explain(crew.id);
    const sushi = byTitle(topCandidates, 'Sushi Sakura');
    const thai = byTitle(topCandidates, 'Bangkok Thai Kitchen');

    expect(sushi.rejectionReasons).not.toContain('GENRE_MISMATCH');
    expect(thai.rejectionReasons).toContain('GENRE_MISMATCH');
    expect(sushi.matchScore).toBeGreaterThan(thai.matchScore);
    expect(thai.matchScore).toBeLessThan(20 + 1);
  });

  test('CROSS-DOMAIN — Sport: a Football Crew is not satisfied by a contradicting discipline', async () => {
    await seedExperience({
      name: 'Stafford Rangers vs Town',
      category: 'SPORT',
      description: 'A real, live football fixture at the local ground.',
      subcategories: ['football'],
    });
    await seedExperience({
      name: 'County Cricket Day',
      category: 'SPORT',
      description: "A full day of live cricket, part of Stafford's own sporting calendar.",
      subcategories: ['cricket'],
    });
    const owner = await setUpMember('sport-crew-owner@plot-test.invalid', [{ interestId: 'football', strength: 'love' }]);
    const mate = await setUpMember('sport-crew-mate@plot-test.invalid', [{ interestId: 'football', strength: 'love' }]);
    const crew = await createCrew(owner.cookie, 'Football Crew');
    await setInterestPreferences(crew.id, owner.cookie, ['football']);
    await joinCrew(crew.inviteCode, mate.cookie);

    const { topCandidates } = await explain(crew.id);
    const football = byTitle(topCandidates, 'Stafford Rangers vs Town');
    const cricket = byTitle(topCandidates, 'County Cricket Day');

    expect(football.rejectionReasons).not.toContain('GENRE_MISMATCH');
    expect(cricket.rejectionReasons).toContain('GENRE_MISMATCH');
    expect(football.matchScore).toBeGreaterThan(cricket.matchScore);
  });

  test('CROSS-DOMAIN — Nightlife: a UK Garage Crew is not satisfied by a contradicting electronic genre', async () => {
    await seedExperience({
      name: 'UK Garage Classics',
      category: 'CLUBBING',
      description: 'A real UK garage club night, Stafford edition.',
      subcategories: ['uk_garage'],
    });
    await seedExperience({
      name: 'Big Room Techno Night',
      category: 'CLUBBING',
      description: "One of Stafford's best club nights — high-energy, all night.",
      subcategories: ['techno'],
    });
    const owner = await setUpMember('garage-crew-owner@plot-test.invalid', [{ interestId: 'uk_garage', strength: 'love' }]);
    const mate = await setUpMember('garage-crew-mate@plot-test.invalid', [{ interestId: 'uk_garage', strength: 'love' }]);
    const crew = await createCrew(owner.cookie, 'UK Garage Crew');
    // `club_nights` (broad) alongside the genre picks — mirrors the exact real-world shape of the
    // reported bug (a broad format pick alongside specific genre picks), so the "Big Room Techno
    // Night" candidate genuinely reaches scoring via the broad pick, then is honestly rejected for
    // contradicting the specific genre picks — not just silently absent from the pool.
    await setInterestPreferences(crew.id, owner.cookie, ['club_nights', 'electronic', 'uk_garage']);
    await joinCrew(crew.inviteCode, mate.cookie);

    const { topCandidates } = await explain(crew.id);
    const garage = byTitle(topCandidates, 'UK Garage Classics');
    const techno = byTitle(topCandidates, 'Big Room Techno Night');

    expect(garage.rejectionReasons).not.toContain('GENRE_MISMATCH');
    expect(techno.rejectionReasons).toContain('GENRE_MISMATCH');
    expect(garage.matchScore).toBeGreaterThan(techno.matchScore);
  });
});
