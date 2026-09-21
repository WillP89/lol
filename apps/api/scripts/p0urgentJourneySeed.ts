/**
 * P0-URGENT — re-run of the exact 5 real Crews the founder hand-tested against the deployed
 * product (Rock, Food, Nightlife, Comedy, Football), seeded with REALISTIC ADVERSARIAL inventory
 * mirroring the exact real failure shapes (weak-evidence-only genre distractors with empty
 * subcategories, unticketed "safe" local candidates, genre-blank tribute nights) rather than
 * hand-picked winners. Seeds directly into the real dev database via Prisma so a real HTTP/
 * browser journey against the already-running dev server sees this exact data.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STAFFORD = { lat: 52.8062, lng: -2.1169 };
const MILE = 1 / 69;

function offset(miles: number, bearingDeg: number) {
  const rad = (bearingDeg * Math.PI) / 180;
  return { lat: STAFFORD.lat + miles * MILE * Math.cos(rad), lng: STAFFORD.lng + miles * MILE * Math.sin(rad) };
}

interface Seed {
  name: string;
  category: string;
  subcategories?: string[];
  description: string;
  miles: number;
  bearing: number;
  priceMinMinor?: number | null;
  eventProvider?: string; // omit for an unticketed/UNKNOWN-source distractor
}

async function seed(s: Seed, tag: string) {
  const pos = offset(s.miles, s.bearing);
  const venue = await prisma.venue.create({ data: { name: `${s.name} Venue`, city: 'Stafford', latitude: pos.lat, longitude: pos.lng } });
  return prisma.experience.create({
    data: {
      canonicalKey: `p0urgent-${tag}-${s.name}-${venue.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
      name: s.name,
      description: s.description,
      category: s.category as never,
      subcategories: s.subcategories ?? [],
      venueId: venue.id,
      startsAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
      qualityScore: 80,
      bookingStatus: 'AVAILABLE',
      priceMinMinor: s.priceMinMinor ?? null,
      priceMaxMinor: s.priceMinMinor ? s.priceMinMinor + 1500 : null,
      tags: s.eventProvider ? { provider: s.eventProvider } : {},
    },
  });
}

async function main() {
  const suffix = Date.now();
  const tagged = (n: string) => `${n} ${suffix}`;

  // ROCK — Live Gigs + Rock + Alternative Rock
  // Distractor mirrors "HD — The Mixtape" exactly: weak-evidence-only hip-hop, no subcategories,
  // genre only in the description text, 2.4mi away.
  await seed({ name: tagged('HD - The Mixtape'), category: 'LIVE_MUSIC', subcategories: [], description: 'A huge night of hip hop and rap, DJ sets til late, mixtape release party.', miles: 2.4, bearing: 40, priceMinMinor: 1200, eventProvider: 'skiddle' }, 'rock');
  await seed({ name: tagged('Northern Rock Night'), category: 'LIVE_MUSIC', subcategories: ['alternative'], description: 'A real touring alternative rock band, guitars and all.', miles: 19, bearing: 320, priceMinMinor: 1600, eventProvider: 'skiddle' }, 'rock');

  // FOOD — Food Festivals + Street Food + Italian
  // Distractor mirrors "Copper Kettle" exactly: ordinary, unticketed, place-provider restaurant.
  await seed({ name: tagged('Copper Kettle'), category: 'RESTAURANT', subcategories: ['italian'], description: 'A cosy independent café, real ale, home-cooked food, open till late.', miles: 1.6, bearing: 100 }, 'food');
  await seed({ name: tagged('Staffordshire Street Food Festival'), category: 'RESTAURANT', subcategories: ['italian', 'street_food'], description: 'A real ticketed street food festival — Italian stalls, live cooking, one weekend only.', miles: 21, bearing: 10, priceMinMinor: 800, eventProvider: 'skiddle' }, 'food');

  // NIGHTLIFE — Nightlife + House + UK Garage
  // Distractor mirrors "The Amy Winehouse Experience" exactly: ticketed, genre-blank tribute act.
  await seed({ name: tagged('The Amy Winehouse Experience'), category: 'CLUBBING', subcategories: [], description: 'A live tribute band, full bar, dancefloor open till 2am.', miles: 2.1, bearing: 150, priceMinMinor: 1200, eventProvider: 'skiddle' }, 'nightlife');
  await seed({ name: tagged('UK Garage Classics'), category: 'CLUBBING', subcategories: ['uk_garage'], description: 'A real UK garage club night, ticketed, guest DJ lineup.', miles: 16, bearing: 30, priceMinMinor: 1200, eventProvider: 'skiddle' }, 'nightlife');

  // COMEDY — Comedy + Stand-up
  // Distractor is a generic, unticketed open-mic — the founder's own COMEDY test was the one
  // journey that already worked; this proves it still does under the new rule.
  await seed({ name: tagged('Pub Quiz and Open Mic'), category: 'COMEDY', subcategories: [], description: 'A regular open-mic comedy night at a local pub.', miles: 1.5, bearing: 220 }, 'comedy');
  await seed({ name: tagged('Funhouse Comedy Club Night'), category: 'COMEDY', subcategories: ['stand_up'], description: 'A real ticketed stand-up comedy club night, touring acts.', miles: 12, bearing: 190, priceMinMinor: 1400, eventProvider: 'skiddle' }, 'comedy');

  // FOOTBALL — Sport + Football + Championship
  // Distractor is a different sport entirely (cricket) — a real narrows:true contradiction.
  await seed({ name: tagged('County Cricket Day'), category: 'SPORT', subcategories: ['cricket'], description: 'A full day of live cricket, part of the local sporting calendar.', miles: 2.9, bearing: 300, priceMinMinor: 1200, eventProvider: 'skiddle' }, 'football');
  await seed({ name: tagged('Championship Derby Day'), category: 'SPORT', subcategories: ['football'], description: 'A real Championship football fixture, home derby.', miles: 15, bearing: 70, priceMinMinor: 2200, eventProvider: 'skiddle' }, 'football');

  console.log('SUFFIX', suffix);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
