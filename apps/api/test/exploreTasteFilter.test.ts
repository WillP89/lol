import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

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
const STAFFORD = 'Stafford';

async function loginByEmail(email: string): Promise<string> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  return `${cookie.name}=${cookie.value}`;
}

interface ExploreResponse {
  experiences: { id: string; category: string }[];
  filteredToTaste: boolean;
  totalBeforeFilter: number;
}

describe('Explore taste filtering', () => {
  let cookie = '';
  let userId = '';

  beforeAll(async () => {
    await resetDatabase();
    cookie = await loginByEmail('explore-taste-filter@plot-test.invalid');
    const callback = await app.inject({ method: 'GET', url: '/users/me', headers: { cookie } });
    userId = (callback.json() as { user: { id: string } }).user.id;
  });

  // Real fragility this guards against: the mock providers seed events at fixed clock times
  // (a dinner slot at a fixed hour, say), so "which category has any inventory still ahead of
  // right now" genuinely shifts over the course of a day — a test that hardcodes "restaurant"
  // would pass at 2pm and fail at 8pm with zero code change. Read the actual category present in
  // the unfiltered baseline instead of assuming one, so this test proves the real behaviour
  // (a positive preference hides non-matches) regardless of what time it happens to run.
  let baselineCategories: string[] = [];

  test('with no taste signal, every real experience stays visible (never filtered to zero for a new account)', async () => {
    const res = await app.inject({ method: 'GET', url: `/explore/experiences?city=${STAFFORD}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExploreResponse;
    expect(body.filteredToTaste).toBe(false);
    expect(body.experiences.length).toBe(body.totalBeforeFilter);
    expect(body.experiences.length).toBeGreaterThan(0);
    // The Stafford mock inventory spans more than one category — otherwise the filtered test
    // below would prove nothing (everything would "match" trivially).
    baselineCategories = body.experiences.map((e) => e.category);
    const categories = new Set(baselineCategories);
    expect(categories.size).toBeGreaterThan(1);
  });

  test('a real, positive category preference immediately hides every non-matching experience', async () => {
    const targetCategory = baselineCategories[0];
    await prisma.tasteProfile.upsert({
      where: { userId },
      update: { categoryAffinity: { [targetCategory.toLowerCase()]: 1 } },
      create: { userId, categoryAffinity: { [targetCategory.toLowerCase()]: 1 } },
    });

    const res = await app.inject({ method: 'GET', url: `/explore/experiences?city=${STAFFORD}`, headers: { cookie } });
    const body = res.json() as ExploreResponse;
    expect(body.filteredToTaste).toBe(true);
    expect(body.experiences.length).toBeGreaterThan(0); // there IS real inventory for this category
    expect(body.experiences.length).toBeLessThan(body.totalBeforeFilter); // and real non-matching inventory got hidden
    for (const e of body.experiences) expect(e.category).toBe(targetCategory);
  });

  test('?filter=off is the explicit escape hatch back to everything, even with real taste signal set', async () => {
    const res = await app.inject({ method: 'GET', url: `/explore/experiences?city=${STAFFORD}&filter=off`, headers: { cookie } });
    const body = res.json() as ExploreResponse;
    expect(body.filteredToTaste).toBe(false);
    expect(body.experiences.length).toBe(body.totalBeforeFilter);
    const categories = new Set(body.experiences.map((e) => e.category));
    expect(categories.size).toBeGreaterThan(1);
  });
});
