/**
 * Real-pipeline baseline audit — NOT a unit test. Runs the actual buildApp()/scoring code
 * in-process against a local Postgres, using app.inject() exactly like the real HTTP API would
 * receive requests. No mocking of match.ts, crewRecommendations.ts, or the taxonomy — every
 * number below comes from actually executing that code.
 *
 * HONEST CONSTRAINT (stated once, applies to everything this script produces): this sandbox has
 * zero live provider credentials (checked apps/api/.env — no TICKETMASTER_API_KEY/SKIDDLE_API_KEY/
 * PREDICTHQ_ACCESS_TOKEN/GOOGLE_PLACES_API_KEY/FOURSQUARE_API_KEY set) and outbound network to
 * every live provider host (Ticketmaster, Skiddle, Overpass, FHRS, Wikipedia, TheSportsDB) is
 * proxy-blocked, confirmed repeatedly this session. This script therefore CANNOT fetch real live
 * provider inventory — that is a hard external blocker, not a choice. What it CAN do, and does,
 * is run the real scoring/filtering/taxonomy pipeline (100% real code) against a controlled,
 * seeded candidate pool, so every Crew is scored against the SAME shared inventory — exactly the
 * "identical inventory, materially different results" methodology the brief itself specifies for
 * this kind of test. Candidates marked (REAL, seen live in production) are the exact names/shapes
 * this session's own live Stafford investigation returned earlier in this conversation, reused
 * here verbatim rather than invented. Candidates marked (representative) are realistic UK-style
 * events for genres that real dataset didn't happen to cover (rock, Japanese food, etc.) —
 * plausible in shape, but NOT claimed to be live-fetched.
 */
import { buildApp } from '../src/app';

const ADMIN_KEY = 'dev_admin_key_change_me';
const CENTER = { lat: 52.8062, lng: -2.1169, city: 'Baseline Audit City' };
// Small jitter so venues aren't literally co-located, but everything stays within ~3 miles —
// radius must never be the variable under test here, only taste/taxonomy.
function near(offsetLat: number, offsetLng: number) {
  return { lat: CENTER.lat + offsetLat, lng: CENTER.lng + offsetLng };
}

const app = buildApp();

async function resetDb() {
  const { resetDatabase } = await import('../test/helpers/resetDb');
  await resetDatabase();
}

async function loginByEmail(email: string): Promise<{ userId: string; cookie: string }> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('no session cookie');
  const { user } = callbackRes.json() as { user: { id: string } };
  return { userId: user.id, cookie: `${cookie.name}=${cookie.value}` };
}

interface SeedSpec {
  name: string;
  category: string;
  subcategories: string[];
  venueName: string;
  offset: [number, number];
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  daysOut: number;
  provenance: 'REAL — observed live in production this session' | 'representative — realistic shape, not live-fetched';
}

const POOL: SeedSpec[] = [
  // ---- Rock / live music (Crew D's own territory) ----
  { name: 'Riff Radar: Rock Night', category: 'LIVE_MUSIC', subcategories: ['rock'], venueName: 'The Sugarmill', offset: [0.01, 0.01], priceMinMinor: 1200, priceMaxMinor: 1800, daysOut: 10, provenance: 'representative — realistic shape, not live-fetched' },
  { name: 'Static Lines: Alternative Rock Live', category: 'LIVE_MUSIC', subcategories: ['alternative rock', 'alt rock'], venueName: 'The Underground', offset: [-0.01, 0.008], priceMinMinor: 1500, priceMaxMinor: 2200, daysOut: 18, provenance: 'representative — realistic shape, not live-fetched' },
  // ---- Electronic / house / UK garage / techno (Crew A's own territory — the direct "does Plot confuse this with rock" test against the two above) ----
  { name: 'Saturn: House All Night', category: 'CLUBBING', subcategories: ['house'], venueName: 'Warehouse 23', offset: [0.006, -0.012], priceMinMinor: 1500, priceMaxMinor: 2500, daysOut: 12, provenance: 'representative — realistic shape, not live-fetched' },
  { name: '2step Sundays: UK Garage Special', category: 'CLUBBING', subcategories: ['uk garage', 'garage'], venueName: 'The Loft', offset: [-0.007, -0.009], priceMinMinor: 1000, priceMaxMinor: 1800, daysOut: 20, provenance: 'representative — realistic shape, not live-fetched' },
  { name: 'Subterrain: Techno Warehouse Session', category: 'CLUBBING', subcategories: ['techno'], venueName: 'Unit 7', offset: [0.009, 0.003], priceMinMinor: 1800, priceMaxMinor: 2800, daysOut: 25, provenance: 'representative — realistic shape, not live-fetched' },
  // ---- Sport (Crew B / Crew E member 1) ----
  { name: 'John Hedges v Pat Brown', category: 'SPORT', subcategories: ['boxing'], venueName: 'Stafford Leisure Centre', offset: [0.003, 0.004], priceMinMinor: 2500, priceMaxMinor: 4500, daysOut: 15, provenance: 'REAL — observed live in production this session' },
  { name: 'Apex Combat Championships', category: 'SPORT', subcategories: ['mma', 'ufc'], venueName: 'Stafford Arena', offset: [-0.004, 0.005], priceMinMinor: 3000, priceMaxMinor: 5000, daysOut: 22, provenance: 'REAL — observed live in production this session' },
  { name: 'Walsall V Rochdale (Championship football)', category: 'SPORT', subcategories: ['championship football', 'championship'], venueName: 'Bescot Stadium', offset: [0.011, -0.006], priceMinMinor: 1800, priceMaxMinor: 3200, daysOut: 8, provenance: 'REAL — observed live in production this session' },
  // ---- Comedy (Crew B / Crew E member 3) ----
  { name: 'Josh Pugh: Ha Ha, Yeah Sound', category: 'COMEDY', subcategories: ['stand-up'], venueName: 'Stafford Gatehouse Theatre', offset: [0.002, 0.007], priceMinMinor: 1500, priceMaxMinor: 2000, daysOut: 14, provenance: 'REAL — observed live in production this session' },
  // ---- Pubs / bars (Crew B / Crew E member 1) ----
  { name: 'Ye Olde Rose & Crown', category: 'BAR', subcategories: ['pub'], venueName: 'Ye Olde Rose & Crown', offset: [0.001, 0.001], priceMinMinor: null, priceMaxMinor: null, daysOut: 5, provenance: 'REAL — observed live in production this session' },
  { name: 'The Empourium', category: 'BAR', subcategories: ['cocktails', 'cocktail bar'], venueName: 'The Empourium', offset: [-0.001, 0.002], priceMinMinor: null, priceMaxMinor: null, daysOut: 6, provenance: 'REAL — observed live in production this session' },
  // ---- Food (Crew C / Crew E member 2) ----
  { name: 'Kissho: Japanese Kitchen', category: 'RESTAURANT', subcategories: ['japanese', 'sushi'], venueName: 'Kissho', offset: [0.004, -0.002], priceMinMinor: 2500, priceMaxMinor: 4500, daysOut: 40, provenance: 'representative — realistic shape, not live-fetched' },
  { name: 'Staffordshire Street Food Festival', category: 'RESTAURANT', subcategories: ['street food', 'food festival'], venueName: 'Victoria Park', offset: [-0.003, -0.004], priceMinMinor: 500, priceMaxMinor: 1500, daysOut: 30, provenance: 'representative — realistic shape, not live-fetched' },
  { name: 'Stafford Artisan Food Market', category: 'RESTAURANT', subcategories: ['market', 'food market'], venueName: 'Market Square', offset: [0.0005, -0.001], priceMinMinor: null, priceMaxMinor: null, daysOut: 9, provenance: 'representative — realistic shape, not live-fetched' },
  // ---- Culture (Crew C / Crew E member 2) ----
  { name: 'The Rep Presents: A New Play', category: 'THEATRE', subcategories: ['theatre'], venueName: 'Stafford Gatehouse Theatre', offset: [0.0015, 0.0025], priceMinMinor: 1800, priceMaxMinor: 3000, daysOut: 28, provenance: 'representative — realistic shape, not live-fetched' },
  { name: 'Flicker Club: Independent Cinema Night', category: 'CINEMA', subcategories: ['independent cinema', 'indie cinema'], venueName: 'The Picture House', offset: [-0.0015, 0.0035], priceMinMinor: 800, priceMaxMinor: 1200, daysOut: 11, provenance: 'representative — realistic shape, not live-fetched' },
  { name: 'Stafford Waterways Walking Tour', category: 'DAY_ACTIVITY', subcategories: ['walking'], venueName: 'Victoria Park', offset: [0.005, 0.0015], priceMinMinor: null, priceMaxMinor: null, daysOut: 4, provenance: 'representative — realistic shape, not live-fetched' },
];

async function seedPool(): Promise<void> {
  for (const s of POOL) {
    const pos = near(...s.offset);
    const startsAt = new Date(Date.now() + s.daysOut * 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/experiences/manual',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: {
        name: s.name,
        description: `${s.name} at ${s.venueName} — a real-shaped test fixture for the baseline audit (${s.provenance}).`,
        category: s.category,
        venueName: s.venueName,
        city: CENTER.city,
        latitude: pos.lat,
        longitude: pos.lng,
        startsAt,
        priceMinMinor: s.priceMinMinor,
        priceMaxMinor: s.priceMaxMinor,
        externalUrl: `https://example.invalid/${encodeURIComponent(s.name)}`,
        subcategories: s.subcategories,
      },
    });
    if (res.statusCode !== 201) {
      console.error('SEED FAILED', s.name, res.statusCode, res.body);
    }
  }
}

interface CrewSpec {
  label: string;
  categoryPreferences: string[];
  interestPreferences: string[];
  travelRadiusMeters: number;
  budgetMinMinor?: number;
  budgetMaxMinor?: number;
  members: string[]; // emails, first is owner
  perMemberInterests?: Record<string, { interestId: string; strength: 'love' | 'like' }[]>; // Crew E only
}

const CREWS: CrewSpec[] = [
  {
    label: 'Crew A — Electronic / Nightlife (UK garage, house, electronic, cocktails, late nights; £30-70; 25-40mi)',
    categoryPreferences: [],
    interestPreferences: ['uk_garage', 'house', 'electronic', 'cocktail_bars', 'late_night'],
    travelRadiusMeters: Math.round(32 * 1609.34),
    budgetMinMinor: 3000,
    budgetMaxMinor: 7000,
    members: ['audit-a-owner@plot-test.invalid', 'audit-a-mate@plot-test.invalid'],
  },
  {
    label: "Crew B — Sport / Comedy (football, championship football, boxing, stand-up, pubs; £15-40; 15-25mi)",
    categoryPreferences: [],
    interestPreferences: ['football', 'championship_football', 'boxing', 'stand_up', 'pubs'],
    travelRadiusMeters: Math.round(20 * 1609.34),
    budgetMinMinor: 1500,
    budgetMaxMinor: 4000,
    members: ['audit-b-owner@plot-test.invalid', 'audit-b-mate@plot-test.invalid'],
  },
  {
    label: 'Crew C — Food / Culture (Japanese, food festivals, food markets, indie cinema, theatre, walking; £20-60; 30mi)',
    categoryPreferences: [],
    interestPreferences: ['japanese', 'food_festivals', 'markets', 'independent_cinema', 'theatre', 'walking'],
    travelRadiusMeters: Math.round(30 * 1609.34),
    budgetMinMinor: 2000,
    budgetMaxMinor: 6000,
    members: ['audit-c-owner@plot-test.invalid', 'audit-c-mate@plot-test.invalid'],
  },
  {
    label: 'Crew D — Rock (rock, alternative, live gigs; explicitly NOT electronic/club nights; £20-70; 40mi)',
    categoryPreferences: [],
    interestPreferences: ['rock', 'alternative', 'live_gigs'],
    travelRadiusMeters: Math.round(40 * 1609.34),
    budgetMinMinor: 2000,
    budgetMaxMinor: 7000,
    members: ['audit-d-owner@plot-test.invalid', 'audit-d-mate@plot-test.invalid'],
  },
  {
    label: 'Crew E — Mixed/conflicted, run 1: NO crew-level preference set at all, purely individual TasteProfile blending (member1: football/pubs/boxing, member2: restaurants/theatre/markets, member3: live music/comedy)',
    categoryPreferences: [],
    interestPreferences: [],
    travelRadiusMeters: Math.round(25 * 1609.34),
    members: ['audit-e-m1@plot-test.invalid', 'audit-e-m2@plot-test.invalid', 'audit-e-m3@plot-test.invalid'],
    perMemberInterests: {
      'audit-e-m1@plot-test.invalid': [{ interestId: 'football', strength: 'love' }, { interestId: 'pubs', strength: 'love' }, { interestId: 'boxing', strength: 'like' }],
      'audit-e-m2@plot-test.invalid': [{ interestId: 'restaurants', strength: 'love' }, { interestId: 'theatre', strength: 'love' }, { interestId: 'markets', strength: 'like' }],
      'audit-e-m3@plot-test.invalid': [{ interestId: 'live_gigs', strength: 'love' }, { interestId: 'stand_up', strength: 'love' }],
    },
  },
  {
    label: 'Crew E2 — same 3 conflicted members, run 2: owner sets an explicit crew-level preference covering the UNION of all three members\' individual picks (tests whether individual taste then differentiates WHICH shared-eligible candidate wins)',
    categoryPreferences: [],
    interestPreferences: ['football', 'pubs', 'boxing', 'restaurants', 'theatre', 'markets', 'live_gigs', 'stand_up'],
    travelRadiusMeters: Math.round(25 * 1609.34),
    members: ['audit-e2-m1@plot-test.invalid', 'audit-e2-m2@plot-test.invalid', 'audit-e2-m3@plot-test.invalid'],
    perMemberInterests: {
      'audit-e2-m1@plot-test.invalid': [{ interestId: 'football', strength: 'love' }, { interestId: 'pubs', strength: 'love' }, { interestId: 'boxing', strength: 'like' }],
      'audit-e2-m2@plot-test.invalid': [{ interestId: 'restaurants', strength: 'love' }, { interestId: 'theatre', strength: 'love' }, { interestId: 'markets', strength: 'like' }],
      'audit-e2-m3@plot-test.invalid': [{ interestId: 'live_gigs', strength: 'love' }, { interestId: 'stand_up', strength: 'love' }],
    },
  },
];

async function runCrew(spec: CrewSpec): Promise<void> {
  console.log(`\n${'='.repeat(100)}\n${spec.label}\n${'='.repeat(100)}`);

  const memberSessions: { userId: string; cookie: string }[] = [];
  for (const email of spec.members) memberSessions.push(await loginByEmail(email));
  const [owner, ...rest] = memberSessions;

  const createRes = await app.inject({
    method: 'POST',
    url: '/crews',
    headers: { cookie: owner.cookie },
    payload: { name: spec.label.split(' — ')[0], defaultCity: CENTER.city, latitude: CENTER.lat, longitude: CENTER.lng },
  });
  const { crew } = createRes.json() as { crew: { id: string; inviteCode: string } };

  if (spec.interestPreferences.length > 0 || spec.categoryPreferences.length > 0) {
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: spec.categoryPreferences, interestPreferences: spec.interestPreferences, travelRadiusMeters: spec.travelRadiusMeters },
    });
  } else {
    // Crew E: no crew-level pick, but we still need SOME settings row + radius so eligibility
    // proceeds past preferences_not_set — travel radius only, no category/interest gate.
    await app.inject({
      method: 'PATCH',
      url: `/crews/${crew.id}/recommendation-settings`,
      headers: { cookie: owner.cookie },
      payload: { categoryPreferences: [], interestPreferences: [], travelRadiusMeters: spec.travelRadiusMeters },
    });
  }

  // Per-member individual taste (Crew E) — written BEFORE anyone joins, so it's already present
  // when the join-triggered guaranteedFirst check runs.
  if (spec.perMemberInterests) {
    for (const session of memberSessions) {
      const updates = spec.perMemberInterests[spec.members[memberSessions.indexOf(session)]];
      if (!updates) continue;
      await app.inject({ method: 'POST', url: '/users/me/taste/interests', headers: { cookie: session.cookie }, payload: { updates } });
    }
  }

  for (const mate of rest) {
    await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie: mate.cookie }, payload: { inviteCode: crew.inviteCode } });
  }
  await new Promise((resolve) => setTimeout(resolve, 400));

  const explainRes = await app.inject({ method: 'GET', url: `/admin/crews/${crew.id}/explain-recommendation`, headers: { 'x-admin-key': ADMIN_KEY } });
  const explain = explainRes.json() as Record<string, unknown>;

  console.log(`outcome: ${explain.outcome}`);
  console.log(`totalScored: ${explain.totalScored} | afterDedup: ${explain.afterDedup} | afterRadius: ${explain.afterRadius} | afterTasteSignal: ${explain.afterTasteSignal}`);
  console.log(`bestScoreSeen: ${explain.bestScoreSeen} | scoreThreshold: ${explain.scoreThreshold}`);
  if (explain.bestCandidate) console.log('bestCandidate:', explain.bestCandidate);

  const candidates = (explain.topCandidates as Array<Record<string, unknown>> | undefined) ?? [];
  console.log(`\nTop candidates considered (${candidates.length}):`);
  for (const c of candidates) {
    const reasons = (c.reasons as Array<{ label: string }> | undefined)?.map((r) => r.label).join(', ') ?? '';
    const rejections = (c.rejectionReasons as string[] | undefined)?.join(', ') ?? '';
    console.log(`  [${c.eligible ? 'ELIGIBLE ' : 'rejected '}] score=${c.matchScore} ${c.title} (${c.category}) ${c.eligible ? `— ${reasons}` : `— ${rejections}`}`);
  }

  // Check messages for what was actually delivered.
  const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
  const { messages } = messagesRes.json() as { messages: { body: string }[] };
  const announcement = messages.find((m) => m.body.includes(' — /plans/'));
  console.log(`\nActually delivered to Crew chat: ${announcement ? announcement.body.split('\n')[0] : '(nothing delivered)'}`);

  // The explain call above lands AFTER delivery (too_soon, no scoring fields) whenever the
  // join-triggered guaranteedFirst check already fired — pull the real delivered row's own
  // score/category/status from the same source /admin/recommendations/recent reads.
  const recentRes = await app.inject({ method: 'GET', url: '/admin/recommendations/recent?limit=50', headers: { 'x-admin-key': ADMIN_KEY } });
  const { recommendations } = recentRes.json() as { recommendations: Array<{ crewId: string; experienceName: string | null; category: string | null; score: number; status: string; createdAt: string }> };
  const own = recommendations.filter((r) => r.crewId === crew.id);
  if (own.length > 0) {
    console.log(`\nReal CrewRecommendation row(s) for this Crew:`);
    for (const r of own) console.log(`  ${r.experienceName} (${r.category}) — score ${r.score} — status ${r.status}`);
  }
}

async function main() {
  await resetDb();
  await seedPool();
  console.log(`Seeded ${POOL.length} candidates (${POOL.filter((p) => p.provenance.startsWith('REAL')).length} real-observed, ${POOL.filter((p) => !p.provenance.startsWith('REAL')).length} representative), all within ~3mi of ${CENTER.city}.`);
  for (const crew of CREWS) {
    await runCrew(crew);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
