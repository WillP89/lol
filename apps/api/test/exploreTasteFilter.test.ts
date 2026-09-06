import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * "When I change my preferences, the discovery page should IMMEDIATELY change to only show
 * events within that preference, it should not still show other events that are not relevant" —
 * the real behavioural change this proves (see services/explore.ts#finishExploreList). Explore
 * used to only ever REORDER by taste, never hide anything (a deliberate earlier design choice —
 * see that file's own comment) — superseded by this explicit direction. A brand-new account with
 * no taste signal yet must still see the full, honest list (never an empty page because there
 * was nothing to filter by); `?filter=off` is the permanent escape hatch back to "show me
 * everything" even once real signal exists.
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
      venueName: 'Explore Filter Test Venue',
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

interface ExploreResponse {
  experiences: { id: string; name: string; category: string }[];
  filteredToTaste: boolean;
  totalBeforeFilter: number;
}

describe('Explore taste filtering', () => {
  let cookie = '';

  beforeAll(async () => {
    await resetDatabase();
    // A deterministic, specifically-tagged fixture — real, live-reported bug this replaces a
    // bare `categoryAffinity` write with (see tasteSignals.ts#evaluateTasteRelevance's own
    // `eligible` doc comment): a raw category-level preference used to be enough on its own to
    // filter Explore, even for a category the person's actual current taste never mentioned.
    // Filtering is now driven by a real, specific interest match (or free text) only, same as
    // Home — so this proves the real mechanism, not the superseded one.
    await seedExperience('UK Garage All-Nighter Filter Test', 'LIVE_MUSIC', ['uk garage']);
    cookie = await loginByEmail('explore-taste-filter@plot-test.invalid');
  });

  test('with no taste signal, every real experience stays visible (never filtered to zero for a new account)', async () => {
    const res = await app.inject({ method: 'GET', url: `/explore/experiences?city=${STAFFORD.city}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExploreResponse;
    expect(body.filteredToTaste).toBe(false);
    expect(body.experiences.length).toBe(body.totalBeforeFilter);
    expect(body.experiences.length).toBeGreaterThan(0);
    // The Stafford mock inventory spans more than one category — otherwise the filtered test
    // below would prove nothing (everything would "match" trivially).
    const categories = new Set(body.experiences.map((e) => e.category));
    expect(categories.size).toBeGreaterThan(1);
  });

  test('a real, positive SPECIFIC-INTEREST preference immediately hides every non-matching experience', async () => {
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie },
      payload: { updates: [{ interestId: 'uk_garage', strength: 'love' }] },
    });

    const res = await app.inject({ method: 'GET', url: `/explore/experiences?city=${STAFFORD.city}`, headers: { cookie } });
    const body = res.json() as ExploreResponse;
    expect(body.filteredToTaste).toBe(true);
    expect(body.experiences.some((e) => e.name === 'UK Garage All-Nighter Filter Test')).toBe(true);
    expect(body.experiences.length).toBeLessThan(body.totalBeforeFilter); // real non-matching inventory got hidden
  });

  test('?filter=off is the explicit escape hatch back to everything, even with real taste signal set', async () => {
    const res = await app.inject({ method: 'GET', url: `/explore/experiences?city=${STAFFORD.city}&filter=off`, headers: { cookie } });
    const body = res.json() as ExploreResponse;
    expect(body.filteredToTaste).toBe(false);
    expect(body.experiences.length).toBe(body.totalBeforeFilter);
    const categories = new Set(body.experiences.map((e) => e.category));
    expect(categories.size).toBeGreaterThan(1);
  });
});
