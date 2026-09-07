import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';

/**
 * GET /admin/inventory-probe — the real diagnostic this session's live investigation needed and
 * didn't have: "the Ticketmaster key is confirmed live (other events show up) — so why does
 * boxing/MMA never appear?" `/providers` only ever confirms a key is CONFIGURED; it can't answer
 * whether a live provider actually has any matching inventory right now, or whether real
 * inventory exists but falls outside the (deliberately narrow, 21-day) window Crew
 * recommendations and Explore actually search. This adapter-agnostic probe calls
 * fetchListings+mapToCanonical directly — bypassing the DB, quality scoring and dedup — so an
 * operator can tell "no real inventory exists for this" apart from "real inventory exists but
 * the recommendation window is too narrow for it" instead of guessing at either.
 *
 * Exercised here only against the mock (non-live) registry — the same real-egress constraint
 * every other live-provider adapter test in this suite documents (see ticketing.md) means the
 * actual Ticketmaster/PredictHQ call path can't be run from this sandbox. What's proven here is
 * the contract every caller (including the live path) goes through: auth, request validation,
 * and the shape of the response for a non-live adapter — the live branch's own logic
 * (fetchListings -> mapToCanonical -> recommendation-window flag) is exercised by
 * musicGenreSpecificity.test.ts and crewImpliedInterestScoring.test.ts's own use of the manual-
 * experience endpoint through the identical CanonicalListingInput shape.
 */
const app = buildApp();
const ADMIN_KEY = 'dev_admin_key_change_me';

describe('GET /admin/inventory-probe', () => {
  test('requires the admin key, same as every other admin route', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/inventory-probe?city=Birmingham' });
    expect(res.statusCode).toBe(401);
  });

  test('reports every registered adapter, honestly marking a non-live one rather than pretending to have probed it', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/inventory-probe?city=Birmingham', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { city: string; recommendationWindowDays: number; providers: { id: string; isLive: boolean; events: unknown[] }[] };
    expect(body.city).toBe('Birmingham');
    expect(body.recommendationWindowDays).toBe(21);
    expect(body.providers.length).toBeGreaterThan(0);
    for (const p of body.providers) {
      expect(p.isLive).toBe(false); // NODE_ENV=test always runs the mock registry — see registry.ts
      expect(p.events).toEqual([]);
    }
  });

  test('a bad `days` value is rejected, not silently clamped or ignored', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/inventory-probe?city=Birmingham&days=99999', headers: { 'x-admin-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(400);
  });
});
