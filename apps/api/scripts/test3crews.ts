/**
 * WORKSTREAM 4 MANDATORY PROOF TEST — three Crews, same UK geography (Birmingham), same
 * underlying mock inventory, genuinely different tastes per the brief's own worked example:
 *   Crew A: UK garage/house/live electronic, cocktails, late nights, £30-£70, willing to travel
 *   Crew B: football/Championship/boxing, pubs, stand-up, £15-£40, closer radius
 *   Crew C: Japanese food/food markets/independent cinema/theatre, walking, £20-£60
 * Prints the top-scored candidates per Crew with their real reasons, so the output can be
 * judged by a human for whether it's materially different (not just reordered) and whether the
 * "why" makes sense. Also runs the follow-up tests the brief mandates: a taste change, repeated
 * NOT_MY_THING learning, and repeated MORE_LIKE_THIS learning.
 *
 * Run with: npx tsx scripts/test3crews.ts
 */
import { prisma } from '../src/lib/prisma';
import { syncAllProviders } from '../src/services/inventorySync';
import { scoreExperiencesForCrew } from '../src/services/match';
import { updateSettings } from '../src/services/crewRecommendations';

const CITY = 'Birmingham';
const BHX = { lat: 52.4862, lng: -1.8904 };

interface CrewSpec {
  key: string;
  name: string;
  categoryAffinity: Record<string, number>;
  interestAffinity: Record<string, number>;
  freeText?: string;
  budget: [number, number];
  travelRadiusMeters: number;
  categoryPreferences: string[];
  interestPreferences: string[];
}

const SPECS: CrewSpec[] = [
  {
    key: 'A',
    name: 'TEST Crew A — Electronic/Nightlife',
    categoryAffinity: { CLUBBING: 0.8, LIVE_MUSIC: 0.5, BAR: 0.4 },
    interestAffinity: { uk_garage: 0.9, house: 0.8, electronic: 0.7, dj_sets: 0.7, club_nights: 0.8, cocktail_bars: 0.6, late_night: 0.7 },
    freeText: 'Fred again..',
    budget: [3000, 7000],
    travelRadiusMeters: 40000,
    categoryPreferences: ['CLUBBING'],
    interestPreferences: ['uk_garage', 'house'],
  },
  {
    key: 'B',
    name: 'TEST Crew B — Football/Pubs',
    categoryAffinity: { SPORT: 0.8, BAR: 0.4, COMEDY: 0.4 },
    interestAffinity: { championship_football: 0.85, football: 0.7, boxing: 0.6, watching_big_matches: 0.6, pubs: 0.6, stand_up: 0.5 },
    budget: [1500, 4000],
    travelRadiusMeters: 15000,
    categoryPreferences: ['SPORT'],
    interestPreferences: ['championship_football'],
  },
  {
    key: 'C',
    name: 'TEST Crew C — Food/Culture',
    categoryAffinity: { RESTAURANT: 0.8, CINEMA: 0.5, THEATRE: 0.5, DAY_ACTIVITY: 0.4 },
    interestAffinity: { japanese: 0.85, markets: 0.6, independent_cinema: 0.6, theatre: 0.5, walking: 0.4 },
    budget: [2000, 6000],
    travelRadiusMeters: 20000,
    categoryPreferences: ['RESTAURANT'],
    interestPreferences: ['japanese'],
  },
];

async function makeUser(email: string, displayName: string, spec: CrewSpec, wobble: number) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.profile.upsert({
    where: { userId: user.id },
    update: { homeCity: CITY, homeLat: BHX.lat + wobble, homeLng: BHX.lng + wobble },
    create: { userId: user.id, homeCity: CITY, homeLat: BHX.lat + wobble, homeLng: BHX.lng + wobble },
  });
  const jitter = (v: number) => Math.max(-1, Math.min(1, v + (Math.random() - 0.5) * 0.1));
  const categoryAffinity = Object.fromEntries(Object.entries(spec.categoryAffinity).map(([k, v]) => [k, jitter(v)]));
  const interestAffinity = Object.fromEntries(Object.entries(spec.interestAffinity).map(([k, v]) => [k, jitter(v)]));
  await prisma.tasteProfile.upsert({
    where: { userId: user.id },
    update: {
      categoryAffinity, interestAffinity,
      freeTextSignals: spec.freeText ? [{ text: spec.freeText, matchedInterestIds: [], confidence: 'low', addedAt: new Date().toISOString() }] : [],
      budgetMinMinor: spec.budget[0], budgetMaxMinor: spec.budget[1], travelRadiusMeters: spec.travelRadiusMeters,
    },
    create: {
      userId: user.id, categoryAffinity, interestAffinity,
      freeTextSignals: spec.freeText ? [{ text: spec.freeText, matchedInterestIds: [], confidence: 'low', addedAt: new Date().toISOString() }] : [],
      budgetMinMinor: spec.budget[0], budgetMaxMinor: spec.budget[1], travelRadiusMeters: spec.travelRadiusMeters,
    },
  });
  return user;
}

async function makeCrew(spec: CrewSpec) {
  const u1 = await makeUser(`test-crew-${spec.key.toLowerCase()}-1@plot-test.internal`, `Crew${spec.key} Member 1`, spec, 0.01);
  const u2 = await makeUser(`test-crew-${spec.key.toLowerCase()}-2@plot-test.internal`, `Crew${spec.key} Member 2`, spec, -0.01);

  let crew = await prisma.crew.findFirst({ where: { name: spec.name } });
  if (!crew) {
    crew = await prisma.crew.create({ data: { name: spec.name, defaultCity: CITY, createdById: u1.id } });
  }
  for (const u of [u1, u2]) {
    await prisma.crewMember.upsert({
      where: { crewId_userId: { crewId: crew.id, userId: u.id } },
      update: { status: 'ACTIVE' },
      create: { crewId: crew.id, userId: u.id, status: 'ACTIVE', role: u.id === u1.id ? 'OWNER' : 'MEMBER' },
    });
  }
  await updateSettings(crew.id, { categoryPreferences: spec.categoryPreferences, interestPreferences: spec.interestPreferences });
  return crew;
}

function printTop(label: string, options: Awaited<ReturnType<typeof scoreExperiencesForCrew>>, n = 5) {
  console.log(`\n=== ${label} — top ${n} of ${options.length} scored ===`);
  for (const o of options.slice(0, n)) {
    console.log(`  [${o.matchScore}] ${o.experience.name} (${o.experience.category}) — ${o.reasons.map((r) => r.label).join(' | ')}`);
  }
}

async function main() {
  console.log('Force-syncing full-category inventory for', CITY, '(bypassing the hourly due-check)');
  await syncAllProviders(CITY);

  const crews = [];
  for (const spec of SPECS) {
    const crew = await makeCrew(spec);
    crews.push({ spec, crew });
  }

  const results: Record<string, Awaited<ReturnType<typeof scoreExperiencesForCrew>>> = {};
  for (const { spec, crew } of crews) {
    const scored = await scoreExperiencesForCrew(crew.id);
    results[spec.key] = scored;
    printTop(spec.name, scored);
  }

  // Material-difference check: overlap between each pair's top-5 experience IDs.
  console.log('\n=== Overlap check (top 5 experience IDs) ===');
  for (let i = 0; i < crews.length; i++) {
    for (let j = i + 1; j < crews.length; j++) {
      const a = new Set(results[crews[i].spec.key].slice(0, 5).map((o) => o.experience.id));
      const b = new Set(results[crews[j].spec.key].slice(0, 5).map((o) => o.experience.id));
      const overlap = [...a].filter((id) => b.has(id));
      console.log(`  Crew ${crews[i].spec.key} vs Crew ${crews[j].spec.key}: ${overlap.length}/5 shared`);
    }
  }

  // --- Follow-up test 1: taste change materially changes output (Crew A: nightlife -> outdoors+food) ---
  console.log('\n\n########## FOLLOW-UP TEST: Crew A taste change (nightlife -> outdoors+food) ##########');
  const crewA = crews[0].crew;
  const membersA = await prisma.crewMember.findMany({ where: { crewId: crewA.id, status: 'ACTIVE' } });
  for (const m of membersA) {
    await prisma.tasteProfile.update({
      where: { userId: m.userId },
      data: {
        categoryAffinity: { DAY_ACTIVITY: 0.8, RESTAURANT: 0.6, CLUBBING: -0.5, LIVE_MUSIC: -0.3 },
        interestAffinity: { hiking: 0.8, walking: 0.7, day_trips: 0.7, street_food: 0.6, uk_garage: -0.6, house: -0.6, club_nights: -0.6 },
      },
    });
  }
  const rescoredA = await scoreExperiencesForCrew(crewA.id);
  printTop('Crew A AFTER taste change', rescoredA);
  const beforeIds = new Set(results['A'].slice(0, 5).map((o) => o.experience.id));
  const afterIds = new Set(rescoredA.slice(0, 5).map((o) => o.experience.id));
  const stillOverlap = [...beforeIds].filter((id) => afterIds.has(id));
  console.log(`  Top-5 overlap before/after taste change: ${stillOverlap.length}/5 shared (want low)`);

  // --- Follow-up test 2: repeated NOT_MY_THING reduces similar recs (Crew B on SPORT) ---
  console.log('\n\n########## FOLLOW-UP TEST: Crew B repeated NOT_FOR_US on SPORT ##########');
  const crewB = crews[1].crew;
  const beforeB = await scoreExperiencesForCrew(crewB.id);
  const topSportB = beforeB.find((o) => o.experience.category === 'SPORT');
  console.log('  Top SPORT candidate before feedback:', topSportB ? `[${topSportB.matchScore}] ${topSportB.experience.name}` : 'none scored');
  if (topSportB) {
    for (let i = 0; i < 3; i++) {
      await prisma.crewRecommendation.create({
        data: { crewId: crewB.id, experienceId: topSportB.experience.id, score: topSportB.matchScore, reasonText: 'test seed', status: 'NOT_FOR_US', respondedAt: new Date() },
      });
    }
  }
  const afterB = await scoreExperiencesForCrew(crewB.id);
  const topSportBAfter = afterB.find((o) => o.experience.category === 'SPORT');
  console.log('  Top SPORT candidate after 3x NOT_FOR_US:', topSportBAfter ? `[${topSportBAfter.matchScore}] ${topSportBAfter.experience.name}` : 'none scored (suppressed or excluded)');
  console.log(`  (Same experience is now permanently excluded from re-recommendation; comparing NEXT-best SPORT candidate's score for the category-level bias effect)`);

  // --- Follow-up test 3: repeated MORE_LIKE_THIS strengthens related recs (Crew C on RESTAURANT) ---
  console.log('\n\n########## FOLLOW-UP TEST: Crew C repeated MORE_LIKE_THIS on RESTAURANT/japanese ##########');
  const crewC = crews[2].crew;
  const beforeC = await scoreExperiencesForCrew(crewC.id);
  const someRestaurantC = beforeC.find((o) => o.experience.category === 'RESTAURANT');
  if (someRestaurantC) {
    for (let i = 0; i < 3; i++) {
      await prisma.crewRecommendation.create({
        data: { crewId: crewC.id, experienceId: someRestaurantC.experience.id, score: someRestaurantC.matchScore, reasonText: 'test seed', status: 'MORE_LIKE_THIS', respondedAt: new Date() },
      });
    }
  }
  const afterC = await scoreExperiencesForCrew(crewC.id);
  const otherRestaurantsBefore = beforeC.filter((o) => o.experience.category === 'RESTAURANT' && o.experience.id !== someRestaurantC?.experience.id);
  const otherRestaurantsAfter = afterC.filter((o) => o.experience.category === 'RESTAURANT' && o.experience.id !== someRestaurantC?.experience.id);
  console.log('  Other RESTAURANT candidates before:', otherRestaurantsBefore.map((o) => `${o.matchScore}`).join(', '));
  console.log('  Other RESTAURANT candidates after 3x MORE_LIKE_THIS:', otherRestaurantsAfter.map((o) => `${o.matchScore}`).join(', '));

  console.log('\n\nDone.');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
