import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { prisma } from '../src/lib/prisma';
import { applyHomeFeedback } from '../src/services/personalHome';

/**
 * Part 18's own requirement, proven directly against the real function rather than asserted:
 * "feedback must actually change the feed" — a tap on a Home card has to really nudge THIS
 * person's own TasteProfile (never a Crew's — see personalHome.ts's own header), bounded, and
 * a bare PASS must be visibly weaker than an explicit NOT_FOR_ME (Part 18: "a PASS should not
 * mean the user hates the category forever").
 */
const app = buildApp();

async function loginByEmail(email: string): Promise<string> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session');
  if (!cookie) throw new Error('No session cookie returned from /auth/callback');
  const me = await app.inject({ method: 'GET', url: '/users/me', headers: { cookie: `${cookie.name}=${cookie.value}` } });
  return (me.json() as { user: { id: string } }).user.id;
}

describe('Home feedback actually changes the taste profile it reads from', () => {
  let userId = '';
  let experienceId = '';

  beforeAll(async () => {
    await resetDatabase();
    userId = await loginByEmail('home-feedback@plot-test.invalid');
    const venue = await prisma.venue.create({ data: { name: 'Test Venue', city: 'Stafford', latitude: 52.8, longitude: -2.1 } });
    const experience = await prisma.experience.create({
      data: {
        canonicalKey: 'test-feedback-experience',
        name: 'Test Grime Night',
        description: 'A test grime night.',
        category: 'LIVE_MUSIC',
        subcategories: ['grime'],
        venueId: venue.id,
        startsAt: new Date(Date.now() + 86_400_000),
        qualityScore: 80,
        bookingStatus: 'AVAILABLE',
        tags: {},
      },
    });
    experienceId = experience.id;
  });

  test('a "not_for_me" tap gives a real, bounded negative nudge to the matched category AND interest tag', async () => {
    await applyHomeFeedback(userId, experienceId, 'not_for_me');
    const profile = await prisma.tasteProfile.findUnique({ where: { userId } });
    const categoryAffinity = profile?.categoryAffinity as Record<string, number>;
    const interestAffinity = profile?.interestAffinity as Record<string, number>;
    expect(categoryAffinity.live_music).toBeCloseTo(-0.35, 5);
    expect(interestAffinity.grime).toBeCloseTo(-0.35, 5);
  });

  test('a bare "pass" nudges far more weakly than "not_for_me" did — a dismissal is not a rejection', async () => {
    await prisma.tasteProfile.update({ where: { userId }, data: { categoryAffinity: {}, interestAffinity: {} } });
    await applyHomeFeedback(userId, experienceId, 'pass');
    const profile = await prisma.tasteProfile.findUnique({ where: { userId } });
    const interestAffinity = profile?.interestAffinity as Record<string, number>;
    expect(interestAffinity.grime).toBeCloseTo(-0.1, 5);
    expect(Math.abs(interestAffinity.grime)).toBeLessThan(0.35);
  });

  test('a "save" gives a real positive nudge', async () => {
    await prisma.tasteProfile.update({ where: { userId }, data: { categoryAffinity: {}, interestAffinity: {} } });
    await applyHomeFeedback(userId, experienceId, 'save');
    const profile = await prisma.tasteProfile.findUnique({ where: { userId } });
    const interestAffinity = profile?.interestAffinity as Record<string, number>;
    expect(interestAffinity.grime).toBeCloseTo(0.3, 5);
  });

  test('repeated negative nudges are clamped at -1, never spiralling past it', async () => {
    await prisma.tasteProfile.update({ where: { userId }, data: { categoryAffinity: {}, interestAffinity: { grime: -0.9 } } });
    await applyHomeFeedback(userId, experienceId, 'not_for_me');
    const profile = await prisma.tasteProfile.findUnique({ where: { userId } });
    const interestAffinity = profile?.interestAffinity as Record<string, number>;
    expect(interestAffinity.grime).toBe(-1);
  });

  test('"view" carries no taste signal at all — looking at something is not an opinion about it', async () => {
    await prisma.tasteProfile.update({ where: { userId }, data: { categoryAffinity: {}, interestAffinity: {} } });
    await applyHomeFeedback(userId, experienceId, 'view');
    const profile = await prisma.tasteProfile.findUnique({ where: { userId } });
    const interestAffinity = (profile?.interestAffinity as Record<string, number>) ?? {};
    expect(interestAffinity.grime ?? 0).toBe(0);
  });

  test('the real POST /home/personalized/:id/feedback route does the same thing end-to-end', async () => {
    const cookie = `plot_session=${(await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'home-feedback-2@plot-test.invalid' } })
      .then(async (r) => {
        const { devMagicLinkUrl } = r.json() as { devMagicLinkUrl: string };
        const token = new URL(devMagicLinkUrl).searchParams.get('token');
        const cb = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
        return cb.cookies.find((c) => c.name === 'plot_session')!.value;
      }))}`;
    const res = await app.inject({ method: 'POST', url: `/home/personalized/${experienceId}/feedback`, headers: { cookie }, payload: { action: 'save' } });
    expect(res.statusCode).toBe(200);
  });
});
