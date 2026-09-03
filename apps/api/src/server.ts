import { buildApp } from './app';
import { config } from './lib/config';
import { runSweepIfDue, RECOMMENDATION_SWEEP_DUE_INTERVAL_MS } from './services/crewRecommendations';
import { runImageQualityBackfillIfDue, runMissingImageBackfillIfDue } from './services/inventorySync';
import { runMessageNotificationSweepIfDue, MESSAGE_NOTIFICATION_SWEEP_DUE_INTERVAL_MS } from './services/messageNotifications';

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
// own comment has the full reasoning, including the real "same bad image kept coming back" gap a
// one-shot capped run had). Same due/check split as the recommendation sweep above, and for the
// exact same reason: a one-shot boot-only call can never be trusted as the only thing standing
// between a stale row and a user, on hosting that can sleep/restart/scale — this now genuinely
// re-runs, on a real cadence, database-confirmed, not just once at process start. Staggered 10s
// after the sweep check so the two don't compete for the same startup window; also triggerable on
// demand via POST /admin/image-quality-backfill (bypasses the due-check, like the sweep's `force`).
const IMAGE_QUALITY_BACKFILL_DUE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours — same cadence as the recommendation sweep
const IMAGE_QUALITY_BACKFILL_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const checkImageQualityBackfill = () => {
  runImageQualityBackfillIfDue(IMAGE_QUALITY_BACKFILL_DUE_INTERVAL_MS)
    .then((outcome) => {
      if (outcome.ran) app.log.info(outcome.result, 'Image quality backfill ran (database confirmed it was due)');
    })
    .catch((err) => app.log.error({ err }, 'Image quality backfill check failed'));
};
if (config.NODE_ENV !== 'test') {
  setTimeout(checkImageQualityBackfill, 20_000);
  setInterval(checkImageQualityBackfill, IMAGE_QUALITY_BACKFILL_CHECK_INTERVAL_MS);
}

// The retroactive half of the real-image directive ("I don't want to see ANY events without a
// real image" — services/inventorySync.ts#backfillMissingImages's own comment has the full
// reasoning). Same due/check split, same reason, as the two jobs above — staggered a further 10s
// so all three don't compete for the same startup window; also triggerable on demand via
// POST /admin/missing-image-backfill.
// Was 6 hours (matching the dimension-floor backfill's own cadence) until a real, live-reported
// bug made that gap too wide to defend: a Crew's very first Plot recommendation can land on a
// brand-new Experience row that hasn't had a sweep pass yet, showing the generic v2Art fallback
// graphic on the single most scrutinised card in the product. That specific path now runs its
// own synchronous, best-effort enrichment attempt at delivery time (see crewRecommendations.ts's
// call to enrichMissingImageForExperience) — but every OTHER surface a fresh row can reach first
// (Explore, a manual "Suggest Something" share) still depends on this sweep alone. Tightened to
// close that same gap for those paths too, not just the one that got reported.
const MISSING_IMAGE_BACKFILL_DUE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MISSING_IMAGE_BACKFILL_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const checkMissingImageBackfill = () => {
  runMissingImageBackfillIfDue(MISSING_IMAGE_BACKFILL_DUE_INTERVAL_MS)
    .then((outcome) => {
      if (outcome.ran) app.log.info(outcome.result, 'Missing-image backfill ran (database confirmed it was due)');
    })
    .catch((err) => app.log.error({ err }, 'Missing-image backfill check failed'));
};
if (config.NODE_ENV !== 'test') {
  setTimeout(checkMissingImageBackfill, 30_000);
  setInterval(checkMissingImageBackfill, MISSING_IMAGE_BACKFILL_CHECK_INTERVAL_MS);
}

// "Notifications of messages in crews that you're in" — see services/messageNotifications.ts's
// own comment for the full "why a debounced digest, not one email per message" reasoning. Same
// due/check split, same DB-backed claim, as every sweep above — but a much shorter DUE interval
// (3 minutes vs. hours) since this is a near-real-time digest, not a periodic batch job; CHECK
// stays short for the same fast-recovery-after-restart reason the others use it for. Staggered a
// further 10s so it doesn't compete with the other three for the same startup window; also
// triggerable on demand via POST /admin/message-notifications/sweep.
const MESSAGE_NOTIFICATION_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute — needs to be short given the 3-minute due interval
const checkMessageNotifications = () => {
  runMessageNotificationSweepIfDue(MESSAGE_NOTIFICATION_SWEEP_DUE_INTERVAL_MS)
    .then((outcome) => {
      if (outcome.ran) app.log.info(outcome.result, 'Message notification sweep ran (database confirmed it was due)');
    })
    .catch((err) => app.log.error({ err }, 'Message notification sweep check failed'));
};
if (config.NODE_ENV !== 'test') {
  setTimeout(checkMessageNotifications, 40_000);
  setInterval(checkMessageNotifications, MESSAGE_NOTIFICATION_CHECK_INTERVAL_MS);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
