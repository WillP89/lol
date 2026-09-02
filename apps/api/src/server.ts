import { buildApp } from './app';
import { config } from './lib/config';
import { runSweepIfDue, RECOMMENDATION_SWEEP_DUE_INTERVAL_MS } from './services/crewRecommendations';
import { backfillImageQuality } from './services/inventorySync';

const app = buildApp();

app
  .listen({ port: config.PORT, host: '0.0.0.0' })
  .then((address) => {
    app.log.info(`Plot API listening on ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

// The automatic Crew recommendation system's periodic delivery job (brief: "a scheduling/
// delivery mechanism... periodic job evaluating active Crews").
//
// Two DIFFERENT intervals, deliberately not one — see crewRecommendations.ts#runSweepIfDue for
// the full reasoning behind the split:
//   - DUE: how overdue a sweep has to be before it's actually worth running. This is the real
//     "cadence" a Crew experiences, decided against the DATABASE (`SchedulerState.lastClaimedAt`),
//     never against how long this one process has happened to be alive.
//   - CHECK: how often THIS process asks "is a sweep due yet". Safe to keep short — a check that
//     finds nothing due is one cheap indexed UPDATE touching zero rows, not a full sweep — so a
//     short check interval buys fast recovery after a restart without affecting real cadence.
//
// Why this replaced a plain `setInterval` outright, not just gained a boot-time run: this app's
// documented deployment targets (Railway/Render/Fly — see docs/DEPLOYMENT.md) are a single
// long-running container, and on hobby-tier hosting that shape realistically (a) sleeps an idle
// free-tier service for hours (Render's free tier does exactly this — every in-memory timer in
// the process simply stops until the next inbound request wakes it), (b) restarts on every
// deploy, and (c) can briefly run an old+new instance pair mid rolling-deploy. A bare
// `setInterval`'s schedule lives only in one process's memory: it can't tell a sweep is overdue
// after a multi-hour sleep, and two processes racing it have no way to coordinate. Checking the
// database on every boot AND on a short poll — via a single atomic claim, not read-then-write —
// makes this self-healing across restarts/sleep/scaling instead of merely "less broken at boot".
//
// RECOMMENDED for real production use: also point an external scheduler (Render Cron Jobs, a
// GitHub Actions scheduled workflow, cron-job.org, ...) at `POST /admin/recommendations/sweep`
// (same `x-admin-key` gate as every other admin route) every 30-60 minutes. An external ping is
// the one thing that reliably WAKES a sleeping free-tier dyno in the first place — nothing
// in-process can do that for itself — and it calls this exact same due-or-not logic, so it can
// never double-fire a sweep that already happened. The in-process check below is real,
// self-healing defense-in-depth (correct on Fly/Railway, which don't idle-sleep the way Render's
// free tier does), not a substitute for that external trigger — see docs/DEPLOYMENT.md.
const RECOMMENDATION_SWEEP_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes — how often to ask
const checkSweep = () => {
  runSweepIfDue(RECOMMENDATION_SWEEP_DUE_INTERVAL_MS)
    .then((outcome) => {
      if (outcome.ran) app.log.info(outcome.result, 'Recommendation sweep ran (database confirmed it was due)');
    })
    .catch((err) => app.log.error({ err }, 'Recommendation sweep check failed'));
};
if (config.NODE_ENV !== 'test') {
  setTimeout(checkSweep, 10_000); // let the server finish coming up first
  setInterval(checkSweep, RECOMMENDATION_SWEEP_CHECK_INTERVAL_MS);
}

// The retroactive half of the image-quality floor (services/inventorySync.ts#backfillImageQuality's
// own comment has the full reasoning) — a row synced before that gate existed doesn't self-heal
// until its city's next resync, which on a pilot-scale app with sparse traffic can be a real,
// user-visible delay. Runs once per boot, staggered after the sweep check so it isn't competing
// with server startup, and is cheap/idempotent to repeat on every restart (an already-clean row
// just gets re-confirmed). Also triggerable on demand via POST /admin/image-quality-backfill.
if (config.NODE_ENV !== 'test') {
  setTimeout(() => {
    backfillImageQuality().catch((err) => app.log.error({ err }, 'Image quality backfill failed'));
  }, 20_000);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
