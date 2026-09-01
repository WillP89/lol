import { buildApp } from './app';
import { config } from './lib/config';
import { runRecommendationSweep } from './services/crewRecommendations';

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
// delivery mechanism... periodic job evaluating active Crews"). A modest interval is the
// right choice for a pilot's scale — this is not a high-throughput queue, and every Crew is
// itself capped to `maxPerWeek` inside the sweep regardless of how often this fires. Skipped
// in tests (each test run would otherwise race real recommendation delivery against its own
// fixtures) and exposed for on-demand runs via POST /admin/recommendations/sweep — see
// docs/DECISIONS.md#crew-auto-recommendations.
const RECOMMENDATION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
if (config.NODE_ENV !== 'test') {
  // Real, reported P0 bug this fixes: `setInterval` alone only fires its FIRST tick a full
  // interval after the process boots — a Crew created five minutes after this process started
  // got evaluated for the first time six hours later, and every process restart (routine during
  // development, and a real occurrence in production deploys/restarts) reset that clock back to
  // zero. From a user's perspective that reads as "automatic discovery doesn't work" even though
  // the mechanism is correctly wired — it just hadn't been given six uninterrupted hours to fire
  // once. A short delay (not 0 — let the server finish coming up first) runs one real sweep on
  // every boot, then the periodic interval takes over for steady-state cadence. Safe to run on
  // every boot/restart: `generateRecommendationForCrew`'s own weekly cap and permanent per-Crew
  // exclusion list (see crewRecommendations.ts) mean an extra sweep is a no-op for any Crew
  // that's already had its cap met this week, never a duplicate or a spam burst.
  setTimeout(() => {
    runRecommendationSweep()
      .then((result) => app.log.info(result, 'Startup recommendation sweep complete'))
      .catch((err) => app.log.error({ err }, 'Startup recommendation sweep failed'));
  }, 10_000);
  setInterval(() => {
    runRecommendationSweep().catch((err) => app.log.error({ err }, 'Recommendation sweep failed'));
  }, RECOMMENDATION_SWEEP_INTERVAL_MS);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
