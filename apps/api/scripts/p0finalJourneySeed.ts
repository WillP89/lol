/**
 * P0-FINAL-6 — seeds realistic candidate inventory directly into the REAL DEV DATABASE (not the
 * test DB) for the mandatory Stafford re-runs and the adversarial multi-preference combinations.
 * Run via `npx tsx scripts/p0finalJourneySeed.ts` from apps/api — uses the same DATABASE_URL the
 * live dev server (npm run dev, port 4000) already reads, so a real HTTP/browser journey against
 * that running server sees this exact data.
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
  eventProvider?: string;
}

async function seed(s: Seed, tag: string) {
  const pos = offset(s.miles, s.bearing);
  const venue = await prisma.venue.create({
    data: { name: `${s.name} Venue`, city: 'Stafford', latitude: pos.lat, longitude: pos.lng },
  });
  return prisma.experience.create({
    data: {
      canonicalKey: `p0final-${tag}-${s.name}-${venue.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
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

  // JOURNEY A — FOOD FESTIVALS + STREET FOOD + ITALIAN
  await seed({ name: tagged('The Hidden Chef'), category: 'RESTAURANT', subcategories: ['italian'], description: 'A cosy independent Italian restaurant in the town centre — pasta, wine, the usual.', miles: 1.8, bearing: 40 }, 'a');
  await seed({ name: tagged('Staffordshire Street Food Festival'), category: 'RESTAURANT', subcategories: ['italian', 'street_food'], description: 'A real ticketed street food festival — Italian stalls, live cooking, one weekend only.', miles: 21, bearing: 10, priceMinMinor: 800, eventProvider: 'skiddle' }, 'a');

  // JOURNEY B — LIVE GIGS + ROCK
  await seed({ name: tagged('K-Pop Demons Live'), category: 'LIVE_MUSIC', subcategories: ['k-pop'], description: 'An unmissable live K-pop gig — big vocals, bigger choreography.', miles: 2.6, bearing: 200 }, 'b');
  await seed({ name: tagged('Northern Rock Night'), category: 'LIVE_MUSIC', subcategories: ['rock'], description: 'A real touring rock band, guitars and all.', miles: 19, bearing: 320, priceMinMinor: 1600, eventProvider: 'skiddle' }, 'b');

  // ADVERSARIAL 1 — LIVE GIGS + ALTERNATIVE ROCK + INDIE
  await seed({ name: tagged('Chart Pop Night'), category: 'LIVE_MUSIC', subcategories: ['pop'], description: 'A regular chart-pop covers night at a local venue.', miles: 3.2, bearing: 90 }, 'c');
  await seed({ name: tagged('Indie Alt Showcase'), category: 'LIVE_MUSIC', subcategories: ['indie', 'alternative'], description: 'A real touring indie/alt-rock showcase, three support acts.', miles: 17, bearing: 260, priceMinMinor: 1400, eventProvider: 'skiddle' }, 'c');

  // ADVERSARIAL 2 — NIGHTLIFE + HOUSE + UK GARAGE
  await seed({ name: tagged('Big Room Techno Night'), category: 'CLUBBING', subcategories: ['techno'], description: "One of Stafford's regular techno club nights.", miles: 2.1, bearing: 150 }, 'd');
  await seed({ name: tagged('UK Garage Classics'), category: 'CLUBBING', subcategories: ['uk_garage'], description: 'A real UK garage club night, ticketed, guest DJ lineup.', miles: 16, bearing: 30, priceMinMinor: 1200, eventProvider: 'skiddle' }, 'd');

  // ADVERSARIAL 3 — SPORT + FOOTBALL + CHAMPIONSHIP
  await seed({ name: tagged('County Cricket Day'), category: 'SPORT', subcategories: ['cricket'], description: 'A full day of live cricket, part of the local sporting calendar.', miles: 2.9, bearing: 300 }, 'e');
  await seed({ name: tagged('Championship Derby Day'), category: 'SPORT', subcategories: ['football'], description: 'A real Championship football fixture, home derby.', miles: 15, bearing: 70, priceMinMinor: 2200, eventProvider: 'skiddle' }, 'e');

  // ADVERSARIAL 4 — COMEDY + STAND-UP
  await seed({ name: tagged('Pub Quiz and Open Mic'), category: 'COMEDY', subcategories: [], description: 'A regular open-mic comedy night at a local pub.', miles: 1.5, bearing: 220 }, 'f');
  await seed({ name: tagged('Stand-Up Tour Night'), category: 'COMEDY', subcategories: ['stand_up'], description: 'A real ticketed stand-up comedy tour, headline act.', miles: 18, bearing: 190, priceMinMinor: 1900, eventProvider: 'ticketmaster' }, 'f');

  // ADVERSARIAL 5 — THEATRE + MUSICALS
  await seed({ name: tagged('Community Am-Dram Play'), category: 'THEATRE', subcategories: ['play'], description: 'A local am-dram society performing a classic play.', miles: 2.4, bearing: 80 }, 'g');
  await seed({ name: tagged('West End Musical Tour'), category: 'THEATRE', subcategories: ['musical'], description: 'A real touring West End musical production, ticketed.', miles: 20, bearing: 140, priceMinMinor: 3500, eventProvider: 'ticketmaster' }, 'g');

  // ADVERSARIAL 6 — FOOD FESTIVALS + STREET FOOD (no Italian this time)
  await seed({ name: tagged('The Corner Bistro'), category: 'RESTAURANT', subcategories: [], description: 'A pleasant ordinary local restaurant, no particular occasion.', miles: 1.9, bearing: 260 }, 'h');
  await seed({ name: tagged('Midlands Street Food Market'), category: 'RESTAURANT', subcategories: ['street_food'], description: 'A real one-day street food market, dozens of stalls.', miles: 14, bearing: 100, priceMinMinor: null, eventProvider: 'predicthq' }, 'h');

  console.log('SUFFIX', suffix);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
