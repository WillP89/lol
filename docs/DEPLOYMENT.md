# Getting Plot onto a real URL (and your iPhone)

## The honest situation

What exists today is a **web app** (Next.js), not a native iOS app. There is no Xcode
project, no Swift/React Native code, and no App Store listing — building one would be a real,
separate project (see "A real native app" below).

What you *can* do today, for free, in about 15 minutes: deploy the web app to a real HTTPS
URL, then use iPhone Safari's **Add to Home Screen** to install it as a full-screen app icon
— no App Store, no review, no developer account. `layout.tsx` and `public/manifest.json` are
already set up for this (standalone display mode, a proper app icon, status bar styling).

## Step 1 — a free hosted Postgres database ✅ done

Neon, schema applied directly via the SQL Editor (this sandbox can't reach Neon's port or its
HTTP API directly, so the migration SQL was pasted and run by hand instead of via `prisma
migrate deploy`). One consequence, harmless today but worth doing once before this database's
schema ever changes again: the `_prisma_migrations` bookkeeping table Prisma normally
maintains was never created, so a future `npx prisma migrate deploy` against this database
needs to be preceded once by `npx prisma migrate resolve --applied 20260830142130_init` (run
from `apps/api`, with `DATABASE_URL` pointed at this Neon database) to tell Prisma "this
migration is already applied." Not needed for anything today — just don't run `migrate deploy`
against this database before doing that once.

## Step 2 — deploy the API

Railway, Render, or Fly.io will all run a Node/Fastify app from a GitHub repo on a free tier.
**Important for this repo specifically**: it's an npm-workspaces monorepo (`apps/api` depends
on `packages/shared` via a workspace link) — do **not** set the service's root directory to
`apps/api`, that breaks the dependency resolution. Instead, leave the root directory as the
repo root and set:

- **Build command**: `npm install && npm run build --workspace=packages/shared && npm run build --workspace=apps/api`
- **Start command**: `npm run start --workspace=apps/api`

Environment variables (values from Step 1 and your own generated secrets — any random 32+
character string works for the two secrets, e.g. generate one at
[random.org/strings](https://www.random.org/strings/) or just mash the keyboard for 40
characters):

```
DATABASE_URL=<your Neon connection string>
SESSION_SECRET=<random 32+ character string>
TOKEN_HASH_SECRET=<a different random 32+ character string>
WEB_APP_URL=<filled in after Step 3>
NODE_ENV=production
POSTMARK_API_KEY=<your Postmark server API token>
EMAIL_FROM=<a sender address on a domain verified in Postmark, e.g. hello@yourdomain.com>
TICKETMASTER_API_KEY=<your Ticketmaster Discovery API key, see docs/providers/ticketing.md>
```

Both `POSTMARK_API_KEY` and `TICKETMASTER_API_KEY` are optional — the app runs without them
(dev-mode sign-in link, sample/mock events respectively) but neither is real until it's set.
Without `TICKETMASTER_API_KEY`, every event a Crew sees is fabricated sample data with a
`.invalid` booking link that goes nowhere — fine for trying the product, not for a real pilot.

**`NODE_ENV` is safe to leave as `production` now** — email delivery no longer depends on it.
Whether a real email actually gets sent depends only on whether `POSTMARK_API_KEY` is set (see
`docs/providers/email.md` and `apps/api/src/lib/email.ts`): configured → a real email goes out
and the API response doesn't include the raw link; not configured → the link comes back
directly in the response so the web app can show a "Continue →" button, in any environment.
This used to be tied to `NODE_ENV`, which meant the "correct" production setting silently
disabled sign-in entirely — that coupling is gone now that a real provider exists to wire up
instead.

**Postmark setup** (~15 minutes once DNS propagates): sign up at
[postmarkapp.com](https://postmarkapp.com), create a Server, add its sending domain, add the
SPF/DKIM DNS records it gives you to your domain (propagation is usually fast but budget up to
a few hours), then grab the Server API token from the Postmark dashboard for
`POSTMARK_API_KEY`. Without a domain of your own, Postmark's sandbox lets you send to
pre-approved test addresses only — fine for verifying the integration works, not for a real
pilot with friends.

## Step 2.5 — persistent media storage (avatars, Crew images)

**Do this, or every uploaded avatar/Crew photo will show as a broken image.** Without it, the
app still runs — uploads are refused with a clear error instead of silently accepted — but
nobody can set a photo. This is Cloudflare R2 (free tier: 10GB storage, no egress fees,
S3-compatible so it just works with the standard AWS SDK already in this repo):

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free), go to **R2 Object
   Storage**, create a bucket (any name, e.g. `plot-media`).
2. In the bucket's **Settings**, enable **Public access** via the r2.dev subdomain (or attach
   your own custom domain if you have one) — this is the URL uploaded images will actually be
   served from. Copy that URL.
3. Under **R2 → Manage API Tokens**, create a token with **Object Read & Write** permission
   scoped to this bucket. Copy the Access Key ID and Secret Access Key — the secret is shown
   once.
4. Find your R2 **Account ID** (Cloudflare dashboard sidebar) — the endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`.
5. Add to the API service's environment variables (same place as Step 2):

```
S3_BUCKET=<your bucket name>
S3_ACCESS_KEY_ID=<the Access Key ID from step 3>
S3_SECRET_ACCESS_KEY=<the Secret Access Key from step 3>
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_PUBLIC_URL=<the public bucket URL from step 2, no trailing slash>
```

Real AWS S3 works too (same env vars, omit `S3_ENDPOINT`, set `S3_PUBLIC_URL` to your bucket's
own `https://<bucket>.s3.<region>.amazonaws.com`) — R2 is recommended for a pilot because it's
free at this scale and has no egress charges.

**You do not need to set `API_PUBLIC_URL` manually on Render or Railway** — the API now
auto-detects `RENDER_EXTERNAL_URL`/`RAILWAY_PUBLIC_DOMAIN`, which those platforms set
automatically. Set `API_PUBLIC_URL` explicitly only on a platform that doesn't provide one of
those (Fly.io, a bare VPS, etc).

## Step 2.6 — wire up the automatic Crew recommendation scheduler (do this)

Plot's core loop — Plot proactively finding something and posting it into a Crew, unprompted —
runs on a schedule (`services/crewRecommendations.ts`). The API process itself checks the
database every 15 minutes and runs a sweep whenever one is actually overdue (every 6 hours by
default), and that self-healing check also fires once on every boot — so on Fly.io or Railway,
where the container stays running continuously, **no further setup is required.**

**On Render specifically, you also need an external ping.** Why: its free tier puts an idle
service to sleep, and a sleeping process's in-memory checks (the 15-minute poll above) simply
stop running until something wakes it back up. An external ping is the one thing that reliably
wakes a sleeping dyno in the first place — nothing running inside the process can do that for
itself.

**Recommended (free): the GitHub Actions workflow already in this repo**
(`.github/workflows/wake-scheduler.yml`) pings the sweep endpoint every 30 minutes — no
Render dashboard clicking, no paid add-on (Render's own Cron Jobs feature is billed, unlike a
GitHub Actions schedule). Turn it on by adding two repo secrets (GitHub → this repo → Settings
→ Secrets and variables → Actions → New repository secret):

```
PLOT_API_URL = https://<your-api-url>          (no trailing slash)
PLOT_ADMIN_API_KEY = <your ADMIN_API_KEY>       (same value set on the API service itself)
```

Until both secrets exist, the workflow runs on schedule but skips its actual step (with a
visible warning in the Actions log) rather than failing — so it's safe to merge before you've
set them up. You can also trigger it once by hand from the repo's **Actions** tab → "Wake
recommendation scheduler" → **Run workflow**, to confirm it's wired up correctly before waiting
for the schedule.

**Alternative**: Render → your service → Cron Jobs → New Cron Job (schedule `*/30 * * * *`),
running the same `curl -X POST https://<your-api-url>/admin/recommendations/sweep -H
"x-admin-key: <your ADMIN_API_KEY>"` — this costs a small amount on Render's usage-based
pricing for Cron Jobs, which the GitHub Actions workflow above avoids entirely.

Either way, the request calls the exact same "is a sweep actually due" check the in-process
poll uses (see `runSweepIfDue` in `crewRecommendations.ts`), so pinging every 30 minutes does
**not** mean a sweep runs every 30 minutes — it means "wake up and check every 30 minutes,
actually run whenever the real 6-hour cadence says it's due." This same endpoint accepts
`{"force": true}` in the request body for a genuine one-off manual run (ops/debugging only — a
scheduler should never pass this).

**Check it's actually working** — visit `https://<your-api-url>/health/scheduler` in any
browser (no admin key needed, unlike every other admin/ops route — it's read-only, no secrets
in the response). It reports `lastRunAt`, `nextDueAt`, whether a sweep is `overdue`, and a
plain-English `diagnosis` — this is the one place to check instead of guessing from silence.

On Fly.io/Railway this external ping is optional defense-in-depth, not required — those
platforms don't idle-sleep a paid/hobby container the way Render's free tier does.

## Step 3 — deploy the web app

[Vercel](https://vercel.com) is the natural fit for Next.js — connect GitHub, import
`WillP89/lol`, set the **root directory to `apps/web`**, and add one environment variable:

```
API_URL=<the URL Railway/Render/Fly gave your API in Step 2>
```

Vercel gives you a URL like `plot-yourname.vercel.app`. Go back to Step 2's host and set
`WEB_APP_URL` to that same URL (magic links are built from it).

## Step 4 — put it on your iPhone

Open the Vercel URL in **Safari on your iPhone** (must be Safari, not Chrome — only Safari
supports this on iOS), tap the **Share** icon, then **Add to Home Screen**. You'll get a real
app icon on your home screen that opens full-screen, no browser chrome.

## A real native app (App Store / TestFlight)

If you want an actual native iOS app later — not required for a pilot, PWA covers "on my
phone" — that's a materially bigger, separate piece of work:

- A React Native (Expo) rewrite of the frontend, most realistically — it can reuse this same
  API unchanged, only the client is new.
- An Apple Developer Program membership ($99/year) to run it on a real device beyond your own
  via TestFlight, or to submit to the App Store.
- TestFlight for pilot distribution (no App Store review, but still needs the paid Developer
  account and App Store Connect setup) — the realistic path for a 50-100 person pilot, App
  Store submission only once there's a reason to be publicly listed.

Say the word if you want this scoped out properly — it's a real next phase, not a follow-up
command.
