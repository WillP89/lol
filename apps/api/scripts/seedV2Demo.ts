/**
 * One-off local seed for V2 design-review screenshots — realistic content (a real crew, real
 * names, a real conversation, a real upcoming plan) instead of empty states, per the brief's
 * "design with realistic content" instruction. Never run against production; this is purely
 * for the local Playwright verification pass. Run: npx tsx scripts/seedV2Demo.ts <alexUserId>
 * (the primary viewer's user id, already created via the normal magic-link flow).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NAMES = ['Priya Shah', 'Tom Ellery', 'Jess Okafor', 'Sam Whitfield', 'Maya Lindqvist', 'Ollie Bramwell'];

async function main() {
  const alexId = process.argv[2];
  if (!alexId) throw new Error('Usage: seedV2Demo.ts <alexUserId>');

  await prisma.user.update({ where: { id: alexId }, data: { displayName: 'Alex Rivera' } });

  const members = [{ id: alexId, name: 'Alex Rivera' }];
  for (const name of NAMES) {
    const email = `${name.toLowerCase().replace(' ', '.')}@plot-demo.invalid`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { displayName: name },
      create: { email, displayName: name, emailVerifiedAt: new Date() },
    });
    members.push({ id: user.id, name });
  }

  const venue = await prisma.venue.upsert({
    where: { id: 'demo-venue-drumsheds' },
    update: {},
    create: { id: 'demo-venue-drumsheds', name: 'Drumsheds', latitude: 51.6042, longitude: -0.0733, city: 'London' },
  });

  const startsAt = new Date();
  startsAt.setHours(startsAt.getHours() + 6, 0, 0, 0);

  const experience = await prisma.experience.upsert({
    where: { canonicalKey: 'demo-fred-again-drumsheds' },
    update: { startsAt },
    create: {
      canonicalKey: 'demo-fred-again-drumsheds',
      name: 'Fred again..',
      description: 'Fred again.. at Drumsheds — an intimate return to the warehouse that made Actual Life.',
      category: 'CLUBBING',
      subcategories: ['house', 'techno'],
      venueId: venue.id,
      startsAt,
      timezone: 'Europe/London',
      priceMinMinor: 4200,
      priceMaxMinor: 8500,
      currency: 'GBP',
      bookingStatus: 'LIMITED',
      imageUrl: null,
      tags: { energy: 'high', crowd: 'mainstream', indoorOutdoor: 'indoor', groupFriendly: true },
    },
  });

  const crew = await prisma.crew.upsert({
    where: { id: 'demo-crew-regulars' },
    update: {},
    create: { id: 'demo-crew-regulars', name: 'The Regulars', createdById: alexId, defaultCity: 'London' },
  });

  for (const m of members) {
    await prisma.crewMember.upsert({
      where: { crewId_userId: { crewId: crew.id, userId: m.id } },
      update: { status: 'ACTIVE' },
      create: { crewId: crew.id, userId: m.id, role: m.id === alexId ? 'OWNER' : 'MEMBER', status: 'ACTIVE' },
    });
  }

  const plan = await prisma.plan.upsert({
    where: { id: 'demo-plan-fred-again' },
    update: { status: 'BOOKED', experienceId: experience.id, title: experience.name },
    create: {
      id: 'demo-plan-fred-again',
      crewId: crew.id,
      experienceId: experience.id,
      title: experience.name,
      status: 'BOOKED',
      proposedByUserId: alexId,
      publicSlug: 'demo-fred-again-drumsheds',
    },
  });

  for (const m of members) {
    await prisma.planMember.upsert({
      where: { planId_userId: { planId: plan.id, userId: m.id } },
      update: {},
      create: { planId: plan.id, userId: m.id },
    });
    if (m.id !== members[members.length - 1].id) {
      await prisma.planVote.upsert({
        where: { planId_userId: { planId: plan.id, userId: m.id } },
        update: { vote: 'IN' },
        create: { planId: plan.id, userId: m.id, vote: 'IN' },
      });
    }
  }

  // Realistic conversation, staggered over the last couple of hours, ending with the plan
  // announcement so Crew chat's rich event-share card actually has something to render.
  await prisma.messageReaction.deleteMany({ where: { message: { crewId: crew.id } } });
  await prisma.crewMessage.deleteMany({ where: { crewId: crew.id } });

  const now = Date.now();
  const convo: { who: number; body: string; minsAgo: number }[] = [
    { who: 1, body: 'ok who is actually free tonight 👀', minsAgo: 130 },
    { who: 2, body: 'me!! been wanting to go out all week', minsAgo: 126 },
    { who: 3, body: 'same, what did we land on', minsAgo: 122 },
    { who: 0, body: 'checking a few options rn', minsAgo: 118 },
    { who: 0, body: '📍 Sent "Fred again.." to the Crew — /plans/demo-fred-again-drumsheds', minsAgo: 96 },
    { who: 4, body: 'OK NOT FAIR i saw the story literally 20 mins ago', minsAgo: 88 },
    { who: 5, body: "I'm so in, tickets left?", minsAgo: 81 },
    { who: 1, body: 'grabbed 6, splitting when we land', minsAgo: 74 },
    { who: 6, body: 'legend. what time we heading down', minsAgo: 52 },
    { who: 0, body: 'doors 8, let’s meet at the tube for 7:30', minsAgo: 40 },
    { who: 2, body: 'perfect, see you all there 🔥', minsAgo: 24 },
  ];

  let lastId: string | null = null;
  for (const c of convo) {
    const created = await prisma.crewMessage.create({
      data: { crewId: crew.id, authorId: members[c.who].id, body: c.body, createdAt: new Date(now - c.minsAgo * 60_000) },
    });
    lastId = created.id;
    if (Math.random() > 0.5) {
      const reactor = members[(c.who + 2) % members.length];
      await prisma.messageReaction.create({ data: { messageId: created.id, userId: reactor.id, emoji: ['🔥', '❤️', '🎉'][Math.floor(Math.random() * 3)] } }).catch(() => {});
    }
  }
  void lastId;

  // A second, smaller Crew purely so Home's "Your Crews" row has more than one tile to prove
  // it's a real scroller, not a single-item list photographed to look like one.
  const uniCrew = await prisma.crew.upsert({
    where: { id: 'demo-crew-uni' },
    update: {},
    create: { id: 'demo-crew-uni', name: 'Uni Crew', createdById: alexId, defaultCity: 'London' },
  });
  for (const m of [members[0], members[2], members[4]]) {
    await prisma.crewMember.upsert({
      where: { crewId_userId: { crewId: uniCrew.id, userId: m.id } },
      update: { status: 'ACTIVE' },
      create: { crewId: uniCrew.id, userId: m.id, role: m.id === alexId ? 'OWNER' : 'MEMBER', status: 'ACTIVE' },
    });
  }
  await prisma.crewMessage.deleteMany({ where: { crewId: uniCrew.id } });
  await prisma.crewMessage.create({
    data: { crewId: uniCrew.id, authorId: members[4].id, body: 'reunion dinner when 👀', createdAt: new Date(now - 200 * 60_000) },
  });

  console.log('Seeded demo crew:', crew.id, 'plan:', plan.publicSlug, 'members:', members.length);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
