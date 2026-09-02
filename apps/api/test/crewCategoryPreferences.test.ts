import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * "You should really be able to set preferences at the crew level too, so it becomes tailored
 * to the crew" — the live request this proves. A Crew's own explicit category pick blends WITH
 * (never replaces) member-derived taste: it counts as a real taste signal in its own right
 * (services/crewRecommendations.ts's hasTasteSignal) and boosts scoring (services/match.ts),
 * proven here with members whose OWN swipe-derived taste has nothing to do with the seeded
 * event's category — the only reason it clears the bar is the Crew-level preference.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
// Truro deliberately, not Stafford — Stafford has real mock-provider coverage (restaurants,
// ticketed events) for every common category, which contaminated an earlier version of this
// test: members swiping "restaurant" as a liked category matched a genuine mock restaurant
// candidate on the very first sweep, unrelated to anything this test is actually proving. Truro
// has zero coverage in any of the three mock providers' own CITY_* maps, so the ONLY candidate
// ensureInventory can ever find here is the one this test manually seeds — a clean, isolated
// proof of crew_preference's own effect, not an artifact of shared mock inventory.
const TEST_CITY = { city: 'Truro', lat: 50.2632, lng: -5.051 };

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
    payload: { displayName: email.split('@')[0], homeCity: TEST_CITY.city, homeLat: TEST_CITY.lat, homeLng: TEST_CITY.lng },
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
      city: TEST_CITY.city,
      latitude: TEST_CITY.lat,
      longitude: TEST_CITY.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience;
}

describe('crew-level category preferences: tailoring a Crew beyond member-derived taste', () => {
  let crewId = '';
  let owner: { userId: string; cookie: string };

  beforeAll(async () => {
    await resetDatabase();

    // Deliberately NOTHING seeded yet — the immediate post-join trigger (routes/crews.ts) now
    // guarantees a first delivery when ANY real in-radius candidate exists (see
    // guaranteedFirstRecommendation.test.ts), which would otherwise confound this test's own
    // proof. Seeding the actual candidate only AFTER the Crew is formed keeps that trigger
    // honestly finding nothing (there's genuinely nothing to guarantee), isolating what THIS
    // test actually checks: the periodic/manual sweep path, which stays deliberately
    // conservative and is where crew_preference's own effect needs to be proven in isolation.
    owner = await setUpMember('crew-pref-owner@plot-test.invalid', ['comedy', 'live_music', 'restaurant']);
    const mate = await setUpMember('crew-pref-mate@plot-test.invalid', ['comedy', 'live_music', 'restaurant']);
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Preference Test Crew', defaultCity: TEST_CITY.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    crewId = crew.id;
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500)); // let the immediate post-join trigger settle (honestly finds nothing yet)

    // Now seed the actual candidate — both members' own taste is comedy/live-music/restaurant,
    // nothing to do with this DAY_ACTIVITY event, so member-derived taste alone will not clear
    // the sweep's confidence bar for it.
    await seedExperience('Truro Walking Tour', 'DAY_ACTIVITY', 'Truro Cathedral');
  });

  test('without a crew preference, a manual sweep does not deliver an event unrelated to member taste', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId } });
    expect((res.json() as { delivered: number }).delivered).toBe(0);
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crewId}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Truro Walking Tour'))).toBe(false);
  });

  test('setting a crew-level category preference is readable back via GET, defaulting to empty', async () => {
    const res = await app.inject({ method: 'GET', url: `/crews/${crewId}/recommendation-settings`, headers: { cookie: owner.cookie } });
    const { settings } = res.json() as { settings: { categoryPreferences: string[] } };
    expect(settings.categoryPreferences).toEqual([]);
  });

  test('after the Crew sets DAY_ACTIVITY as a preference, the previously-ineligible event is delivered with a crew_preference reason', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/crews/${crewId}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['DAY_ACTIVITY'] },
    });
    expect(patchRes.statusCode).toBe(200);
    const { settings } = patchRes.json() as { settings: { categoryPreferences: string[] } };
    expect(settings.categoryPreferences).toEqual(['DAY_ACTIVITY']);

    const sweepRes = await app.inject({ method: 'POST', url: '/admin/recommendations/sweep', headers: { 'x-admin-key': ADMIN_KEY }, payload: { crewId } });
    expect(sweepRes.statusCode).toBe(200);
    expect((sweepRes.json() as { delivered: number }).delivered).toBe(1);

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crewId}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes('Truro Walking Tour'));
    expect(announcement).toBeDefined();

    const slug = announcement!.body.match(/\/plans\/([a-zA-Z0-9-]+)$/)![1];
    const planRes = await app.inject({ method: 'GET', url: `/plans/public/${slug}` });
    const { recommendation } = planRes.json() as { recommendation: { reasonText: string } | null };
    expect(recommendation!.reasonText.toLowerCase()).toContain('preference');
  });

  test('the admin diagnostic (GET /admin/users/lookup) reflects the delivered recommendation for this Crew', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/users/lookup?email=crew-pref-owner@plot-test.invalid', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { crews: { crewId: string; mostRecentRecommendation: { experienceName: string; category: string } | null }[] };
    const crew = body.crews.find((c) => c.crewId === crewId);
    expect(crew?.mostRecentRecommendation?.experienceName).toBe('Truro Walking Tour');
    expect(crew?.mostRecentRecommendation?.category).toBe('DAY_ACTIVITY');
  });
});
