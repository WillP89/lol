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
NODE_ENV=development
```

**Leave `NODE_ENV` as `development`, not `production`, until a real email provider is wired
up.** No transactional email provider is implemented yet (see `docs/providers/email.md` —
Postmark/SES is a TODO in `apps/api/src/services/auth.ts`). In `development`, the magic-link
API response includes the raw sign-in link directly so the web app can show a "Continue →"
button — that's the only way to sign in today. Setting `NODE_ENV=production` silently disables
that fallback (the API just logs a warning server-side) with **no email ever sent to replace
it**, which is a dead end for anyone testing the pilot. Switch this to `production` only once
Postmark/SES is actually sending mail.

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
