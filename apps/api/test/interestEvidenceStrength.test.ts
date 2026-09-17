import { describe, expect, test } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { scoreExperiencesForCrew } from '../src/services/match';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * Real gap this closes, found running a controlled "does specificity survive scoring" audit: a
 * completely untagged, generic "Live Music Night" (no subcategories at all, matched only via a
 * loose name-text keyword scan onto the Crew's own "live gigs" pick) scored IDENTICALLY to a
 * genuinely genre-tagged rock gig (real subcategories: ['rock']) — both satisfied
 * `experienceInterestTags` and both got the exact same flat `crew_interest_preference` bonus.
 * That's a real specificity failure: a provider's own explicit genre classification is much
 * stronger evidence than a coincidental keyword in an event's title, and the score must never
 * claim otherwise. See `tasteSignals.ts#experienceInterestTagsFromSubcategories`'s own comment
 * for the fix — this proves the fix through the real scorer, not just the helper in isolation.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';
const CENTER = { lat: 52.8062, lng: -2.1169, city: 'Evidence Strength Test City' };

async function seedExperience(name: string, subcategories: string[]): Promise<void> {
  const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — a real test fixture.`,
      category: 'LIVE_MUSIC',
      venueName: 'Test Venue',
      city: CENTER.city,
      latitude: CENTER.lat,
      longitude: CENTER.lng,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 2000,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
      subcategories,
    },
  });
  expect(res.statusCode).toBe(201);
}

describe('scoreExperiencesForCrew weighs a real subcategory tag more than a name/description keyword hit', () => {
  test('an untagged event matched only by name text scores lower than a genuinely genre-tagged one, for the same Crew interest pick', async () => {
    await resetDatabase();
    // "Live music" appears in this title, satisfying the 'live_gigs' interest via the broad
    // name-text keyword scan — real, but weak, evidence: no subcategory data at all.
    await seedExperience('Live Music Night', []);
    // A real, provider-shaped genre tag — strong, specific evidence.
    await seedExperience('Riff Radar: Rock Night', ['rock']);

    const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'evidence-owner@plot-test.invalid' } });
    const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
    const token = new URL(devMagicLinkUrl).searchParams.get('token');
    const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
    const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session')!;
    const cookieHeader = `${cookie.name}=${cookie.value}`;

    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: cookieHeader },
      payload: { name: 'Evidence Strength Crew', defaultCity: CENTER.city, latitude: CENTER.lat, longitude: CENTER.lng },
    });
    const { crew } = crewRes.json() as { crew: { id: string } };
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: cookieHeader },
      payload: { categoryPreferences: [], interestPreferences: ['rock', 'live_gigs'], travelRadiusMeters: 40000 },
    });

    const scored = await scoreExperiencesForCrew(crew.id);
    const untagged = scored.find((o) => o.experience.name === 'Live Music Night');
    const tagged = scored.find((o) => o.experience.name === 'Riff Radar: Rock Night');
    expect(untagged).toBeDefined();
    expect(tagged).toBeDefined();
    // The real regression this proves fixed: these used to be equal.
    expect(tagged!.matchScore).toBeGreaterThan(untagged!.matchScore);
    // Both still genuinely reach a Crew that picked "Live gigs"/"Rock" — text-only evidence is
    // weaker, never worthless; the untagged one is still honestly eligible, just ranked lower.
    expect(untagged!.reasons.some((r) => r.code === 'crew_interest_preference')).toBe(true);

    await prisma.experience.deleteMany({ where: { venue: { city: CENTER.city } } });
  });
});
