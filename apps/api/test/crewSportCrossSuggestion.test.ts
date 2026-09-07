import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real, live-reported ask (same session as the SPORT/boxing/MMA investigation this whole line of
 * fixes traces back to): "if there's a boxing event, and the user has selected MMA, suggest it to
 * them" — but honestly, not by silently blending it into the whole SPORT category the way
 * `categoriesImpliedByInterests` used to. The SAME class of bug as "I love drill" -> Sam Smith,
 * just for sport: naming a SPECIFIC crew interest ("Matches your Crew's Boxing preference") on a
 * candidate whose own real text gave zero evidence for it. Fixed the same way as music — only via
 * `RELATED_INTERESTS`' real, curated sibling relationship (boxing<->mma), and only when the
 * candidate's own literal genre/subcategory text actually supports the sibling being suggested;
 * with no textual evidence for anything specific at all, the label is honestly generic
 * ("Matches your Crew's Sport interests") rather than naming an unsupported specific interest.
 * `sport` itself deliberately stays a normal category-implication territory (unlike music) — see
 * match.ts's own comment on this exact branch for why eligibility is unaffected, only the CLAIM.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
const TEST_CITY = { city: 'Truro', lat: 50.2632, lng: -5.051 }; // zero mock coverage — isolates this test from any real Birmingham/Stafford mock fixtures

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

async function seedExperience(name: string, subcategories: string[]) {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture with enough description to pass quality scoring.`,
      category: 'SPORT',
      subcategories,
      venueName: 'Sport Cross-Suggestion Test Venue',
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

async function createMmaCrew(ownerEmail: string, mateEmail: string): Promise<string> {
  const owner = await loginByEmail(ownerEmail);
  const mate = await loginByEmail(mateEmail);
  const crewRes = await app.inject({
    method: 'POST',
    url: '/crews',
    headers: { cookie: owner.cookie },
    payload: { name: 'MMA Crew', defaultCity: TEST_CITY.city, latitude: TEST_CITY.lat, longitude: TEST_CITY.lng },
  });
  const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
  await app.inject({
    method: 'PATCH',
    url: `/crews/${crew.id}/recommendation-settings`,
    headers: { cookie: owner.cookie },
    payload: { interestPreferences: ['mma'] },
  });
  await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  return crew.id;
}

interface FindResult {
  options: { experience: { id: string; name: string }; matchScore: number; reasons: { code: string; label: string }[] }[];
}

describe('a Crew that picked MMA only, shown a real Boxing event, gets an honest cross-suggestion', () => {
  test('a literally-tagged Boxing event is suggested with a label naming BOTH what was picked and what it actually is', async () => {
    await resetDatabase();
    await seedExperience('Fight Night at the Arena', ['boxing']); // real genre tag, no literal "mma" anywhere

    const crewId = await createMmaCrew('sport-cross-owner@plot-test.invalid', 'sport-cross-mate@plot-test.invalid');
    const owner = await loginByEmail('sport-cross-owner@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as FindResult;
    const match = options.find((o) => o.experience.name === 'Fight Night at the Arena');
    expect(match).toBeDefined();
    const reason = match!.reasons.find((r) => r.code === 'crew_interest_preference');
    expect(reason).toBeDefined();
    // Honest, specific, and never claims the event IS what the Crew picked — names both.
    expect(reason!.label.toLowerCase()).toContain('mma');
    expect(reason!.label.toLowerCase()).toContain('boxing');
    expect(reason!.label.toLowerCase()).toContain('closely related');
  });

  test('a SPORT event with zero literal wording still shows (the safety net holds), but is never falsely captioned as MMA specifically', async () => {
    await resetDatabase();
    await seedExperience('Friday Night Under the Lights', []); // deliberately no genre/subcategory text at all

    const crewId = await createMmaCrew('sport-cross-generic-owner@plot-test.invalid', 'sport-cross-generic-mate@plot-test.invalid');
    const owner = await loginByEmail('sport-cross-generic-owner@plot-test.invalid');
    const res = await app.inject({ method: 'POST', url: `/crews/${crewId}/find-us-something`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(200);
    const { options } = res.json() as FindResult;
    const match = options.find((o) => o.experience.name === 'Friday Night Under the Lights');
    expect(match).toBeDefined(); // eligibility is unchanged — this is the exact safety net crewImpliedInterestScoring.test.ts proves
    const reason = match!.reasons.find((r) => r.code === 'crew_interest_preference');
    expect(reason).toBeDefined();
    // Honest and generic — never claims this unrelated-text event specifically IS MMA.
    expect(reason!.label).not.toMatch(/mma/i);
    expect(reason!.label.toLowerCase()).toContain('sport');
  });
});
