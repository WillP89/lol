import { describe, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

// Same mock shape as missingImageBackfill.test.ts's own header — proves
// enrichMissingImageForExperience (crewRecommendations.ts's new synchronous call, see its own
// comment) without touching the real network.
vi.mock('../src/lib/imageEnrichment', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/imageEnrichment')>('../src/lib/imageEnrichment');
  return { ...actual, enrichImageFromTheSportsDb: vi.fn(async () => null), enrichImageFromWikipedia: vi.fn(async () => null) };
});
vi.mock('../src/lib/categoryStockImages', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/categoryStockImages')>('../src/lib/categoryStockImages');
  return {
    ...actual,
    getCategoryStockImage: vi.fn(async (category: string) => (category === 'COMEDY' ? { url: 'https://upload.wikimedia.org/comedy-stock.jpg', sourcePage: 'File:Comedy.jpg' } : null)),
  };
});
vi.mock('../src/lib/pexelsStockImages', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/pexelsStockImages')>('../src/lib/pexelsStockImages');
  return { ...actual, getPexelsStockImage: vi.fn(async () => null) };
});

/**
 * "still no live feed pulling through into new crews created, it should immediately hit them
 * with at LEAST 1 event line with the preferences" — the exact live request this proves. The
 * immediate 1->2-member join trigger (routes/crews.ts) now guarantees a first delivery whenever
 * ANY real, in-radius, quality-checked candidate exists — even when neither member has swiped
 * enough yet for real category-affinity/DNA signal, which the periodic sweep still correctly
 * requires (see crewCategoryPreferences.test.ts for that path proven in isolation). The
 * candidate pool itself is never relaxed: this proves delivery of a REAL seeded experience, not
 * a fabricated one, and that the periodic sweep's own confidence bar is untouched elsewhere.
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

async function setUpMemberNoTaste(email: string): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
  });
  // Deliberately NO /users/me/taste call — a genuinely fresh member with zero swipe history,
  // the exact real-world case this guarantee exists for ("members haven't swiped enough yet").
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
      city: STAFFORD.city,
      latitude: STAFFORD.lat,
      longitude: STAFFORD.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience;
}

describe('guaranteed first recommendation: a brand-new Crew never comes up empty when real inventory exists', () => {
  test('two members with zero taste signal still get an immediate event the moment the Crew forms', async () => {
    await resetDatabase();
    await seedExperience('Stafford Open Mic Comedy', 'COMEDY', 'The Sugarmill');

    const owner = await setUpMemberNoTaste('guarantee-owner@plot-test.invalid');
    const mate = await setUpMemberNoTaste('guarantee-mate@plot-test.invalid');
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Guarantee Test Crew', defaultCity: STAFFORD.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    // Real, live product requirement: "no events or things should be done on crew until
    // preference set" — the creator sets the Crew's own preferences before the second member
    // joins, same as the New Crew flow's mandatory 'taste' step now requires. Without this, the
    // guarantee below wouldn't fire at all (evaluateCrewEligibility's preferences_not_set gate).
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['COMEDY'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500)); // let the fire-and-forget immediate trigger settle

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes('Plot found something'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('Stafford Open Mic Comedy');
  });

  /**
   * Real, live-reported bug: "I just created a crew, I did not select comedy as a preference, at
   * ALL. The first event Plot sent into that crew, was a comedy event... you have ONE shot to
   * make a good impression, DO NOT waste it on something that crew doesn't care about." The
   * guarantee's own fallback used to sort from EVERY in-radius candidate (`inRadius`), not just
   * taste-matched ones (`withTaste`) — so a taste-blind event could out-score a real
   * taste-matched one on logistics alone (price/distance/freshness) and win the Crew's very
   * first, highest-stakes recommendation. Both events here share an identical logistics profile
   * (same price band, same venue coordinates, same date) so the ONLY thing that can decide the
   * winner is the +20 crew_preference bonus the LIVE_MUSIC one gets and the COMEDY one doesn't —
   * a fair, deterministic proof that taste now wins over logistics for this guarantee, not a
   * coincidence of one candidate happening to be cheaper or closer.
   */
  test('never sends an untailored event when a real taste-matched one also exists — the "one shot" bug', async () => {
    await resetDatabase();
    const SAME_VENUE = 'The Sugarmill';
    const SAME_STARTS_AT = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    async function seedTwin(name: string, category: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/experiences/manual',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: {
          name,
          description: `${name} — a real test fixture with enough description to pass quality scoring.`,
          category,
          venueName: SAME_VENUE,
          city: STAFFORD.city,
          latitude: STAFFORD.lat,
          longitude: STAFFORD.lng,
          startsAt: SAME_STARTS_AT,
          priceMinMinor: 1500,
          priceMaxMinor: 3000,
          externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
        },
      });
      expect(res.statusCode).toBe(201);
    }
    await seedTwin('Untailored Comedy Night', 'COMEDY');
    await seedTwin('The Crew\'s Actual Preference Gig', 'LIVE_MUSIC');

    const owner = await setUpMemberNoTaste('oneshot-owner@plot-test.invalid');
    const mate = await setUpMemberNoTaste('oneshot-mate@plot-test.invalid');
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'One Shot Test Crew', defaultCity: STAFFORD.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    // The Crew explicitly selects LIVE_MUSIC only — comedy is never chosen, at all.
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['LIVE_MUSIC'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    const announcement = messages.find((m) => m.body.includes('Plot found something'));
    expect(announcement).toBeDefined();
    expect(announcement!.body).toContain('The Crew\'s Actual Preference Gig');
    expect(announcement!.body).not.toContain('Untailored Comedy Night');
  });

  /**
   * Real, live-reported bug: "I just created a crew... STOCK IMAGES" — a first Plot
   * recommendation could land on a freshly-synced Experience that hadn't had its turn in the
   * periodic missing-image backfill sweep yet (up to 6 hours away — see server.ts), so the
   * single most scrutinised card in the product rendered the generic fallback graphic instead of
   * a real photo. generateRecommendationForCrew now runs the same enrichment chain synchronously,
   * right before delivery, for exactly the chosen experience — proven here end-to-end through the
   * real crew-join trigger, not by calling the enrichment function directly.
   */
  test('a delivered first recommendation gets a real photo synchronously, not just on the next sweep', async () => {
    await resetDatabase();
    await seedExperience('Stock Image Bug Comedy Night', 'COMEDY', 'The Sugarmill');

    const owner = await setUpMemberNoTaste('imagefix-owner@plot-test.invalid');
    const mate = await setUpMemberNoTaste('imagefix-mate@plot-test.invalid');
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Image Fix Test Crew', defaultCity: STAFFORD.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['COMEDY'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { prisma } = await import('../src/lib/prisma');
    const row = await prisma.experience.findFirst({ where: { name: 'Stock Image Bug Comedy Night' } });
    expect(row!.imageUrl).toBe('https://upload.wikimedia.org/comedy-stock.jpg');
    expect(row!.imageSource).toBe('CATEGORY_STOCK');
  });

  test('genuinely zero candidates (nothing in radius) still honestly delivers nothing — never fabricated', async () => {
    await resetDatabase();
    // No experience seeded at all this time — and Truro has no coverage in any of the three
    // mock providers' own CITY_* maps (see providers/mock/{ticketingProvider,restaurantProvider,
    // activityProvider}.ts), unlike Stafford/Stone/Stoke/Cannock/London/Birmingham, so this is
    // genuinely, honestly empty rather than accidentally picking up sample data.
    const owner = await setUpMemberNoTaste('guarantee-empty-owner@plot-test.invalid');
    const mate = await setUpMemberNoTaste('guarantee-empty-mate@plot-test.invalid');
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Guarantee Empty Crew', defaultCity: 'Truro' } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    // Preferences set, same as the other test — isolating what this test actually checks (a
    // genuinely empty candidate pool), not the separate preferences_not_set gate.
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: ['COMEDY'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Plot found something'))).toBe(false);
  });
});
