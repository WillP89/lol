import { beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';

/**
 * POST /crews/:id/invites/email — the real, explicit ask this exists for: "willproud89@gmail.com
 * goes to add someone to a crew, types their email, and they get an invite link to join." No
 * email provider is configured in the test environment (same as every other email-sending path
 * this codebase tests), so every successful call here takes the dev-mode fallback and returns
 * the link directly rather than actually sending — same pattern golden-path.test.ts's own
 * loginByEmail helper already relies on for magic links.
 */

const app = buildApp();

async function loginByEmail(email: string): Promise<{ userId: string; cookie: string }> {
  const magicLinkRes = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  const { devMagicLinkUrl } = magicLinkRes.json() as { devMagicLinkUrl: string };
  const token = new URL(devMagicLinkUrl).searchParams.get('token');
  const callbackRes = await app.inject({ method: 'POST', url: '/auth/callback', payload: { token } });
  const cookie = callbackRes.cookies.find((c) => c.name === 'plot_session')!;
  const { user } = callbackRes.json() as { user: { id: string } };
  return { userId: user.id, cookie: `${cookie.name}=${cookie.value}` };
}

beforeAll(async () => {
  await resetDatabase();
});

describe('POST /crews/:id/invites/email', () => {
  test('a crew member can send a real invite email to any address', async () => {
    const owner = await loginByEmail('invite-owner@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Invite Test Crew', defaultCity: 'London' },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    const res = await app.inject({
      method: 'POST',
      url: `/crews/${crew.id}/invites/email`,
      headers: { cookie: owner.cookie },
      payload: { email: 'brand-new-invitee@plot-test.invalid' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; devInviteUrl?: string; sentTo?: string };
    expect(body.ok).toBe(true);
    // No provider configured in test — dev fallback, same shape as the magic-link flow.
    expect(body.devInviteUrl).toContain(`/crews/join/${crew.inviteCode}`);
  });

  test('rejects a malformed email', async () => {
    const owner = await loginByEmail('invite-owner2@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Invite Test Crew 2', defaultCity: 'London' },
    });
    const { crew } = crewRes.json() as { crew: { id: string } };

    const res = await app.inject({
      method: 'POST',
      url: `/crews/${crew.id}/invites/email`,
      headers: { cookie: owner.cookie },
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('a non-member cannot send an invite for a crew they are not in', async () => {
    const owner = await loginByEmail('invite-owner3@plot-test.invalid');
    const outsider = await loginByEmail('invite-outsider@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Invite Test Crew 3', defaultCity: 'London' },
    });
    const { crew } = crewRes.json() as { crew: { id: string } };

    const res = await app.inject({
      method: 'POST',
      url: `/crews/${crew.id}/invites/email`,
      headers: { cookie: outsider.cookie },
      payload: { email: 'whoever@plot-test.invalid' },
    });
    expect(res.statusCode).toBe(404); // getCrewDetail returns null for a non-member, same as every other crew route
  });

  test('the real join flow actually works end to end with the emailed link', async () => {
    const owner = await loginByEmail('invite-owner4@plot-test.invalid');
    const crewRes = await app.inject({
      method: 'POST',
      url: '/crews',
      headers: { cookie: owner.cookie },
      payload: { name: 'Invite Test Crew 4', defaultCity: 'London' },
    });
    const { crew } = crewRes.json() as { crew: { id: string; inviteCode: string } };

    const inviteRes = await app.inject({
      method: 'POST',
      url: `/crews/${crew.id}/invites/email`,
      headers: { cookie: owner.cookie },
      payload: { email: 'real-friend@plot-test.invalid' },
    });
    const { devInviteUrl } = inviteRes.json() as { devInviteUrl: string };
    const inviteCode = new URL(devInviteUrl).pathname.split('/').pop();

    const friend = await loginByEmail('real-friend@plot-test.invalid');
    const joinRes = await app.inject({
      method: 'POST',
      url: '/crews/join',
      headers: { cookie: friend.cookie },
      payload: { inviteCode },
    });
    expect(joinRes.statusCode).toBe(200);

    const crewDetail = await app.inject({ method: 'GET', url: `/crews/${crew.id}`, headers: { cookie: friend.cookie } });
    expect(crewDetail.statusCode).toBe(200);
  });
});
