import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real, live-reported bug: "once I tune my plot, it saves the previous preferences as well as the
 * newly set, therefore when I go onto the homepage, it suggests me events as part of prior
 * preferences and does not auto update to the new ones... if I had Rock selected as a preference,
 * but then want to go back and set different ones, I do not then want to see Rock on the home
 * page." Root cause: TuneMyPlotSheet's clear tap sends `strength: 'open'` (a real write, so
 * clearing is never silently dropped), but services/tasteSignals.ts#applyInterestUpdates used to
 * store `STRENGTH_WEIGHT.open` (0.2) as the new affinity — a genuine, nonzero, POSITIVE weight,
 * not "no preference" — so a cleared interest kept scoring on Home forever and re-opening the
 * picker even showed it as still tapped.
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
      venueName: 'Test Venue',
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
  interestRows: { interestId: string; label: string }[];
}

describe('Tune My Plot: clearing an interest actually clears it, not just adds to it', () => {
  test('a cleared interest stops influencing Home, immediately, and never shows as still active', async () => {
    await resetDatabase();
    await seedExperience('Friday Night Rock Show', 'LIVE_MUSIC', ['rock']);
    await seedExperience('Steady Baseline Restaurant Night', 'RESTAURANT', ['casual dining']);

    const cookie = await loginByEmail('tune-clear@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie },
      payload: { displayName: 'tune-clear', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });

    // Set Rock as a real, loved interest.
    const setRes = await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: { updates: [{ interestId: 'rock', strength: 'love' }] },
    });
    expect((setRes.json() as { tasteProfile: { interestAffinity: Record<string, number> } }).tasteProfile.interestAffinity.rock).toBe(1);

    const beforeRes = await app.inject({ method: 'GET', url: '/home/personalized', headers: { cookie } });
    const before = beforeRes.json() as HomeResponse;
    const rockCard = before.forYou.find((s) => s.experience.name === 'Friday Night Rock Show');
    expect(rockCard).toBeDefined();
    expect(rockCard!.reasons.some((r) => r.code === 'interest_match' && r.label.includes('Rock'))).toBe(true);
    expect(before.interestRows.some((r) => r.interestId === 'rock')).toBe(true);

    // Go back into Tune My Plot and clear it — exactly the picker's own cycle-to-null tap
    // (TuneMyPlotSheet.tsx#cycleInterest), which sends `strength: 'open'`.
    const clearRes = await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: { updates: [{ interestId: 'rock', strength: 'open' }] },
    });
    const clearedProfile = (clearRes.json() as { tasteProfile: { interestAffinity: Record<string, number> } }).tasteProfile;
    // True neutral — the key is gone, not a residual 0.2 that still reads as "liked".
    expect(clearedProfile.interestAffinity.rock).toBeUndefined();

    const afterRes = await app.inject({ method: 'GET', url: '/home/personalized', headers: { cookie } });
    const after = afterRes.json() as HomeResponse;
    // Never again attributed to a Rock preference that no longer exists.
    expect(after.forYou.some((s) => s.reasons.some((r) => r.code === 'interest_match' && r.label.includes('Rock')))).toBe(false);
    expect(after.interestRows.some((r) => r.interestId === 'rock')).toBe(false);
  });

  test('clearing one interest never disturbs a different interest set at the same time', async () => {
    await resetDatabase();
    await seedExperience('Friday Night Rock Show', 'LIVE_MUSIC', ['rock']);
    await seedExperience('Saturday Jazz Session', 'LIVE_MUSIC', ['jazz']);

    const cookie = await loginByEmail('tune-clear-2@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie },
      payload: { displayName: 'tune-clear-2', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: { updates: [{ interestId: 'rock', strength: 'love' }, { interestId: 'jazz', strength: 'love' }] },
    });

    const clearRes = await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: { updates: [{ interestId: 'rock', strength: 'open' }] },
    });
    const profile = (clearRes.json() as { tasteProfile: { interestAffinity: Record<string, number> } }).tasteProfile;
    expect(profile.interestAffinity.rock).toBeUndefined();
    expect(profile.interestAffinity.jazz).toBe(1); // untouched
  });
});

/**
 * Real, live-reported bug, one level deeper than the interest-clearing fix above: "The homepage
 * does not then auto update and only show events in that category! ... it should not show live
 * music on the home page if live music is not a preference set at profile level." Root cause:
 * TasteProfile.categoryAffinity is a SEPARATE, older store, bulk-written exactly once by
 * onboarding's category swipe (services/taste.ts#submitTasteSwipes) and never otherwise
 * editable — Tune My Plot only ever wrote interestAffinity. So a person who swiped "yes" to Live
 * Music during onboarding, then went into Tune My Plot and cleared every specific music interest
 * they'd picked, still had the ORIGINAL onboarding-era categoryAffinity.live_music sitting there
 * untouched — and evaluateTasteRelevance's eligibility gate treats ANY positive categoryAffinity
 * as enough to keep the whole category eligible, regardless of what Tune My Plot now shows
 * selected.
 */
describe('Tune My Plot clearing a whole territory also releases the stale onboarding-era category signal', () => {
  test('clearing every music interest stops Home showing live music at all — even one from the original onboarding swipe', async () => {
    await resetDatabase();
    await seedExperience('Untagged Arena Live Music Night', 'LIVE_MUSIC', []); // no interest tag at all — only category-level affinity can carry this one

    const cookie = await loginByEmail('category-leak-owner@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie },
      payload: { displayName: 'category-leak', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });

    // The real onboarding flow: a bulk category swipe, "yes" to live_music.
    await app.inject({
      method: 'POST',
      url: '/users/me/taste',
      headers: { cookie },
      payload: {
        swipes: [{ category: 'live_music', choice: 'yes' as const }],
        budget: { minMinor: 1000, maxMinor: 8000, currency: 'GBP' },
        travelRadiusMeters: 24000,
        energyPreference: 'MEDIUM',
      },
    });

    // Confirms the untagged event is genuinely eligible purely on category-level signal before
    // Tune My Plot ever gets touched — otherwise this test wouldn't be exercising the real bug.
    const beforeRes = await app.inject({ method: 'GET', url: '/home/personalized', headers: { cookie } });
    const before = beforeRes.json() as { forYou: { experience: { name: string } }[] };
    expect(before.forYou.some((s) => s.experience.name === 'Untagged Arena Live Music Night')).toBe(true);

    // Go into Tune My Plot's Music territory, pick a specific interest, then clear it — leaving
    // Music with zero positive interest signal, exactly the reported flow.
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: { updates: [{ interestId: 'rock', strength: 'love' }] },
    });
    const clearRes = await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: { updates: [{ interestId: 'rock', strength: 'open' }] },
    });
    const profile = (clearRes.json() as { tasteProfile: { categoryAffinity: Record<string, number> } }).tasteProfile;
    // The stale onboarding-era category signal is gone too, not just the interest.
    expect(profile.categoryAffinity.live_music).toBeUndefined();

    const afterRes = await app.inject({ method: 'GET', url: '/home/personalized', headers: { cookie } });
    const after = afterRes.json() as { forYou: { experience: { name: string } }[] };
    expect(after.forYou.some((s) => s.experience.name === 'Untagged Arena Live Music Night')).toBe(false);
  });

  test('a category still covered by a DIFFERENT territory with real signal is never cleared out from under it', async () => {
    await resetDatabase();
    // DAY_ACTIVITY is covered by both the 'food' territory (markets, street food) and the
    // 'outdoors_active' territory — clearing every food interest must never silently kill a
    // DAY_ACTIVITY preference that's genuinely still alive via Outdoors & Active.
    const cookie = await loginByEmail('category-shared-owner@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie },
      payload: { displayName: 'category-shared', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    // Onboarding-era category signal on BOTH categories 'food' covers, same as a real "yes" swipe
    // to Restaurants and Days out — the stale signal this test proves survives (or doesn't).
    await app.inject({
      method: 'POST',
      url: '/users/me/taste',
      headers: { cookie },
      payload: {
        swipes: [{ category: 'restaurant', choice: 'yes' as const }, { category: 'day_activity', choice: 'yes' as const }],
        budget: { minMinor: 1000, maxMinor: 8000, currency: 'GBP' },
        travelRadiusMeters: 24000,
        energyPreference: 'MEDIUM',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: {
        updates: [
          { interestId: 'markets', strength: 'love' }, // 'food' territory
          { interestId: 'walking', strength: 'love' }, // 'outdoors_active' territory, also covers DAY_ACTIVITY
        ],
      },
    });

    const clearRes = await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: { updates: [{ interestId: 'markets', strength: 'open' }] }, // clears ALL of 'food's own positive signal
    });
    const profile = (clearRes.json() as { tasteProfile: { categoryAffinity: Record<string, number>; interestAffinity: Record<string, number> } }).tasteProfile;
    expect(profile.interestAffinity.markets).toBeUndefined();
    expect(profile.interestAffinity.walking).toBe(1); // untouched
    // RESTAURANT (only ever covered by 'food') is fair game to clear along with it...
    expect(profile.categoryAffinity.restaurant).toBeUndefined();
    // ...but DAY_ACTIVITY (also covered by the still-alive 'outdoors_active' territory) must
    // survive — clearing one territory's own interest must never reach into a category another
    // territory still has a real, live claim on.
    expect(profile.categoryAffinity.day_activity).toBe(1);
  });
});
