import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real, live-reported bug — reported the moment the previous fix (dropping bare categoryAffinity
 * from Home/Explore eligibility) shipped: "my account has preferences set to boxing, mma,
 * restaurants and street food and it says 0 recommendations... it needs to actually show events."
 *
 * Root cause: real provider inventory (Ticketmaster, Skiddle, PredictHQ) essentially never
 * happens to use Plot's own specific taxonomy wording ("boxing", "street food", ...) in an
 * Experience's own name/description/subcategories — so requiring `experienceInterestTags` to
 * literally find one was far stricter than real data can meet, even for an account with entirely
 * real, current, specific interests set. Fixed via
 * tasteSignals.ts#categoriesImpliedByInterests/evaluateTasteRelevance's own `impliedByInterestId`:
 * a specific interest a person has genuinely, currently picked (never the old, stale, unclearable
 * bare categoryAffinity signal) also makes its own taxonomy category eligible, even when no
 * single Experience literally uses that wording.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
const STAFFORD = { city: 'Stafford', lat: 52.8062, lng: -2.1169 };

async function loginByEmail(email: string): Promise<string> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  return `${cookie.name}=${cookie.value}`;
}

async function seedExperience(name: string, category: string, subcategories: string[]) {
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
      venueName: 'Implied Category Test Venue',
      city: STAFFORD.city,
      latitude: STAFFORD.lat,
      longitude: STAFFORD.lng,
      startsAt,
      priceMinMinor: 1000,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
}

interface HomeResponse {
  forYou: { experience: { name: string }; reasons: { code: string; label: string }[] }[];
}

describe('a real, specific interest set finds real inventory even when no experience literally uses that wording', () => {
  test('boxing/MMA/restaurants/street food — the exact reported combination — never comes up empty', async () => {
    await resetDatabase();
    // Deliberately no boxing/MMA/restaurant/street-food wording anywhere in either fixture — the
    // literal-tag path alone would find neither of these.
    await seedExperience('Local Five-a-side Football Night', 'SPORT', ['football']);
    await seedExperience('Riverside Evening Gathering', 'RESTAURANT', []);

    const cookie = await loginByEmail('implied-category@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie },
      payload: { displayName: 'implied-category', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: {
        updates: [
          { interestId: 'boxing', strength: 'love' },
          { interestId: 'mma', strength: 'love' },
          { interestId: 'restaurants', strength: 'love' },
          { interestId: 'street_food', strength: 'love' },
        ],
      },
    });

    const res = await app.inject({ method: 'GET', url: '/home/personalized', headers: { cookie } });
    const home = res.json() as HomeResponse;
    expect(home.forYou.length).toBeGreaterThan(0); // never 0 recommendations for an account with real, current interests
    expect(home.forYou.some((s) => s.experience.name === 'Local Five-a-side Football Night')).toBe(true);
    expect(home.forYou.some((s) => s.experience.name === 'Riverside Evening Gathering')).toBe(true);
    // Every reason is still a real, specific, CURRENT interest — never a bare, unattributed
    // category line.
    for (const item of home.forYou) {
      for (const reason of item.reasons) {
        if (reason.code === 'interest_match') expect(reason.label).toMatch(/boxing|mma|restaurants|street food/i);
      }
    }
  });

  test('a category with NO current interest at all still never appears, even sitting right next to eligible ones', async () => {
    await resetDatabase();
    await seedExperience('Local Five-a-side Football Night', 'SPORT', ['football']);
    await seedExperience('Untargeted Comedy Night', 'COMEDY', []); // no interest anywhere near comedy

    const cookie = await loginByEmail('implied-category-negative@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie },
      payload: { displayName: 'implied-category-negative', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: { updates: [{ interestId: 'boxing', strength: 'love' }] },
    });

    const res = await app.inject({ method: 'GET', url: '/home/personalized', headers: { cookie } });
    const home = res.json() as HomeResponse;
    expect(home.forYou.some((s) => s.experience.name === 'Local Five-a-side Football Night')).toBe(true);
    expect(home.forYou.some((s) => s.experience.name === 'Untargeted Comedy Night')).toBe(false);
  });
});
