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
