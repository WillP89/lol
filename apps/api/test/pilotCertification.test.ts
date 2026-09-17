import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';

/**
 * GET /admin/pilot-certification — the mission's own explicit ask: run the same 8 representative
 * Crew intents docs/PILOT_READINESS_AUDIT.md's Cycle 8 coverage matrix was built from by hand, in
 * one request, against whatever providers are actually live right now. Diagnostic only, same as
 * /inventory-probe: never writes to the database, never sends anything into a real Crew's chat.
 *
 * Exercised here only against the mock (non-live) registry, same real-egress constraint every
 * other live-provider test in this suite documents — every mock adapter is `isLive: false`, so
 * every intent deterministically reports UNSUPPORTED here. That's not a weak test: it proves the
 * one thing this sandbox genuinely can verify — the request shape, auth, and the viability
 * classifier's own "no live adapter even claims this category" branch — correctly, every time.
 * The live branch (a real adapter actually returning matching inventory) is exercised by the
 * live curl verification recorded in docs/PILOT_READINESS_AUDIT.md's own Cycle 12 write-up.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';

describe('GET /admin/pilot-certification', () => {
  test('requires the admin key, same as every other admin route', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/pilot-certification' });
    expect(res.statusCode).toBe(401);
  });

  test('runs all 8 representative intents and honestly reports UNSUPPORTED when no live provider covers any of them', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/pilot-certification', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intents: { intent: string; expectedCategory: string; recommendationViability: string; providersAttempted: number; rawOpportunities: number }[];
    };
    expect(body.intents.length).toBe(8);
    const labels = body.intents.map((i) => i.intent);
    expect(labels).toEqual([
      'Alternative rock',
      'UK garage / house',
      'Comedy',
      'Football',
      'Japanese food',
      'Food festival / market',
      'Theatre',
      'Social activity (bowling/escape room)',
    ]);
    for (const intent of body.intents) {
      expect(intent.recommendationViability).toBe('UNSUPPORTED'); // NODE_ENV=test's mock registry is isLive:false throughout — see registry.ts
      expect(intent.rawOpportunities).toBe(0);
    }
  });

  test('a `city` override applies to every intent in the run', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/pilot-certification?city=Manchester', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { intents: { city: string }[] };
    for (const intent of body.intents) {
      expect(intent.city).toBe('Manchester');
    }
  });
});
