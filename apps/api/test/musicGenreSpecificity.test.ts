import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * THE most severe live-reported bug in this whole line: "a user who likes DRILL is being shown
 * SAM SMITH with the explanation 'because you're into drill'." Root cause: `music` bundles
 * roughly thirty genuinely distinct, often mutually-exclusive genres under LIVE_MUSIC/FESTIVAL —
 * the "any positive interest implies its whole territory's categories" shortcut every other
 * territory safely relies on (UNAMBIGUOUS_CATEGORIES) is uniquely dangerous here, since it
 * granted a bare LIVE_MUSIC event to ANYONE with ANY positive music interest, genre completely
 * ignored. Fixed via @plot/shared's TERRITORIES_REQUIRING_EXPLICIT_RELATION (currently just
 * `music`) + RELATED_INTERESTS (a small, curated, real sibling-genre map — drill/grime,
 * hip_hop/rnb) — bare category membership is never enough for these territories; only a literal
 * textual match to a genuinely, specifically related genre grants eligibility.
 *
 * Covers the exact worked examples the live directive itself specifies: a drill preference must
 * never make an unrelated pop artist eligible (and must never caption one "because you're into
 * drill"), but must still find a genuine, closely-related grime event even when the event's own
 * text never says "drill" — the same honest specificity, not a wider net.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
const STAFFORD = { city: 'Stafford', lat: 52.8062, lng: -2.1169 };
// Zero mock-provider coverage anywhere in its local-area radius (same isolation precedent as
// crewCategoryPreferences.test.ts's own use of Truro) — needed for the "genuinely under-covered
// interest" test below, since Stafford's own real mock ticketing inventory happens to already
// include a literal "Drill Showcase Night" fixture that would otherwise satisfy `drill` directly
// and mask the fallback this test exists to prove.
const TRURO = { city: 'Truro', lat: 50.2632, lng: -5.051 };

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

async function seedExperience(
  name: string,
  category: string,
  subcategories: string[],
  description?: string,
  location: { city: string; lat: number; lng: number } = STAFFORD,
) {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: description ?? `${name} — a real test fixture with enough description to pass quality scoring.`,
      category,
      subcategories,
      venueName: 'Genre Specificity Test Venue',
      city: location.city,
      latitude: location.lat,
      longitude: location.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 3000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { experience: { id: string } }).experience;
}

interface HomeResponse {
  forYou: { experience: { name: string }; reasons: { code: string; label: string }[] }[];
}

describe('a specific music genre preference never implies the whole of "music"', () => {
  test('THE regression: a drill preference never makes Sam Smith eligible, and never says "because you\'re into drill"', async () => {
    await resetDatabase();
    // Real Sam Smith event shape: LIVE_MUSIC, pop/soul genre text, zero drill/grime wording
    // anywhere — exactly what made the old bare-category fallback wrong.
    await seedExperience(
      'Sam Smith: Live in Concert',
      'LIVE_MUSIC',
      ['pop'],
      'Sam Smith: Live in Concert — an evening of soulful pop hits from the multi-platinum artist.',
    );

    const owner = await loginByEmail('drill-samsmith@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: owner.cookie },
      payload: { displayName: 'drill-fan', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie: owner.cookie },
      payload: { updates: [{ interestId: 'drill', strength: 'love' }] },
    });

    const res = await app.inject({ method: 'GET', url: '/home/personalized', headers: { cookie: owner.cookie } });
    const home = res.json() as HomeResponse;
    expect(home.forYou.some((s) => s.experience.name === 'Sam Smith: Live in Concert')).toBe(false);
    // Belt and braces: even if it somehow appeared, it must never be captioned as a drill match.
    for (const item of home.forYou) {
      if (item.experience.name === 'Sam Smith: Live in Concert') {
        expect(item.reasons.some((r) => r.label.toLowerCase().includes('drill'))).toBe(false);
      }
    }
  });

  test('a genuinely related genre (grime) is still found for a drill preference, even with zero literal "drill" wording', async () => {
    await resetDatabase();
    await seedExperience(
      'Mr Traumatik: Homecoming Tour',
      'LIVE_MUSIC',
      ['grime'],
      'Mr Traumatik: Homecoming Tour — a grime showcase featuring the UK scene\'s rising MCs.',
      TRURO,
    );

    const owner = await loginByEmail('drill-grime@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: owner.cookie },
      payload: { displayName: 'drill-fan-2', homeCity: TRURO.city, homeLat: TRURO.lat, homeLng: TRURO.lng },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/taste/interests',
      headers: { cookie: owner.cookie },
      payload: { updates: [{ interestId: 'drill', strength: 'love' }] },
    });

    const res = await app.inject({ method: 'GET', url: '/home/personalized', headers: { cookie: owner.cookie } });
    const home = res.json() as HomeResponse;
    const match = home.forYou.find((s) => s.experience.name === 'Mr Traumatik: Homecoming Tour');
    expect(match).toBeDefined();
    // Honest reason: names the actual preference the relation traces back to (drill) — never a
    // vague "matches your taste" or a claim the event is literally about drill.
    expect(match!.reasons.some((r) => r.code === 'interest_match')).toBe(true);
  });

  test('the same drill/Sam Smith distinction holds for Crew recommendations, not just Home', async () => {
    await resetDatabase();
    await seedExperience(
      'Sam Smith: Live in Concert',
      'LIVE_MUSIC',
      ['pop'],
      'Sam Smith: Live in Concert — an evening of soulful pop hits from the multi-platinum artist.',
    );

    const owner = await loginByEmail('crew-drill-owner@plot-test.invalid');
    const mate = await loginByEmail('crew-drill-mate@plot-test.invalid');
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: owner.cookie },
      payload: { displayName: 'owner', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    await app.inject({
      method: 'POST',
      url: '/users/me/profile',
      headers: { cookie: mate.cookie },
      payload: { displayName: 'mate', homeCity: STAFFORD.city, homeLat: STAFFORD.lat, homeLng: STAFFORD.lng },
    });
    const crewRes = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: owner.cookie }, payload: { name: 'Drill Crew', defaultCity: STAFFORD.city } });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { interestPreferences: ['drill'] },
    });
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Sam Smith'))).toBe(false);
    const honestMessage = messages.find((m) => m.body.includes("don't have any"));
    expect(honestMessage).toBeDefined();
    expect(honestMessage!.body.toLowerCase()).toContain('drill');
  });
});
