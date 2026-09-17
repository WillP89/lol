/**
 * Direct test of match.ts#scoreExperiencesForCrew's real scoring function (imported and called
 * directly — not via HTTP, so no "too_soon" masking and the full ranked list with reasons is
 * visible). Tests the user's own worked example: does increasing specificity actually produce
 * increasing scores, or does the scorer treat "generic live music" / "rock gig" / "alternative
 * rock gig" / "an artist they explicitly love" as roughly equivalent?
 */
import { prisma } from '../src/lib/prisma';
import { scoreExperiencesForCrew } from '../src/services/match';

const ADMIN_KEY = 'dev_admin_key_change_me';
const CENTER = { lat: 52.8062, lng: -2.1169, city: 'Specificity Audit City' };

async function seed(name: string, subcategories: string[], daysOut: number) {
  const { buildApp } = await import('../src/app');
  const app = buildApp();
  const startsAt = new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000).toISOString();
  const res = await app.inject({
    method: 'POST',
    url: '/admin/experiences/manual',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      description: `${name} — real specificity-ladder test fixture.`,
      category: 'LIVE_MUSIC',
      venueName: 'The Sugarmill',
      city: CENTER.city,
      latitude: CENTER.lat + Math.random() * 0.01,
      longitude: CENTER.lng + Math.random() * 0.01,
      startsAt,
      priceMinMinor: 1500,
      priceMaxMinor: 2500,
      externalUrl: `https://example.invalid/${encodeURIComponent(name)}`,
      subcategories,
    },
  });
  return (res.json() as { experience: { id: string } }).experience.id;
}

async function main() {
  const { resetDatabase } = await import('../test/helpers/resetDb');
  await resetDatabase();
  const { buildApp } = await import('../src/app');
  const app = buildApp();

  // Rung 1: generic live music, no genre tag at all.
  await seed('Live Music Night (untagged)', [], 5);
  // Rung 2: tagged rock, but not "alternative" specifically.
  await seed('Riff Radar: Rock Night', ['rock'], 6);
  // Rung 3: tagged alternative rock — the Crew's own more specific pick.
  await seed('Static Lines: Alternative Rock Live', ['alternative rock', 'alt rock'], 7);
  // Rung 4: a specific artist the Crew has explicitly said they love, via free text — matches
  // the user's own worked example ("Foo Fighters", "Queens of the Stone Age").
  await seed('Foo Fighters Tribute: Everlong Live', ['alternative rock', 'rock'], 8);

  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'specificity-owner@plot-test.invalid' } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session')!;
  const cookieHeader = `${cookie.name}=${cookie.value}`;

  const createRes = await app.inject({
    method: 'POST',
    url: '/crews',
    headers: { cookie: cookieHeader },
    payload: { name: 'Specificity Test Crew', defaultCity: CENTER.city, latitude: CENTER.lat, longitude: CENTER.lng },
  });
  const { crew } = createRes.json() as { crew: { id: string } };
  await app.inject({
    method: 'PATCH',
    url: `/crews/${crew.id}/recommendation-settings`,
    headers: { cookie: cookieHeader },
    payload: { categoryPreferences: [], interestPreferences: ['rock', 'alternative', 'live_gigs'], travelRadiusMeters: 40000 },
  });
  // Rung 4's real distinguishing signal: a member who has explicitly told Plot (via free-text,
  // exactly the "Fred again.." mechanism this codebase already has) that they love this exact
  // artist — the strongest, most specific signal the taxonomy can carry.
  await app.inject({ method: 'POST', url: '/users/me/taste/free-text', headers: { cookie: cookieHeader }, payload: { text: 'Foo Fighters' } });

  const scored = await scoreExperiencesForCrew(crew.id);
  console.log('\nRanked results (real scorer, real reasons, no HTTP layer):');
  for (const o of scored) {
    console.log(`  score=${o.matchScore}\t${o.experience.name}\t[${o.reasons.map((r) => r.code).join(', ')}]`);
    for (const r of o.reasons) console.log(`         - ${r.label}`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
