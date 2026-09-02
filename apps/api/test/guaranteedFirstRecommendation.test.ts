import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

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
