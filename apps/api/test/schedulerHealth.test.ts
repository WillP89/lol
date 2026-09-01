import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { resetDatabase } from './helpers/resetDb';
import { runSweepIfDue, RECOMMENDATION_SWEEP_DUE_INTERVAL_MS } from '../src/services/crewRecommendations';

/**
 * GET /health/scheduler — public, no admin key, exists specifically so a sleeping-dyno-with-no-
 * external-cron problem (the exact, previously-unverifiable failure mode on Render's free tier —
 * see docs/DEPLOYMENT.md, app.ts's own comment on this route) is something anyone with the API's
 * URL can actually see, not just infer from silence.
 */
const app = buildApp();

describe('GET /health/scheduler', () => {
  test('before any sweep has ever run, reports neverRun honestly', async () => {
    await resetDatabase();
    const res = await app.inject({ method: 'GET', url: '/health/scheduler' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobName).toBe('crew_recommendation_sweep');
    expect(body.lastRunAt).toBeNull();
    expect(body.neverRun).toBe(true);
    expect(body.overdue).toBe(false); // never-run and overdue are distinct diagnoses
    expect(body.diagnosis).toMatch(/never run/i);
  });

  test('right after a real sweep runs, reports healthy with a real lastRunAt/nextDueAt', async () => {
    const outcome = await runSweepIfDue(RECOMMENDATION_SWEEP_DUE_INTERVAL_MS);
    expect(outcome.ran).toBe(true);

    const res = await app.inject({ method: 'GET', url: '/health/scheduler' });
    const body = res.json();
    expect(body.neverRun).toBe(false);
    expect(body.overdue).toBe(false);
    expect(new Date(body.lastRunAt).getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(new Date(body.nextDueAt).getTime()).toBeCloseTo(
      new Date(body.lastRunAt).getTime() + RECOMMENDATION_SWEEP_DUE_INTERVAL_MS,
      -2,
    );
    expect(body.diagnosis).toMatch(/healthy/i);
  });

  test('no x-admin-key header required — this is deliberately public, unlike every other admin/ops route', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/scheduler' });
    expect(res.statusCode).toBe(200);
  });
});
