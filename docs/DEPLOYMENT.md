# Getting Plot onto a real URL (and your iPhone)

## The honest situation

What exists today is a **web app** (Next.js), not a native iOS app. There is no Xcode
project, no Swift/React Native code, and no App Store listing — building one would be a real,
separate project (see "A real native app" below).

What you *can* do today, for free, in about 15 minutes: deploy the web app to a real HTTPS
URL, then use iPhone Safari's **Add to Home Screen** to install it as a full-screen app icon
— no App Store, no review, no developer account. `layout.tsx` and `public/manifest.json` are
already set up for this (standalone display mode, a proper app icon, status bar styling).

## Step 1 — a free hosted Postgres database

[Neon](https://neon.tech) or [Supabase](https://supabase.com) both have a free tier and give
you a `DATABASE_URL` in about a minute — sign up, create a project, copy the connection
string. This replaces the local `plot_dev` database this session used.

## Step 2 — deploy the API

Any of Railway, Render, or Fly.io will run a Node/Fastify app from a GitHub repo with a free
or near-free tier. In each case: connect your GitHub account, pick the `WillP89/lol` repo, set
the **root directory to `apps/api`**, build command `npm install && npm run build`, start
command `npm start`, and set these environment variables (values from Step 1 and your own
generated secrets):

```
DATABASE_URL=<from Neon/Supabase>
SESSION_SECRET=<any random 32+ character string>
TOKEN_HASH_SECRET=<a different random 32+ character string>
WEB_APP_URL=<filled in after Step 3>
NODE_ENV=production
```

Then run the migration once against the new database (from your machine, with `DATABASE_URL`
set to the hosted one): `cd apps/api && npx prisma migrate deploy`.

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
