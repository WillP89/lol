import { beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';

/**
 * P0-URGENT — five fresh real Crews, hand-tested by the founder against the actual deployed
 * product: three of five failed. Root causes traced from source (see match.ts's own
 * `contradictsCrewInterestPreference`/`lacksRequiredNarrowingEvidence` comments and
 * crewRecommendations.ts's own `isProactivelyEligible` comment):
 *
 *  - "Copper Kettle" — an ordinary, unticketed restaurant whose only action was a Google Maps
 *    link — was proactively sent. The old architecture treated a real ticket as a PREFERENCE
 *    with a fallback to the best-scoring candidate overall. New absolute pilot rule: no ticket,
 *    no proactive send, full stop, whatever else scores.
 *  - "HD — The Mixtape", a hip-hop/rap event, was sent to a Rock + Alternative Rock Crew,
 *    captioned "2/2 of you are into hip hop and rap". Root cause: the old contradiction check
 *    only ever looked at STRONG (provider-subcategory-confirmed) evidence — real provider rows
 *    routinely carry none — so it never fired for evidence that was, at the very same time,
 *    weak-but-real enough to drive a confident personalisation claim via the completely separate
 *    `interest_match` scoring path. This file's fixtures deliberately carry NO subcategories at
 *    all (empty array), mirroring that exact real-provider shape — the bug only reproduces when
 *    the only evidence is in the name/description, never when a test convenience conveniently
 *    tags subcategories for you.
 *  - "The Amy Winehouse Experience", a tribute night with zero genre evidence of any kind, was
 *    sent to a Nightlife + House + UK Garage Crew. Root cause: no STRONG or WEAK evidence existed
 *    to contradict, but "found nothing to contradict" and "genuinely matches what was asked for"
 *    were never the same claim — the candidate won purely on bare category-level admission.
 *
 * Every fixture here mimics genuinely sparse real-provider metadata (empty subcategories, plain
 * English descriptions) rather than hand-tagging the "correct" answer — the whole point of this
 * suite is to prove the fix holds even when the candidate pool looks like real inventory, not a
 * constructed fixture.
 */
const app = buildApp();
const CITY = { city: 'Ticket Gate Test City', lat: 52.8062, lng: -2.1169 };

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

async function setUpMember(email: string): Promise<{ userId: string; cookie: string }> {
  const member = await loginByEmail(email);
  await app.inject({
    method: 'POST',
    url: '/users/me/profile',
    headers: { cookie: member.cookie },
    payload: { displayName: email.split('@')[0], homeCity: CITY.city, homeLat: CITY.lat, homeLng: CITY.lng },
  });
  return member;
}

async function createCrew(ownerCookie: string, name: string): Promise<{ id: string; inviteCode: string }> {
  const res = await app.inject({ method: 'POST', url: '/crews', headers: { cookie: ownerCookie }, payload: { name, defaultCity: CITY.city } });
  return (res.json() as { crew: { id: string; inviteCode: string } }).crew;
}

async function setCrewPreferences(crewId: string, cookie: string, interestPreferences: string[]) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/crews/${crewId}/recommendation-settings`,
    headers: { cookie },
    payload: { interestPreferences, travelRadiusMeters: Math.round(25 * 1609.34) },
  });
  expect(res.statusCode).toBe(200);
}

async function joinCrew(inviteCode: string, cookie: string) {
  const res = await app.inject({ method: 'POST', url: '/crews/join', headers: { cookie }, payload: { inviteCode } });
  expect(res.statusCode).toBe(200);
}

async function seedExperience(opts: {
  name: string;
  category: 'RESTAURANT' | 'LIVE_MUSIC' | 'CLUBBING';
  description: string;
  subcategories?: string[];
  milesAway?: number;
  priceMinMinor?: number | null;
  eventProvider?: string;
}) {
  const venue = await prisma.venue.create({ data: { name: `${opts.name} Venue`, city: CITY.city, latitude: CITY.lat + (opts.milesAway ?? 1) / 69, longitude: CITY.lng } });
  return prisma.experience.create({
    data: {
      canonicalKey: `ticket-gate-${opts.name}-${venue.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
      name: opts.name,
      description: opts.description,
      category: opts.category,
      subcategories: opts.subcategories ?? [],
      venue: { connect: { id: venue.id } },
      startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      qualityScore: 80,
      bookingStatus: 'AVAILABLE',
      priceMinMinor: opts.priceMinMinor ?? null,
      priceMaxMinor: opts.priceMinMinor ? opts.priceMinMinor + 1000 : null,
      tags: opts.eventProvider ? { provider: opts.eventProvider } : {},
    },
  });
}

async function deliveredRecommendation(crewId: string) {
  const rec = await prisma.crewRecommendation.findFirst({ where: { crewId }, orderBy: { createdAt: 'desc' }, include: { experience: { select: { name: true } } } });
  return rec ? { experienceName: rec.experience.name, reasonText: rec.reasonText } : null;
}

describe('P0-URGENT: proactive Plot Found This is TICKETED-ONLY and respects composed Crew intent', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test('"Copper Kettle" class: an ordinary unticketed restaurant is never sent, even as the sole candidate — SEND NOTHING instead', async () => {
    const suffix = Date.now();
    await seedExperience({
      name: `Copper Kettle ${suffix}`,
      category: 'RESTAURANT',
      description: 'A cosy independent café, real ale, home-cooked food, open till late.',
      subcategories: ['italian'],
      milesAway: 1,
      priceMinMinor: null, // no ticket, no price — a Google Maps-only listing
    });

    const owner = await setUpMember(`copper-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`copper-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Copper Kettle Test Crew ${suffix}`);
    await setCrewPreferences(crew.id, owner.cookie, ['food_festivals', 'street_food', 'italian']);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered).toBeNull();
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Copper Kettle'))).toBe(false);
    expect(messages.some((m) => m.body.includes("don't have any"))).toBe(true);
  });

  test('"HD — The Mixtape" class: a weak-evidence-only hip-hop event never wins a Rock + Alternative Rock Crew, even when it is the only close option', async () => {
    const suffix = Date.now();
    // Deliberately NO subcategories — mirrors real Ticketmaster/Skiddle rows with missing genre
    // metadata. The only hip-hop evidence is in the description text.
    await seedExperience({
      name: `HD — The Mixtape ${suffix}`,
      category: 'LIVE_MUSIC',
      description: 'A huge night of hip hop and rap, DJ sets til late, mixtape release party.',
      milesAway: 2,
      priceMinMinor: 1500,
      eventProvider: 'skiddle',
    });
    await seedExperience({
      name: `Northern Rock Night ${suffix}`,
      category: 'LIVE_MUSIC',
      description: 'A real touring alternative rock band, guitars and all.',
      subcategories: ['alternative'],
      milesAway: 18,
      priceMinMinor: 1600,
      eventProvider: 'skiddle',
    });

    const owner = await setUpMember(`rock-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`rock-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Rock Test Crew ${suffix}`);
    await setCrewPreferences(crew.id, owner.cookie, ['live_gigs', 'rock', 'alternative']);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered?.experienceName).not.toBe(`HD — The Mixtape ${suffix}`);
    expect(delivered?.experienceName).toBe(`Northern Rock Night ${suffix}`);
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.toLowerCase().includes('hip hop'))).toBe(false);
  });

  test('"Amy Winehouse Experience" class: a genre-blank ticketed tribute night never wins a Nightlife + House + UK Garage Crew', async () => {
    const suffix = Date.now();
    // Deliberately NO subcategories and no genre words at all — mirrors a real tribute/covers
    // listing with no structured genre data.
    await seedExperience({
      name: `The Amy Winehouse Experience ${suffix}`,
      category: 'CLUBBING',
      description: 'A live tribute band, full bar, dancefloor open till 2am.',
      milesAway: 2,
      priceMinMinor: 1200,
      eventProvider: 'skiddle',
    });
    await seedExperience({
      name: `UK Garage Classics ${suffix}`,
      category: 'CLUBBING',
      description: 'A real UK garage club night, ticketed, guest DJ lineup.',
      subcategories: ['uk_garage'],
      milesAway: 16,
      priceMinMinor: 1200,
      eventProvider: 'skiddle',
    });

    const owner = await setUpMember(`garage-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`garage-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Garage Test Crew ${suffix}`);
    await setCrewPreferences(crew.id, owner.cookie, ['club_nights', 'house', 'uk_garage']);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered?.experienceName).not.toBe(`The Amy Winehouse Experience ${suffix}`);
    expect(delivered?.experienceName).toBe(`UK Garage Classics ${suffix}`);
  });

  test('when the ONLY nearby candidate is unticketed/contradictory/too-broad, guaranteeFirst still sends nothing — never a bypass', async () => {
    const suffix = Date.now();
    // Unticketed AND genre-blank — fails on two independent grounds, and is the sole candidate.
    await seedExperience({
      name: `Generic Pub Night ${suffix}`,
      category: 'CLUBBING',
      description: 'A regular night out, music and drinks.',
      milesAway: 1,
      priceMinMinor: null,
    });

    const owner = await setUpMember(`bypass-owner-${suffix}@plot-test.invalid`);
    const mate = await setUpMember(`bypass-mate-${suffix}@plot-test.invalid`);
    const crew = await createCrew(owner.cookie, `Bypass Test Crew ${suffix}`);
    await setCrewPreferences(crew.id, owner.cookie, ['club_nights', 'house', 'uk_garage']);
    await joinCrew(crew.inviteCode, mate.cookie);
    await new Promise((r) => setTimeout(r, 500));

    const delivered = await deliveredRecommendation(crew.id);
    expect(delivered).toBeNull();
    const messagesRes = await app.inject({ method: 'GET', url: `/crews/${crew.id}/messages`, headers: { cookie: owner.cookie } });
    const { messages } = messagesRes.json() as { messages: { body: string }[] };
    expect(messages.some((m) => m.body.includes('Generic Pub Night'))).toBe(false);
    expect(messages.some((m) => m.body.includes("don't have any"))).toBe(true);
  });
});
