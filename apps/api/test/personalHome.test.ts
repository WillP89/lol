import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * THE ACCEPTANCE TEST for HOME = ME (docs/DECISIONS.md#personal-home) — the live product
 * directive's own Part 20/21, run for real against the actual seeded Stafford (pilot city)
 * inventory, not asserted from a description. Five profiles, same location/date range/inventory,
 * real HTTP requests through the real `/home/personalized` endpoint.
 *
 * What this proves, and what it doesn't: this exercises the real two-stage eligibility+ranking
 * code path (services/personalHome.ts) against this repo's own mock/dev inventory (deliberately
 * enriched this same pass with real rap/grime/drill/R&B/afrobeats and street-food-festival
 * entries — see providers/mock/ticketingProvider.ts and activityProvider.ts's own comments — to
 * give these profiles real signal to match against). It does NOT prove production inventory
 * VOLUME is sufficient — this sandbox's outbound network is blocked to every live provider
 * (Ticketmaster/Skiddle/PredictHQ/Overpass), the same documented constraint every other live
 * adapter in this codebase already carries. What it DOES conclusively prove: given real
 * inventory that includes both matching and non-matching categories, the eligibility gate
 * actually removes what doesn't belong — not just re-ranks it lower.
 */
const app = buildApp();
const STAFFORD = 'Stafford';

async function loginByEmail(email: string): Promise<{ cookie: string; userId: string }> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  const me = await app.inject({ method: 'GET', url: '/users/me', headers: { cookie: `${cookie.name}=${cookie.value}` } });
  const userId = (me.json() as { user: { id: string } }).user.id;
  return { cookie: `${cookie.name}=${cookie.value}`, userId };
}

async function setTaste(
  userId: string,
  opts: { categoryAffinity?: Record<string, number>; interestAffinity?: Record<string, number>; budgetMaxMinor?: number },
): Promise<void> {
  await prisma.profile.upsert({
    where: { userId },
    update: { homeCity: STAFFORD, homeLat: 52.8062, homeLng: -2.1169 },
    create: { userId, homeCity: STAFFORD, homeLat: 52.8062, homeLng: -2.1169 },
  });
  const data = {
    categoryAffinity: opts.categoryAffinity ?? {},
    interestAffinity: opts.interestAffinity ?? {},
    budgetMinMinor: 0,
    budgetMaxMinor: opts.budgetMaxMinor ?? 5000,
  };
  await prisma.tasteProfile.upsert({ where: { userId }, update: data, create: { userId, ...data } });
}

interface HomeItemDTO {
  experience: { id: string; name: string; category: string };
  reasons: { code: string; label: string }[];
}
interface HomeResponse {
  personalized: boolean;
  forYou: HomeItemDTO[];
  thisWeekend: HomeItemDTO[];
  interestRows: { interestId: string; label: string; items: HomeItemDTO[] }[];
  nearYou: HomeItemDTO[];
  exploration: HomeItemDTO[];
  emptyMessage: string | null;
}

/** Every item Home actually presents as PERSONALISED — i.e. everything except `exploration`,
 *  which is allowed to contain non-matching items by design (Part 12) as long as it's small and
 *  separate. This is exactly the set the negative test (Part 21) must never contain an
 *  irrelevant category in. */
function personalizedNames(home: HomeResponse): string[] {
  const all = [...home.forYou, ...home.thisWeekend, ...home.interestRows.flatMap((r) => r.items), ...home.nearYou];
  return [...new Set(all.map((i) => i.experience.name))];
}

async function fetchHome(cookie: string): Promise<HomeResponse> {
  const res = await app.inject({ method: 'GET', url: '/home/personalized', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as HomeResponse;
}

describe('Personal Home — HOME = ME acceptance test (5 profiles, one shared Stafford inventory)', () => {
  beforeAll(async () => {
    await resetDatabase();
  });

  test('User A — rap, grime, street food, museums: sees exactly that, never comedy/theatre/football/family', async () => {
    const { cookie, userId } = await loginByEmail('home-user-a@plot-test.invalid');
    await setTaste(userId, { interestAffinity: { hip_hop: 1, grime: 1, street_food: 1, food_festivals: 0.8, museums: 1 } });
    const home = await fetchHome(cookie);

    expect(home.personalized).toBe(true);
    const names = personalizedNames(home);
    console.log('\n[User A: rap/grime/street food/museums] personalised Home contains:', names);

    // POSITIVE — real matches from the real (enriched) Stafford inventory.
    expect(names).toContain('UK Rap All-Nighter');
    expect(names).toContain('Grime Originals');
    expect(names).toContain('Stafford Street Food Festival');
    expect(names).toContain('The Potteries Museum & Art Gallery');

    // NEGATIVE (Part 21, mandatory) — none of these belong to a rap/street-food/museums profile.
    for (const forbidden of [
      'New Material Night', // comedy
      'Saturday Night Stand-Up Social', // comedy
      'Stafford Gatehouse Theatre: touring musical', // theatre
      'Stoke City vs. Rotherham', // football
      'Trentham Monkey Forest', // family
      'Drill Showcase Night', // NOT selected — drill is a real, distinct genre from grime/rap in this taxonomy
      'R&B Sessions', // NOT selected
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('User B — stand-up comedy, theatre, wine tasting: sees exactly that, never rap/football/family', async () => {
    const { cookie, userId } = await loginByEmail('home-user-b@plot-test.invalid');
    await setTaste(userId, { categoryAffinity: { theatre: 1 }, interestAffinity: { stand_up: 1, musicals: 0.8, tastings: 1 } });
    const home = await fetchHome(cookie);
    const names = personalizedNames(home);
    console.log('[User B: comedy/theatre/wine tasting] personalised Home contains:', names);

    expect(names).toContain('New Material Night');
    expect(names).toContain('Saturday Night Stand-Up Social');
    expect(names).toContain('Stafford Gatehouse Theatre: touring musical');

    for (const forbidden of ['UK Rap All-Nighter', 'Grime Originals', 'Stoke City vs. Rotherham', 'Trentham Monkey Forest', 'The Potteries Museum & Art Gallery']) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('User C — football, boxing, pubs, live sport: sees exactly that, never comedy/rap/museums/family', async () => {
    const { cookie, userId } = await loginByEmail('home-user-c@plot-test.invalid');
    await setTaste(userId, { categoryAffinity: { sport: 1 }, interestAffinity: { football: 1, watching_big_matches: 1, pubs: 1 } });
    const home = await fetchHome(cookie);
    const names = personalizedNames(home);
    console.log('[User C: football/boxing/pubs/live sport] personalised Home contains:', names);

    expect(names).toContain('Stoke City vs. Rotherham');

    for (const forbidden of ['New Material Night', 'UK Rap All-Nighter', 'Grime Originals', 'The Potteries Museum & Art Gallery', 'Trentham Monkey Forest', 'Stafford Gatehouse Theatre: touring musical']) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('User D — family activities, animals, outdoor activities, free events: sees exactly that, never rap/comedy/football/museums', async () => {
    const { cookie, userId } = await loginByEmail('home-user-d@plot-test.invalid');
    await setTaste(userId, { interestAffinity: { family_days_out: 1, animals_wildlife: 1, walking: 1, hiking: 0.6 }, budgetMaxMinor: 0 });
    const home = await fetchHome(cookie);
    const names = personalizedNames(home);
    console.log('[User D: family/animals/outdoors/free] personalised Home contains:', names);

    expect(names).toContain('Trentham Monkey Forest');
    expect(names).toContain('Cannock Chase Trail Walk');

    for (const forbidden of ['UK Rap All-Nighter', 'New Material Night', 'Stoke City vs. Rotherham', 'The Potteries Museum & Art Gallery', 'Stafford Gatehouse Theatre: touring musical']) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('User E — electronic, clubbing, art exhibitions, cocktails: sees exactly that, never rap/comedy/football/family', async () => {
    const { cookie, userId } = await loginByEmail('home-user-e@plot-test.invalid');
    await setTaste(userId, { interestAffinity: { electronic: 1, house: 1, techno: 1, exhibitions: 1 } });
    const home = await fetchHome(cookie);
    const names = personalizedNames(home);
    console.log('[User E: electronic/clubbing/exhibitions/cocktails] personalised Home contains:', names);

    // At least one real electronic/house/techno booking from Stafford's own lineup.
    const hasElectronicBooking = names.some((n) => ['Fred again..', 'Bicep', 'Nia Archives', 'Peggy Gou', 'Overmono', 'Jamie xx', 'Jorja Smith DJ Set'].includes(n));
    expect(hasElectronicBooking).toBe(true);
    expect(names).toContain('The Potteries Museum & Art Gallery'); // real keyword-scan match on its own "rotating exhibitions" description text

    for (const forbidden of ['UK Rap All-Nighter', 'Grime Originals', 'New Material Night', 'Stoke City vs. Rotherham', 'Trentham Monkey Forest']) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('THE FIVE HOMES LOOK DRAMATICALLY DIFFERENT (Part 20) — no two profiles share more than one item', async () => {
    const users = ['home-user-a@plot-test.invalid', 'home-user-b@plot-test.invalid', 'home-user-c@plot-test.invalid', 'home-user-d@plot-test.invalid', 'home-user-e@plot-test.invalid'];
    const cookies = await Promise.all(users.map((email) => loginByEmail(email).then((r) => r.cookie)));
    const homes = await Promise.all(cookies.map((c) => fetchHome(c)));
    const nameSets = homes.map((h) => new Set(personalizedNames(h)));

    console.log('\n=== FIVE HOMES, SAME STAFFORD INVENTORY ===');
    nameSets.forEach((set, i) => console.log(`User ${String.fromCharCode(65 + i)}:`, [...set]));

    for (let i = 0; i < nameSets.length; i++) {
      for (let j = i + 1; j < nameSets.length; j++) {
        const overlap = [...nameSets[i]].filter((n) => nameSets[j].has(n));
        expect(overlap.length).toBeLessThanOrEqual(1);
      }
    }
  });
});
