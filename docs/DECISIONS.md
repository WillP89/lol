# Decisions

Anchored sections referenced from code comments throughout the codebase. Each is a real
tradeoff we made deliberately, with the honest downside written down rather than hidden —
the point of this file is that a future engineer (including us, in six months) can find out
*why* without archaeology.

## #canonical-vs-listing

See `prisma/schema.prisma`'s top-of-file comment. Short version: one canonical `Experience`
entity with a category enum + JSON tag bag, not separate Event/Restaurant/Performance tables,
because Match/dedup/quality-scoring would otherwise need N near-identical code paths.

## #event-log

One `IntentSignal` table (`name` + typed JSON `payload`, validated at the application layer
against `packages/shared/src/analytics.ts`) instead of a table per interaction type
(SearchInteraction, RecommendationInteraction, ...). Adding an event is a one-line change to
shared code, not a migration. Downside: no DB-level schema enforcement on payload shape —
mitigated by the shared taxonomy being the only import path callers use.

## #rate-limiting

In-memory, single-instance only. See ARCHITECTURE.md — this is the first thing to fix before
running more than one API instance.

## #entity-resolution

Two-stage: deterministic `canonicalKey` (name+venue+date) for exact duplicates, a Jaccard
token-overlap heuristic for near-duplicates that does NOT auto-merge below 0.82 similarity.
Honest limitation: under-merges genuinely differently-named listings of the same thing,
over-merges coincidental near-matches at small venues. Correct long-term fix is embedding
similarity once there's enough real multi-provider overlap to justify training/tuning one —
premature before then.

## #venue-identity

`Venue` has no natural unique constraint beyond `id` (two venues can share a name across
cities). We look up by `(name, city)` and create on miss rather than misusing Prisma's
`upsert` against a synthetic id. Downside: a genuine race (two syncs creating the same venue
concurrently) could create a duplicate Venue row — acceptable at pilot sync volume/frequency;
a unique constraint on `(name, city)` is the fix if it ever actually happens.

## #quality-scoring

Weighted so that validity + freshness (30 pts max) can never alone cross
`MIN_PUBLISHABLE_QUALITY_SCORE` (40) — completeness (description, image, price, tag richness;
70 pts) has to contribute. A listing that's technically valid and freshly fetched but has no
description, image or price is still not fit to show a group deciding what to do. Popularity/
booking-conversion/cancellation-history inputs from the fuller brief list are real signals but
need real usage volume to be meaningful — staged for V1 once there's data to compute them
from, not invented now.

## #recommendation-system

Layer 4 (`LearnedRanker` in `services/match.ts`) is currently the identity function — it does
not reorder anything. We do not believe there is enough RewindSignal/BookingCompleted history
to train a real ranker yet; adding one now would mean fitting noise and calling it
intelligence. The interface exists so swapping in a real model later is a drop-in, not a
rewrite.

## #cold-start-defaults

A brand-new Crew with no completed-plan history defaults to Fri/Sat best-nights and LOW DNA
confidence rather than fabricating false precision (brief §12 "do not fake confidence"). See
`services/crewDna.ts`.

## #rewind-not-memory-reel

Rewind ships as a single tap ("would your Crew do this again?") instead of a photo/memory-reel
feature. It's the cheapest possible surface that produces real training signal, and it doesn't
compete with what Instagram/BeReal already do well — see the phase-2 strategy work on why
Plot should not become a photo-sharing app.

## #booking-models

Only Model A (deep link) is implemented. Models B (affiliate)/C (API)/D (native) all require
commercial agreements or a verified payments account that don't exist yet (see
`docs/providers/`) — the `BookingModel` enum and `Booking`/`Payment` schema exist so adding
them later is additive, not a migration.

## #local-supply

Restaurant and independent-venue inventory realistically comes from direct relationships
(a venue emails their weekly availability, an operator enters it via `POST
/admin/experiences/manual`) rather than any single aggregator API — OpenTable, Resy and
SevenRooms are all partner-gated per `docs/providers/restaurants.md`. This is why manual
curation goes through the exact same canonical pipeline (`canonicalKey`, quality scoring) as
an automated provider sync: Match can't tell the difference, and it shouldn't have to.

## #admin-auth

`/admin/*` is gated by a single shared-secret header (`ADMIN_API_KEY`), not real role-based
auth. This is a deliberate pilot-stage stopgap for a team of one or two operators. It must be
replaced with real per-operator auth (a `User.role` enum + session-based admin auth) before
more than a couple of people touch it — a shared secret has no audit trail of *who* did an
admin action, only that *someone* with the key did.

## #test-database

Integration tests run against a real, separate Postgres database (`plot_test`), not a mocked
Prisma client. `test/setup.ts` redirects `DATABASE_URL` before any app code is imported. We
chose this deliberately over mocking the ORM: the thing most likely to break this product is a
wrong assumption at a component boundary (a Prisma relation, a transaction, a real constraint
violation), and mocking that boundary out is exactly how you stop catching it.

## #crew-chat

A simple per-Crew group chat (`CrewMessage`), added after a founding-team demo (a static,
disconnected HTML prototype — see the demo's own header, "Prototype · Founding team review")
was mistaken for the real, functional app. That demo depicted no chat feature at all — Plot's
whole thesis is replacing the group chat, not adding one — so this is new scope, not something
that regressed.

Deliberately minimal for the pilot: text only, no read receipts, no typing indicators, no
edit/delete, no threading. The web client polls `GET /crews/:id/messages` (optionally with
`?after=<lastMessageId>`) every few seconds rather than a websocket/SSE transport — the
simplest thing that works for a pilot-sized Crew (a handful of people talking occasionally),
not a chat app's worth of real-time infrastructure. Membership (`isCrewMember`), not
authorship, gates both read and write, reusing the same crew-membership check the rest of the
Crew surface already uses.

Upgrade path once polling stops being good enough (larger Crews, users expecting sub-second
delivery): swap the transport for SSE or a websocket without touching the data model —
`CrewMessage` doesn't encode anything about how it's delivered.

## #explore-map

The founding-team demo's "map" screen is CSS gradients and absolutely-positioned divs — no
map provider, no real coordinates. A real one turned out to be cheap to build because the data
already supported it: the mock provider adapters (`providers/mock/*.ts`) carry real London
venue lat/lng, and `Venue.latitude`/`longitude` were already real columns. `GET
/explore/experiences?city=` reuses Match's Layer-1 hard constraints (quality score, not sold
out, within the candidate window) without the crew-specific scoring — it's a browse view, not
a recommendation — and the web app renders it with Leaflet + OpenStreetMap tiles (free, no API
key) rather than a paid provider like Mapbox/Google Maps, which is the right tradeoff until
there's a reason (offline tiles, custom styling) to pay for one.

One related gap this surfaced: nothing in the codebase ever called `syncAllProviders` outside
the manual `POST /admin/sync` endpoint, so a freshly migrated database has zero `Experience`
rows and both Match and Explore would silently return empty. `ensureInventory(city)`
(`services/inventorySync.ts`) self-heals this — it syncs once if a city looks unseeded — which
is safe only because the registered providers are in-memory mocks with no real API cost or
rate limit. A real provider adapter should keep going through the scheduled `/admin/sync` path
instead of leaning on this fallback.

## #real-events

Ticketmaster's Discovery API (`providers/live/ticketmaster.ts`) is the first real provider,
per docs/providers/ticketing.md's existing plan. `providers/registry.ts` registers it — and
only it, dropping both mocks entirely — the moment `TICKETMASTER_API_KEY` is set; without a
key, the mocks are the only source, same as before. This is a deliberate either/or, not
mock-plus-real: presenting fabricated sample events alongside real bookable ones with no way
to tell them apart would be actively misleading once real inventory exists.

`hasLiveProvider` (registry.ts) is threaded through `GET /explore/experiences` and
`POST /crews/:id/find-us-something` as a `dataSource: 'live' | 'mock'` field, and the web app
shows an explicit "Sample events — no real event provider connected" banner whenever it's
`'mock'`. The alternative — silently rendering fake events as if they were real — is exactly
what was explicitly ruled out.

Not verified against a live Ticketmaster account: this was written in an environment with no
outbound network access to `app.ticketmaster.com`. The category/booking-status mapping logic
is unit-tested against hand-built fixtures shaped like real Discovery API responses
(`test/unit/ticketmaster.test.ts`), which catches a wrong mapping but not "does our actual API
key work" or "does Ticketmaster's real response shape match what we assumed" — that needs a
real key and a real request against the deployed service.

`ensureInventory`'s "sync once if this city has zero Experience rows, then never again" logic
(see above) is a real limitation once a live provider is involved: it means a city's event
data, once synced, never refreshes on its own — no cron, no staleness check. Fine for a first
pilot city seeded once; a real ongoing product needs a scheduled `POST /admin/sync` (e.g. a
Render Cron Job hitting it daily) rather than relying on this on-demand fallback indefinitely.

## #home-surface

The Crews list was a flat list of names — no different from a table of rows. `listCrewsForUser`
and `getCrewDetail` (`services/crew.ts`) now compose in `latestMessage`, `activePlan` (the
newest Plan still in an open-decision status), `upcomingPlan` (the newest BOOKED Plan), and a
3-message chat preview. Deliberately three independent, cheap queries per Crew rather than one
hand-tuned join: at pilot scale (a handful of Crews per user) this is far easier to reason
about, and each piece degrades independently — a Crew with no messages yet just gets
`latestMessage: null`, never a broken row. If Crew counts per user grow enough for N+1-style
queries to matter, the fix is a materialized per-Crew summary row updated on write, not a
bigger join.

## #message-reactions

One reaction per user per message (tapping the same emoji again removes it; tapping a
different one replaces it) from a fixed 4-emoji set (👍❤️😂🎉), not a full Slack-style
accumulating-reactions-per-user system or a general emoji picker. This is a lightweight
interest signal on a message, not a general-purpose feature — the fixed palette keeps the UI
(and the moderation surface) small. `crewId` is checked against the reacted-to message's own
crew server-side, not inferred from the URL alone, so a member of one Crew can't react to a
message id belonging to a Crew they're not in just by guessing/enumerating ids.

## #nav-restructure

Home ≠ Crews. The nav grew from 3 destinations (Crews/Explore/Profile) to 5 (Home/Explore/
Crews/Plans/You), splitting what used to be one page doing two jobs:
- `/crews` used to be both "what's happening across everyone" (a feed) and "the list of my
  Crews" (a directory) — same page, same title ("Home"), same content. Now `/home` is the
  feed (next plan, decisions needing your vote, a Crews preview strip, a light activity feed
  built by re-sorting the same per-Crew data the old page already fetched — no new aggregate
  table) and `/crews` is purely the directory + creation flow.
- `/plans` is new: every BOOKED Plan across every Crew (`listUpcomingPlansForUser`,
  `GET /plans/upcoming`), soonest-first. Confirmed plans previously only existed embedded in
  whichever Crew booked them.
- Crew creation moved from an always-visible inline `name` field + `Create Crew` button (reads
  as "insert a database row") to a two-step sheet: name the Crew, then immediately get an
  invite link to share, landing you in the new Crew when you're done — creation ends with
  "there are people in this" instead of "there is a row in a table."

`TabBar` (components/TabBar.tsx) is one component for both a mobile bottom bar and a desktop
left sidebar — same markup, `@media (min-width: 900px)` in globals.css restyles it in place
rather than a second desktop-only nav component to keep in sync. `.page`/`.nav` shift right to
clear the sidebar only on pages that actually render one, via `body:has(.tabbar) .page`, since
a handful of intentionally chrome-free pages (chat, auth, onboarding, the public Plan Card)
still go full-width with no sidebar to clear.

## #golden-hour-redesign

After two rounds of structural work (nav, Home, Plans) still read as "the same app" because
the actual visual system — colour tokens, typography scale, and above all a 1px border on
every single card/button/chip — was never touched. This was the pass that changed the system
itself, not another screen's content:

- New palette ("Golden Hour"): espresso-dark base (`--ink-bg: #0f0a06`) instead of navy-black,
  a genuinely saturated amber as `--ink-gold` used as a real primary colour, ember worked in as
  a second warm tone. Not a purple/blue "AI SaaS" palette, not a subtler version of the old one
  — a different colour story, warm and evening-plans-specific.
- Removed the `border: 1px solid var(--ink-border)` from `.card`, `.banner-card`, `.btn`,
  `.chip`, and `input.field` — a hard stroke around every piece of content is what made the
  whole app read as a table of database rows. New `--ambient-shadow` token (soft, diffuse)
  does the elevation job instead, the way Airbnb/Linear/Spotify actually differentiate content
  from background.
- TabBar (mobile) is now a floating rounded island with margin on every side, not a bar welded
  flush to the screen edge — the single most recognisable "considered app, not a web page"
  signal available in a bottom nav. Active tab gets a soft gold pill highlight.
- Chat bubbles have an asymmetric corner radius (tight on the sender's corner — the iMessage/
  WhatsApp "tail" detail) and no border — bubbles, not cards with text in them.
- Home's Crews section is a horizontal-scroll row of gradient-identity tiles (`crewGradient`,
  hashed per Crew id) instead of another vertical stack of uniform cards — five Crews now read
  as five different groups, not five identical rows repeated. The "next plan" card is a real
  full-bleed photo hero with text scrimmed onto it, not an image strip glued above a text block.

## #crew-chat-merge

Crew detail and Crew chat used to be two separate routes/screens (`/crews/:id` summarising
the Crew with a "Conversation" preview card that linked out to `/crews/:id/chat` for the real
thing). Merged into one screen at `/crews/:id`: a compact header (name, avatars, an info
button), at most one slim "what's happening" strip (a confirmed plan or an open vote — never
both at full size), then the message list at full height with the composer pinned below —
because the conversation is the actual product here, not a feature the Crew summary links out
to. Group DNA, the availability strip, and the invite link — none of them belong competing for
space with chat — moved into a single "Crew info" BottomSheet reachable by tapping the header,
the same way a real messaging app puts group settings behind "tap the group name." The old
`/crews/:id/chat` route now just redirects to `/crews/:id` so no existing link dead-ends. The
standalone `/crews/:id/match` results page is gone too — "Find us something" now always posts
straight into the conversation (`suggest-to-chat`, see #nav-restructure's core-loop note),
which superseded the private single-viewer results screen as the only path in.

## #explore-rails

Explore's opening state was a single filterable list (discovery-mode chips + a flat card
stack) — a database result view, not discovery. Rebuilt as themed horizontal rails (Tonight /
This weekend / Free / Under £30 / Coming up), each a different slice of the same fetched
experience set — an event can legitimately appear in more than one rail, since a rail is a
lens on the data, not a bucket it belongs to. A rail only renders if it has content, so an
empty "Tonight" (the mock catalogue's dates used to all be 2+ days out, so it always would be)
doesn't sit there looking broken — see the mock provider fix below. Map stays as a real second
mode via a segmented Browse/Map control in the header, not a permanently-visible box competing
with the rails for space.

## #explore-desktop-split

Superseded most of #explore-rails above: the Browse/Map segmented toggle was making desktop
choose between the discovery list and the map, on a viewport wide enough to show both — most of
that width just sat empty as page background either way, and demoting the map behind a toggle
undersold the one feature (real venues, real locations) nothing else in the product does.
Rebuilt around a real split-view at ≥900px: a discovery column (44% width, 400-580px) and a
permanently-visible map filling the rest of the viewport, never toggled. `.explore-desktop-split`
is deliberately NOT nested inside `.page` — that class's 720px reading-width cap is right for a
column of text, wrong for a map meant to fill the remaining screen. Mobile keeps the segmented
Browse/Map toggle (there genuinely isn't room for both), but Map mode is now a full-height map
with the matching event cards as a swipeable strip *overlaid* on its bottom edge (a gradient
mask, not a second panel splitting the height) — the same card↔marker relationship as
Citymapper/Uber: a marker tap selects/previews (pans the map, scrolls the strip to match,
highlights both), a card tap opens the full detail sheet.

Both the mobile map block and the desktop split exist in the DOM at the same time — which of
them is visible is a pure CSS media-query decision, exactly like the rest of the app's
mobile/desktop split. That's fine for ordinary markup, but Leaflet doesn't tolerate mounting
inside a zero-size `display:none` container: it throws (`Invalid LatLng (NaN, NaN)`) while
measuring its own pixel origin, which is a crash the app's error boundary catches — a real,
reproducible bug this design pass caught in its own Playwright verification pass, not a
theoretical one. Fixed by tracking real viewport width in JS (`matchMedia('(min-width: 900px)')`)
and gating which of the two call sites is actually allowed to mount `<ExploreMap>`, independent
of which one CSS currently shows — the other renders the same loading/empty states, just never
Leaflet.

Card imagery: a picsum.photos-seeded "real photo" was tried and dropped (see #image-fallback-
layering below) — every mock/sample event (and any live-provider event without its own photo)
now gets `CategoryArt`, a shared designed fallback (gradient wash + a large low-opacity category
mark bled off one corner + a small uppercase label) instead of an emoji floating alone in a flat
box. Tiles come in three real sizes (hero/rail/strip), not one repeated card stretched to fit
different rails.

Sidebar (`TabBar.tsx`, shared by every desktop page, not Explore-specific): a plain stack of
links read as an admin tool's nav rail because it had no anchor at either end. Added a slim gold
accent bar on the active row (not just a background tint), a soft chip behind each icon, and — the
detail that actually matters — a pinned account row at the bottom (avatar + name + "View
profile", `/users/me`-backed) separated by a rule, the same "your identity always lives in the
same place" pattern Slack/Discord/Linear/Spotify all use. Hidden below 900px; mobile's bottom bar
is unchanged.

## #image-fallback-layering

A photo URL existing and that photo successfully loading are two different things — a slow
network, an expired/broken provider link, or (as hit repeatedly building this in a sandbox
that blocks the image CDNs used) a blocked host all leave a plain `background-image: url(...)`
rendering nothing, a blank box, with no visible failure. `categoryStyle.ts#categoryBackground`
fixes this at the CSS level rather than needing an `<img onError>` handler everywhere: it
layers the photo and the category gradient in one `background` shorthand value
(`url(...) center/cover, <gradient>`) — a failed top layer is simply transparent, so the
gradient underneath always shows through instead of nothing. Applied everywhere an
Experience/Plan image renders (Explore's rails and detail sheet, Home's hero and ideas rail,
Plans, Crew chat's event cards).

Same trip wired a real, previously-latent bug in the mock ticketing catalogue: category was
assigned via `index % 3` completely decoupled from the artist/venue, and every listing's
`daysOut` had a uniform 2-day minimum — so "Tonight" could never have content and "This
weekend" often wouldn't either. Both fixed: category now comes from a coherent (name, venue,
category) tuple, and the first two listings are pinned to today/tomorrow specifically so the
near-term rails always have something to show.

## #message-preview

Anywhere a Crew's `latestMessage.body` is shown outside the actual conversation (Home's
activity feed, a Crew tile on Home/Crews) — a "📍 Sent X to the Crew — /plans/slug" system
message was rendering with its raw internal `/plans/slug` suffix intact, which only means
something to chat's own link-detection regex and reads as a raw URL fragment everywhere else.
`lib/messagePreview.ts#messagePreview` strips it down to the human part ("📍 Sent X to the
Crew") for every non-chat surface.

## #social-first-architecture

Product correction, not another visual pass: Plot was drifting toward "a weaker event platform
with group chat attached" — Home led with discovery, Explore was the implicit centre of
gravity, and the loop from "someone suggests something" to "we're actually going" ran through
too many separate screens. The core entity is the Crew deciding something together, not the
Experience; discovery feeds that loop, it doesn't lead it. Concretely: Home's section order is
now Your People → Needs You → In The Groups (activity feed) → Next Up → For your Crews (small,
last); the nav's `Explore` became `Discover` and stayed exactly where it was in priority (fourth
of five, after Crews); the Crew composer got a `+` action sheet as the one entry point into
every way of adding something to a conversation (suggest, share, poll, check availability, log
a plan) instead of "leave the Crew, open Explore, come back." Discovery (map, Ticketmaster/mock
providers, category art) is unchanged underneath — this was a re-composition of what leads,
not a rebuild of what exists.

## #decision-objects

Polls and availability check-ins are native conversational objects (`MessagePoll`, one-to-one
with a `CrewMessage`, `kind: GENERAL | AVAILABILITY` — the same mechanic, a different label and
option set), not a bolted-on feature with its own screen. A poll renders inline in the
conversation with live tally bars and one-tap voting (`MessagePollVote`, unique per
`(pollId, userId)`, re-voting replaces rather than accumulates — the same semantics
`MessageReaction` already used). Once anyone's voted, the leading option gets its own
`Lock in "<option>"` button right on the poll card: tapping it creates a manual Plan titled
`<question> — <option>` and locks it in one motion, so "we decided" becomes "we're doing this"
without a separate "now go make a Plan" step. Reused the poll mechanic for availability rather
than building a second object type — a "when works?" check-in is structurally identical to a
poll over dates.

## #manual-plans

`Plan.experienceId` was already nullable, but nothing actually created a Plan without one —
every real-world plan that isn't a ticketed event ("Pub Saturday", "Dinner at Sarah's", a poll
answered and locked) had nowhere to go. Added `Plan.manualVenueName`/`manualStartsAt` (both
nullable) rather than forcing a synthetic Experience/Venue row for something with no real
coordinates: a Plan now reads either its `experience` relation or these two fields, never both.
Every surface that renders a Plan's venue/date (`listUpcomingPlansForUser`, the public Plan
Card at `/plans/[slug]`, Home's hero) falls back to the manual fields — the public Plan Card
specifically didn't crash on a null `experience` (it was already guarded), but it silently
showed no date/venue at all for a manual Plan until this fix, which is its own real gap
(discovered by actually creating and viewing one, not by code review).

## #lock-it-in

`derivePulseStatus`'s own comment referenced a `markBooked` function that was never actually
implemented — there was no code path that transitioned a Plan to `BOOKED` except as a side
effect of creating a real `Booking` record, which meant a Plan with nothing to book (a manual
plan, a locked poll) could never reach "confirmed" at all. Added `lockPlan(planId, userId)`: a
direct, explicit status transition to `BOOKED`, independent of booking, posting a system
message ("🔒 ... was locked in — see you there.") into the conversation so the moment shows up
where the decision happened. `POST /plans/:id/lock`, membership-checked like every other Plan
route. A ticketed Plan can still go on to a real Booking afterward; this just marks the group's
actual decision.

## #invite-preview

Tapping an invite link used to auto-attempt joining immediately, which 401s for anyone not
already signed in and silently redirects straight to a generic `/auth` login wall — no context
about what they're joining. `GET /crews/preview/:code` is deliberately public (no `requireUser`)
and returns the minimum safe to show a stranger — Crew name, member count, first-initial
avatars, never message content or emails — so `/crews/join/[code]` can show "You're invited to
Weekend Crew — 6 people are already here" and a real "Join Crew" button before any auth wall.
Auth's `next` param already carried an invite through sign-in; it now also carries through
onboarding (a brand-new user completes name/location/interests before landing back on the
invite, not on generic Home). The one gap this surfaced: returning to the invite page already
authenticated (post-onboarding) showed the same "tap to join" screen again instead of
completing automatically — fixed with a second effect that auto-joins on mount if a session
already exists, so the explicit tap is only ever required once, for a first-time unauthenticated
visitor.

## #auth-callback-dedup

Found via actually clicking through the invite→auth→callback flow in a browser (not API-only
testing): the magic-link token is single-use, and `/auth/callback`'s effect can genuinely fire
its API call more than once for the exact same token — React 18 dev-mode StrictMode
double-invokes effects, and separately, a same-origin `<a href>` into this route from elsewhere
in the app is a Next.js App Router client-side transition that mounts a fresh component
instance, so a component-scoped guard (`useRef`) doesn't survive it. Fixed with a module-level
`Set<string>` of tokens already requested, keyed by the token itself — the only thing that
survives both a StrictMode replay and a genuine remount within the same page load. Real users
never hit the in-app "Continue" link this bug lives on anyway (a magic link is always opened
fresh from an email client, which is the path already confirmed working); the dev-only
"Continue" shortcut this session used for testing was the actual trigger. Fixed regardless,
since it's a real latent bug and the fix is free.

## #uk-wide-location

Audited for London defaults per the brief and found several: Explore's city query defaulted to
`'London'` server-side, Home's "ideas" fetch and new-Crew creation hardcoded `?city=London` /
`defaultCity: 'London'` client-side, and `findUsSomething`'s inventory sync fell back to
`'London'` when a Crew had no `defaultCity`. All now resolve through the same chain — the
Crew's own city, else whoever's asking's home city (`Profile.homeCity`, set in onboarding), else
a genuinely UK-central fallback point (Birmingham, not London) — never a bare hardcoded city
name. `data/ukPlaces.ts` is a small curated gazetteer (real towns/cities, real approximate
coordinates — public geographic facts, not fabricated inventory) backing `/locations/search`,
since this environment's egress proxy blocks the geocoding APIs (Google Places, Mapbox, OS
Names) a real deployment would use instead — swapping one in means replacing
`searchUkPlaces`'s implementation, not the `/locations/search` contract. The mock
ticketing/restaurant providers are now genuinely city-aware: London keeps its existing venue
set, Stafford/Stone/Cannock/Stoke-on-Trent get a second, equally real Staffordshire set (real
venue names and coordinates — Trentham Gardens, Victoria Hall, The Sugarmill, Katie
Fitzgerald's, The Moat House, Twelve, etc.), and any other requested city gets an honest empty
result rather than another city's data silently relabelled under the wrong name (a real bug
caught before shipping: `ProviderListing`'s `(providerId, providerListingId)` unique key would
have let a Stafford sync overwrite a London listing that happened to share the same lineup
index, if the mock `externalId`s hadn't been made city-scoped). Real UK-wide event coverage
(gigs/festivals/restaurants beyond this curated sample) requires a live provider key — see
CREDENTIAL BLOCKERS.

## #smtp-email

Postmark's account-approval process turned out to reject/stall a personal-Gmail-only signup —
a real blocker for anyone without a work email or their own domain, discovered by the user
actually trying it, not something the earlier "use a Sender Signature" guidance anticipated.
Added plain SMTP as the primary path (`lib/email.ts`, checked ahead of Postmark): any mailbox
you can already log into, Gmail's `smtp.gmail.com` + an App Password specifically, needs no
domain, no third-party account review. Postmark stays available (better deliverability
reputation at real volume) for whenever a verified domain exists. See
docs/providers/email.md.

## #eventbrite-adapter

Added `src/providers/live/eventbrite.ts` (self-serve, free, no partner agreement — unlike
DICE/OpenTable/Resy/SevenRooms, all confirmed partner-gated, see docs/providers/ticketing.md
and restaurants.md) so more than one live ticketed-events source can run at once — the
registry now includes every live provider whose credential is configured, not one replacing
another. Flagged honestly rather than presented as confirmed-working: Eventbrite significantly
restricted public event search around 2020, and this environment can't reach their API to
verify a fresh self-serve key can still search all-public events versus only the key-holder's
own organisation's — the adapter file's own top comment has the one curl command to confirm
which, and what to tell me if it's the latter.

## #auto-migrate-on-deploy

Root cause of the production "Something went wrong" on onboarding's final step: Render deploys
new code on every push but never runs `prisma migrate deploy` on its own — that's a separate
step. The `#social-first-architecture` migration (new `Profile.homeLat`/`homeLng` columns, the
`MessagePoll`/`MessagePollVote` tables) shipped as code but was never applied to the real
production database, so the first request touching those columns (`POST /users/me/profile`,
called by onboarding's "Let's go") 500'd. Confirmed as the cause rather than assumed: no other
plausible failure fit the shape (fresh account, first-time profile write, generic error message
implying an unhandled server exception rather than a validation error).

Render's Shell (an interactive terminal into the running container, which would have let this
be run by hand) turned out to be gated behind a paid plan on the Free tier actually in use —
not assumed available. Rather than depend on Shell at all (paid-only, and a manual step that'd
have to be repeated by hand after every future migration), `apps/api/package.json`'s `start`
script was changed to run the migration itself before booting the server. Render always runs
the start command on deploy, on every plan tier, so this applies any pending migration
automatically with nobody needing to remember a manual step.

The first version of this (`"start": "prisma migrate deploy && node dist/src/server.js"`) hit a
second, more specific problem on the real deploy, confirmed via Render's own logs: `P3005`,
"the database schema is not empty" — this production database has real tables in it but no
`_prisma_migrations` history table, meaning it was provisioned by something other than
`prisma migrate` at some point in its life (before this session), so Prisma has no record of
what's already applied and refuses to guess rather than risk re-running `CREATE TABLE` on
objects that already exist. Fixed with `scripts/migrate-and-start.sh` (what `start` now runs),
which lets Postgres itself be the source of truth instead of assuming which migrations predate
tracking: it attempts a normal deploy, and if a specific migration fails because its own
objects already exist (`P3018` — meaning that migration's whole transaction rolled back
untouched, since Postgres DDL is transactional, so nothing partially applied), that migration's
target state is therefore provably already true of the database, and only then is it marked
resolved (`prisma migrate resolve --applied`) and the deploy retried. This converges on
applying only what's genuinely new regardless of how many migrations predate this database ever
being tracked by `prisma migrate`, without needing me to assume or the user to manually
diff a live production schema I can't otherwise inspect from this environment. Both `migrate
deploy` and this whole script are no-ops (fast, safe) once there's nothing pending, so it's
free to leave in permanently rather than only for this one incident.

## #migrate-p3009-rollback

The timeout fix above (bounding every `prisma` call so a stalled connection fails fast instead
of hanging) surfaced a real third failure on the very next deploy: `P3009`, "found failed
migrations in the target database." Root cause, confirmed by the timeline in the logs: the
*previous* deploy attempt had correctly caught `add_crew_messages` already existing (`P3018`)
and started resolving it — then got `SIGTERM`'d mid-resolve by Render's own port-scan-timeout
kill, before the timeout fix existed to prevent that hang in the first place. That left a
"started... failed" row sitting in Prisma's own migration-history table, which blocks every
subsequent deploy from touching anything until it's explicitly cleared — a real, one-time
consequence of the earlier hang, not a new independent bug.

`scripts/migrate-and-start.sh` does NOT auto-resolve a P3009 migration as "already applied" —
deliberately, unlike the P3018 case, nothing in a P3009 error actually proves the migration's
objects exist. It's marked `--rolled-back` (Prisma's own documented recovery step, which clears
the stuck status and makes the migration eligible to be attempted again) and the deploy is
retried — routing back through the P3018 branch, which only ever resolves a migration as
applied once Postgres itself has said "already exists" for it. Every recovery path in this
script now ends at a real, Postgres-verified fact, never an assumption about database history
this environment can't otherwise inspect.

## #v2-crews-and-sheet-fix

Two real gaps between "code says v2" and "actually looks like v2," both found from the user
directly using the deployed app rather than assumed:

1. **Crews list (`/crews`) was never converted.** Crew chat itself (`/crews/[id]`) already was —
   Home, Explore, auth and onboarding too — but the list screen you land on from the Crews tab
   was still the original dark system entirely (`--ink-*` palette, old `TabBar`). Rebuilt on the
   same primitives as Home V2 (`.v2-page`, `.v2-card`, `.v2-eyebrow`, `TabBarV2`) — same data and
   logic, only the presentation changed.

2. **`BottomSheet` was never made v2-aware, even on pages that already were.** Crew chat's "+"
   composer sheet and Crew-info sheet, and Explore's filter sheet, all sit on top of pages
   styled in the new light system but the shared `BottomSheet` component hardcoded the *old*
   dark palette (`--ink-surface`) — both variables are defined globally on `:root`, so nothing
   errored, it just always rendered the wrong one. This is very likely what actually read as
   "the Crews section is still dark," more than the list page itself: the sheet is what you see
   the moment you tap "+" mid-chat. Fixed with a `variant="light" | "dark"` prop (default
   `"dark"`, so every untouched old-system caller — Crews list creation sheet, Profile once
   converted — needs no change) rather than forking the component.

Also fixed the onboarding-skip bug reported alongside this: `/auth/callback` decided "already
onboarded, skip straight to Home" based only on whether *any* `tasteProfile` row existed —
including one saved from testing earlier this session, before today's location step (and its
`homeLat`/`homeLng` columns) existed at all. A real account hit exactly this: taste data from
weeks-old testing meant the *current* onboarding wizard, interests screen included, never showed
again on a fresh sign-in. Now requires `profile.homeLat` to be set too — a signal only the
current LocationSearch step can produce, so it can't be satisfied by stale pre-migration data.

Plans and Profile are still on the old dark system — not yet converted, next in line.

## #v2-full-rollout

Finished bringing the whole app onto the v2 design system started with entry/onboarding/Home
(see #v2-art-direction, #v2-crews-and-sheet-fix): Plans list, the public Plan Card (the page
that gets shared into WhatsApp/iMessage — brief §16, real growth-mechanic surface, so it
mattered as much as anything behind auth), the booking flow, Profile, and the small utility
pages (`error.tsx`, `not-found.tsx`, the auth-callback loading state) that would otherwise have
been the one place the "this is one coherent app" illusion broke. Same data and logic
everywhere — this was presentation only. Added two small new v2 primitives along the way that
didn't exist yet: `.v2-chip` (Profile's static "Into" tags) and `.v2-pulse-flames`/
`.v2-pulse-flame` (the Plan Card "how many are in" strip). No page in the app is still on the
old dark system.

## #migrate-p1002-lock-retry

One more real, transient failure surfaced right after the P3009 fix: `P1002`, Prisma timing out
(10s) waiting to acquire Postgres's migration advisory lock. Root cause, confirmed by the
timing: two commits landed close together, triggering two near-simultaneous Render deploys —
the second one's `migrate deploy` hit the lock while the first's was still mid-check and holding
it. Nothing wrong with the schema or database; this just needed a wait-and-retry, not a resolve
or rollback, so it's now handled with a 5s sleep and another attempt rather than falling through
to the "not a known-recoverable case, exit" branch that treated it as fatal.

## #explore-map-key-and-overlap-fix

Three real bugs on Explore, all confirmed via a live screenshot rather than assumed:

1. **The map showed "API KEY REQUIRED" tiled across every tile instead of a map.** CARTO's
   basemap CDN (`basemaps.cartocdn.com`) now requires an account/API key we don't have — without
   one it serves a plain placeholder graphic per tile. Switched both map components to
   OpenStreetMap's own standard tile server, genuinely free and keyless. Tradeoff: OSM's usage
   policy asks production apps not to hotlink it at real scale — a real future consideration
   once there's meaningful traffic, not a pilot-scale one.
2. **The compact map-marker preview card and the full "Share to Crew" detail sheet rendered
   simultaneously, overlapping**, because `selectedId` (which the preview keys off) never
   cleared when the full sheet opened (`openDetail` sets both `selected` and `selectedId`).
   Hidden the compact preview whenever the full sheet has taken over.
3. **Some event cards read as plain black rectangles** — real, often genuinely dark event
   photography (gig/tour promo shots from the live provider) compounded with the card's own
   bottom-scrim gradient. Tuned the gradient down (55%→100% instead of 42%→100%, lower peak
   opacity) so more of the actual photo shows through. Not a full fix for an inherently
   very-dark source photo — that's real provider content, not a code bug — but meaningfully
   better for the common case.

## #v2-interaction-polish

A broad "make it feel slicker" pass across the shared v2 primitives, since fixing these once
lifts every screen that uses them rather than one page at a time: `.v2-btn-ghost`/`.v2-btn-dark`
had no hover state at all (only brand did), `.v2-btn` had no disabled styling (relied on each
call site remembering its own `opacity` inline), and every card-shaped `<Link>`/`<button>`
(Crews/Plans list rows, Home's "Needs you", the composer's action-sheet rows) sat completely
flat on hover — no lift, no shadow change, nothing to signal "this is clickable" beyond the
cursor. Added a real hover-lift (`translateY(-2px)` + a deeper shadow) gated behind
`@media (hover: hover)` specifically so it only ever applies to devices that can actually hover
— a `:hover` state sticking after a tap is what makes buttons read as unresponsive on touch,
which is most of this app's real usage. `.v2-hoverable` extends the same lift to tile-shaped
surfaces that can't use `.v2-card` directly because they carry their own photo background
(Explore's cards, Home's hero/idea tiles, Crew chat's EventCard).

Also fixed two concrete "feels broken" gaps found on inspection: `LocationSearch`'s results
dropdown had zero hover feedback on its option buttons (pure inline styles, no way to express
`:hover` without a class) — added one, plus a "Searching…" and a real "No UK towns or cities
matched" state where there was previously just an empty gap. Onboarding's interest chips and
Crew chat's reaction pills had no hover/press feedback either — same `.v2-chip-toggle` fix
applied to both.

## #autonomous-rebuild-batch-1

First batch of the autonomous product rebuild (full brief in this session's own history —
"PLOT — AUTONOMOUS MASTER BUILD"). Verified against a real multi-user local run (3 separate
browser sessions: create Crew → invite → two people join → chat → reaction → availability poll
→ both vote → lock it in → Plan appears in Crew/Home/Plans for every session independently →
survives a full reload), not assumed from reading the code.

**Real bugs found and fixed by that test, not by inspection:**
- Invite landing showed "You're invited to Weekend Crew" with no attribution — added the Crew
  creator's name ("Will invited you to..."), since the invite is crew-level (one shared link,
  not a personalised per-invite token) so the creator is the only honest "who" available.
- Crew chat's message list had no de-duplication: two overlapping `poll()` calls (React
  StrictMode double-invoking the effect in dev; a slow response racing the next 3s tick in any
  environment) rendered the same message twice and, once that happened, out of chronological
  order — directly observed as a duplicated, "Locking in…" stuck on two copies of the same poll
  card. Fixed by merging into a Map keyed by message id and re-sorting by `createdAt` on every
  poll, so a duplicate fetch is now a no-op instead of a second bubble, regardless of cause.

**Desktop composition rebuilt, not just widened** — the real bug behind "no character, huge dead
space" wasn't `.v2-page`'s own 560px max-width (that's correct for a phone-width reading
column), it was that the *same* 560px cap applied unchanged inside the desktop shell too, so a
1600px window rendered a stretched mobile column with a void beside it. Home gets a real
two-column composition (`.v2-home-split`): the feed at full available width plus a persistent,
functional "Your Crews" rail (Slack/Discord-shaped, real content — every Crew with its own
live activity line — not decoration) — `.v2-home-main .v2-page` override removes the inherited
mobile cap so the feed actually uses the space. A soft decorative background wash
(`.v2-home-glow`, the same radial-gradient-blob treatment the invite-landing page already used)
and a bolder, accent-underlined greeting replace flat cream + plain black text. Crews/Plans/
Profile get a lighter version (`.v2-page-wide`, 880px) plus a real multi-column grid for card
lists (`.v2-card-grid`) instead of one long full-width stretched row.

**Repo audit for the remaining London hardcoding** the brief asked for: found and fixed four
spots the earlier `#uk-wide-location` pass had missed because they're admin/ops-only, not
user-facing — `POST /admin/sync`'s and the manual-experience-entry endpoint's default city, and
the Ticketmaster/Eventbrite health-check smoke-test city — all now use the same
`UK_FALLBACK_CENTER` (Birmingham) constant every user-facing fallback already uses, instead of a
separate, unaudited London default living in ops tooling.

**Also found via that same audit**: Birmingham — this app's own UK-central fallback city, and
one the brief names directly — had zero mock event or restaurant coverage; a user who landed
there (by choice, or by the fallback itself) with no live provider configured saw a genuinely
empty catalogue. Added real Birmingham venues to both mock providers (two of the event venues,
O2 Institute and Utilita Arena, independently confirmed real by live Ticketmaster results seen
in production, not just general knowledge).

**Security spot-check** (not a full audit, but the brief's explicit "a user must never change a
Crew UUID and read another private Crew" case specifically): every Crew-scoped route requires
`requireUser` and checks real membership (`getCrewDetail`/`isCrewMember`, 404 not 403 on a
non-member's poll/message lookups so membership in *another* Crew can't be used to probe
existence) — confirmed by reading every route in `routes/crews.ts` and `routes/plans.ts`, not
assumed. Session cookie is `httpOnly`, `secure` in production, `sameSite: lax`. No
`dangerouslySetInnerHTML` anywhere in the web app. Known gap, not yet fixed: no rate limiting
beyond magic-link requests (message send, poll vote, react, join-crew are all unlimited) —
low-risk at pilot scale (a handful of real, known friends) but a real pre-launch item.

## #mobile-overflow-and-signup-funnel-fix

Two more real bugs, both found by actually testing rather than reading code:

**Every form field in the app overflowed the viewport horizontally on a real phone width
(390px)** — confirmed via Playwright measuring `document.documentElement.scrollWidth` against
`clientWidth` across the onboarding/auth/chat/explore flow, not assumed. Root cause: despite the
universal `* { box-sizing: border-box }` rule, a plain `<input>` with the browser's native
`-webkit-appearance: auto` widget rendering doesn't fully respect an author `box-sizing`
declaration in Chromium — the padding this app sets on every input (15px 18px etc.) was being
added on top of `width: 100%` instead of absorbed into it, pushing every text field 20-60px past
the right edge on a real phone. This is exactly the "mobile-first for real testing" failure mode
the brief calls out, and would have hit literally every real friend on their first attempt to
sign in. Fixed globally with `appearance: none` on `input`/`textarea`/`select`.

**The signup analytics funnel was tracking the wrong thing.** `SignupStarted` only ever fired at
the *end* of auth, and only for a *returning* user's login (`consumeMagicLink`'s
`isFirstLogin ? SignupCompleted : SignupStarted`) — meaning it never fired at the actual moment
someone starts signing up, and instead fired on every routine returning login, which would have
made the funnel backwards and uninterpretable (far more "started" events than real new-signup
attempts, and none of them near the real start of the flow). Fixed: `SignupStarted` now fires in
`requestMagicLink`, the real "someone is starting an auth attempt" moment; `SignupCompleted`
only fires on a genuine first-ever session, and a returning login is no longer force-tracked as
a signup-funnel event at all.

## #crew-desktop-rail

Same fix pattern as Home's split layout, applied to Crew chat — the single most important
screen per the brief's own priority order ("make this the strongest part"). The conversation
column staying a fixed, readable width on desktop is correct (WhatsApp/iMessage desktop both do
this deliberately), but the dead space that used to sit beside it wasn't. Added a persistent
Crews-list rail (`.v2-crew-split`/`.v2-crew-rail`) beside the active conversation — the actual
layout WhatsApp/Slack/Discord desktop all use, not a coincidence: it's real navigation (every
Crew, its own live activity line, the current one highlighted), the same rail component
introduced for Home, reused here rather than reinvented. `/crews/:id` now also fetches the full
Crew list (`GET /crews`) purely to populate this rail — no new endpoint needed.

## #bottomsheet-max-height

Real bug, confirmed via a live production screenshot on a real (not maximised, not full display
height) browser window: `BottomSheet` had no `max-height`, so on a shorter viewport, tall
content (an event's image + description + "Share to Crew" button) got cut off at the bottom of
the screen with no way to scroll to it — the button was rendered entirely off-screen and
unreachable. Fixed with `maxHeight: calc(100dvh - 40px)` + its own `overflowY: auto`, verified
against a genuinely short (660px) viewport where the button was previously unreachable and is
now confirmed reachable via scroll.

## #premium-material-and-motion-pass

Direct response to explicit feedback that the app "feels super basic... no branding, no real
vibe... just pages with colours" — a request for material depth, motion, texture and a stronger
brand feel, not another primitive/spacing pass. Real, concrete changes, not a repaint:

- **Film grain** — a near-invisible tiled SVG noise filter over every `.v2` page background
  (opacity 0.035, `mix-blend-mode: multiply`). The single cheapest thing that separates "flat
  colour a browser painted" from a material the product actually sits on. Caught and fixed a
  real stacking bug while building this: a `z-index: 0` positioned overlay actually paints
  *above* ordinary in-flow content per the CSS2.1 stacking order, not below — used `z-index: -1`
  instead of the naive `0` + reordering every child's own stacking, which is both simpler and
  doesn't touch anything else's positioning.
- **Glass, not flat white, on overlay chrome** — the floating bottom nav pill, the desktop nav
  rail (now a real gradient block, not a flat plum fill), and every light-variant `BottomSheet`
  now use `backdrop-filter: blur() saturate()` over a translucent surface. Content surfaces
  (cards) deliberately stay solid so text keeps full contrast — the glass treatment is reserved
  for things that float *over* content, which is where it actually reads as a real material.
- **An actual motion system**, not isolated hover states: a slow (22s), barely-perceptible
  ambient drift on every decorative gradient background (landing, invite-landing, Home) so the
  app reads as alive rather than a static image; a staggered entrance (`--stagger-i` + a 45ms
  delay-per-index) on every card list (Crews, Plans, Home's people row) so a list arrives as a
  considered sequence, not everything popping in at once; and a real "Lock it in" celebration —
  brand-coloured dots bursting from centre and fading over ~700ms, the one moment the brief
  explicitly said deserved a little delight ("we've stopped talking about it, this is
  happening"). The poll-lock path's navigation now waits ~550ms so the celebration is actually
  seen before the page changes, instead of being cut off by an instant redirect.
- **Bolder, more editorial typography** — display type moved from weight 700 to 800 with tighter
  (-0.03em vs -0.02em) tracking, a small change that reads as more considered/designed rather
  than default-weight-plus-a-nice-font.

Everything here respects `prefers-reduced-motion`. None of it touches product logic — this is
presentation only, same data and behaviour as before.

## #plot-design-reset

Direct response to explicit, repeated rejection of the whole "v2" visual direction — "the front
end is not what I want at all... it just feels super basic... no real vibe... just pages with
colours" and, after a decoration-only pass, "visually its fucking shite... everything I've been
stressing about all day is still fucking shite." The instruction was explicit: stop polishing the
existing direction, replace it. This is that replacement, not another effects pass on top of it.

**Root-caused and fixed the map/detail overlap, for real this time.** Two earlier fixes had
already landed and both were re-reported as still broken. Root cause: `BottomSheet` is a mobile
pattern — fixed, centred across the *entire* viewport width via `margin: 0 auto` — and it was
being used unconditionally for Explore's event detail, including on the desktop split. Opening a
detail on desktop floated a phone-width card dead-centre of the whole window, landing on the seam
between the results column and the map pane regardless of either pane's actual width — no
z-index or margin tweak could fix that, because the component itself doesn't know the split
layout exists. Fixed by removing BottomSheet from the desktop code path entirely for this case: a
detail view now renders inline inside the results column (with its own "← Back to results"),
physically incapable of overlapping the map pane. Verified with a fresh Playwright run reproducing
the exact reported scenario (click a marker → View details, at 1440×900) before and after —
screenshots in the session record. `BottomSheet` itself also gained a proper desktop mode (a
centred dialog, not a stretched sheet) for its other callers (Crew's "+" menu, Crew info, Crews'
create flow, Profile's danger actions).

**The "v2" visual system is gone, not iterated.** Removed outright: the dark-plum/coral palette,
film grain, glass/backdrop-filter on every surface, perpetual ambient-gradient drift, and
Bricolage Grotesque as the display face. None of these were wrong in isolation — the direction
underneath them was the actual problem, so restyling them wasn't going to fix it.

Replaced with:
- **Palette** — warm porcelain ground, a true near-black warm ink (no purple, anywhere) for text
  and dark surfaces (the desktop nav rail, "mine" chat bubbles, dark buttons), and ONE confident
  brand colour — a warm flame-orange-red — used deliberately for actions and the one accent that
  means "this matters," not smeared across gradients as a decorative wash. A muted amber and a
  grounded green round out the system for price/rating and confirm states.
- **Type** — Fraunces (a real display serif) for every heading and hero moment instead of another
  geometric grotesque. This is the single biggest lever here: a serif display face paired with
  Inter for UI text reads as editorial and considered rather than "SaaS dashboard," which is
  exactly the "premium, high-cost development" register that was asked for and wasn't landing.
- **Decoration is opt-in, not default.** No card, panel or button carries a gradient, blur or
  animation unless a specific interaction earns it — the lock-in celebration, a sheet's open
  transition. Quality now has to come from composition, type scale and spacing, not effects.
- **Event/plan fallback art** — replaced the three-radial-blob "neon poster" treatment (the exact
  thing that made Explore/Home read as Ticketmaster/Fever) with a single confident duotone wash
  per category, ink-anchored. Still legible under text, no longer competing for attention.
- **A real brand entrance** — the landing page now opens with a colour-blocked header, a large
  serif headline with one word set in the brand colour, and a three-step "Talk → Decide → Go"
  strip, instead of a gradient-blob hero. Auth/onboarding/404/error all carry the same italic
  serif wordmark instead of a repeated square "P" badge (a few of these — onboarding, 404, error —
  still use it as a placeholder in the very first frame before the icon renders; low priority,
  noted as remaining work).

**Home and Crew were largely correct in composition already** (people-first avatar row, "Needs
you," a real activity feed, discovery demoted to a small strip at the bottom on Home; minimal
chrome, grouped bubbles, native poll/plan objects, avatars only where they carry information on
Crew) — the failure was almost entirely the visual language layered on top, not the information
architecture. Both got the full token replacement plus one real structural fix each: Home's
decorative animated glow/accent-rule removed outright (no more perpetual background animation);
Crew's floating bottom nav pill was found — via the real two-user test below, not by inspection —
to sit directly over the message composer on mobile (a full-width fixed sheet with no reserved
clearance for a second fixed-bottom element). `TabBarV2` gained a `hideMobile` prop and Crew now
hides the pill on mobile entirely, the same "full-screen conversation, back arrow gets you out"
pattern WhatsApp/iMessage use — verified fixed via DOM inspection (`display: none` on
`.v2-nav-bottom` on the Crew route) after the change.

**Verified with a real two-independent-session friend test**, not one browser simulating two
people: user A (desktop, 1440×900) created a Crew and got an invite link; user B (mobile,
390×844, a completely separate browser context/cookie jar) followed it, joined, and the two
sessions chatted for real — A's and B's messages both appear correctly attributed, in order, on
both sides after independent polling. A posted a "When works?" availability poll (a native
in-chat object, not a separate screen); B voted from their own session; A locked it in. The lock
produced a real Plan that then appeared, from a fresh reload, in: Crew chat (a confirmation
message), Home's "Next up" hero and "In the groups" activity feed, the Crews list's activity line,
the Plans list, and the plan's own public share-card page — for *both* users independently.
Screenshots for every step are in the session record.

Multi-viewport coverage: 390×844, 430×932, 768×1024, 1440×900 and 1728×1117 for Entry, Auth, Home,
Crew and Explore.

**What's still weak / not done in this pass:**
- Explore's *composition* (not just its colours) is still close to the original — a search bar +
  2-col grid + map split. It works and no longer overlaps, but "a completely new visual
  composition" for discovery+map together (the brief's own words) is a further pass, not this one.
- Crews/Plans/Profile/onboarding/invite inherit the new tokens and read consistently, but none got
  their own dedicated composition pass the way Home/Crew/Entry did.
- The onboarding/404/error square "P" mark (not the wordmark) is unreplaced.
- No further motion system beyond what already existed (lock-burst, sheet transitions, list
  stagger) — deliberately not expanded, per "motion should be functional... avoid decorative
  perpetual animation unless there is a very strong reason."

## #plot-design-reset-2

The first reset (above) was itself rejected outright: "visually its fucking shite... this hasn't
changed at all." Rather than guess a third visual direction blind, asked for and got three named
references with explicit roles instead of vague "premium" adjectives — Partiful for FEEL, Geneva
for social STRUCTURE, Apple Invites for the execution QUALITY BAR — and built directly off that,
not off another round of my own taste.

**The one fact this pass is built on**: Partiful's own UI runs on near-black as its primary
action colour — filled black buttons, black text, black borders — not a bright brand hue; colour
lives in imagery, gradients and avatar identity, not in chrome. Every attempt before this one put
a bright colour ON the buttons and chrome instead (coral, then flame-orange), which is very
plainly why it kept reading as "a SaaS product with a colour," never as Partiful. This system
inverts that:

- **Palette** — white/near-white canvas (`#f6f6f4`), true near-black ink as the ONE UI action
  colour (buttons, the "mine" chat bubble, primary CTA text/links), and a small "confetti" set
  (pink/violet/blue/yellow/green/orange) used ONLY for imagery, avatar-ring identity, category
  art gradients, and the lock-in celebration — never as a button fill. One signature accent
  (`--v2-pop`, a vivid pink) carries the brand thread in small identity moments — an unread dot,
  an eyebrow label, a selection ring, the "needs you" stripe, one coloured word in a headline.
- **Type** — Archivo at black (900) weight, tight tracking, for every heading/hero moment,
  replacing the previous pass's Fraunces serif. Partiful's own system pairs a bold grotesque
  display face with a grotesque UI face — no serif anywhere.
- **Event/plan fallback art** — full-bleed vivid gradient washes per category (confetti-palette
  colour → near-black), directly matching Partiful's own "purple-to-pink hero" convention,
  replacing the muted ink-to-category-tone duotone from the previous pass.
- **A real collage device on the entrance screen** — three small rotated "plan card" tiles
  (Partiful's own invite-card pattern, scaled down), each straightening + lifting toward the
  cursor on hover — the one genuinely playful, tactile motion moment on the page, not a
  decorative background effect.
- **Light chrome throughout** — the dark-plum desktop nav rail from every previous pass is gone;
  the rail and the mobile nav pill are both white/near-white now, matching Partiful/Apple's own
  restraint (colour and dark surfaces are content decisions, not chrome decisions).

**Two real bugs found and fixed while building this, not after shipping:**
- A genuine CSS specificity bug, invisible until the palette flip made it catastrophic: `.v2 a
  { color: inherit }` (one class + one type = higher specificity than a bare single-class
  `.v2-btn-brand`) was silently winning on every button rendered as a `<Link>`, inheriting the
  page's own ink colour instead of the button's intended text colour. Harmless while the button
  fill was a mid tone (dark-on-colour still read); invisible black-on-black now that the primary
  action colour is near-black. Confirmed via `getComputedStyle` before and after. Fixed generally
  — prefixed every affected rule (`.v2-btn-brand/dark/ghost`, `.v2-muted`, `.v2-dim`) with `.v2 `
  so two classes beats `.v2 a`'s class+type, rather than patching the one button that happened to
  surface it.
- Home's floating nav pill sat directly over the "Next up" hero card's caption at the initial
  (unscrolled) viewport position on mobile — turned out to be correct, expected behaviour for a
  fixed-position element over a page taller than the viewport (the card is reachable, just below
  the fold at rest), not a real bug; documented here since it looked like one on first
  screenshot and is worth not re-litigating.

**Verified with a fresh two-independent-session friend test** (desktop + mobile, separate
browser contexts) after the palette flip: signup, invite, join, chat both directions, an
availability poll, a vote from the second user, lock-in (confetti now genuinely multi-hue), and
the resulting Plan appearing on Home's "Next up"/activity feed and the Crews list, all with the
new button-text bug already fixed and confirmed correct throughout.

**Real events / real photos remain blocked on live provider credentials** (Ticketmaster and/or
Eventbrite API keys — see `providers/registry.ts`), not on anything in this pass: with no key
configured, `providerRegistry` falls back to the mock ticketing provider, which has no real
`imageUrl`s to show — the gradient art *is* the fallback for exactly that case, not a design
choice being made in place of real photography. The "Book for the Crew" deep-link flow (services/
booking.ts) is fully implemented and already wired from the Plan Card — it opens the real
provider's checkout once a real event (with a real booking URL) exists, which likewise needs a
live provider key to ever be non-mock. This is an external blocker, not unfinished work; document
it and continue.

#### plot-interaction-uplift — real motion, real optimism, real state transitions

The visual reset (above) was the shell; this pass is the part the user actually feels while
using it — reactions, poll voting, Lock It In, and chat message arrival all rewritten to be
genuinely optimistic (state updates before the network round-trip, not after), plus a real
three-tier CSS motion system (`globals.css` — pop-in, tap-feedback, settle, arrive,
confirm-transition, all `prefers-reduced-motion`-guarded) so every animation has an origin/
destination reason rather than being decoration.

- **Reactions** (`ReactionRow`): tapping an emoji updates the chip's count immediately, keyed on
  `${emoji}-${count}` so React remounts and replays the pop-in on every change — proven with a
  network-delay test (route intercepted to add 1.5s latency): the ❤️ chip was on-screen and
  counted within 80ms, an order of magnitude before the real request could have resolved. Revert-
  on-error goes through the existing `poll()` refetch.
- **Poll/availability voting** (`PollCard`/`OptionVoters`): voting moves your own avatar chip
  under the option and slides the fill bar (`.v2-settle`) instantly; the backend now returns
  `votersByOption: Record<string, string[]>` from `summarisePoll()` (chat.ts) — a reshape of
  vote rows already being fetched, not a new query — so the client can show the actual group
  converging on an option (small avatar stack), not just a bare count. The leading option gets
  an inset highlight the moment it takes the lead.
- **Lock It In** (`PollCard`/`EventCard` `justLocked`): redesigned as a real state transition, not
  confetti-on-top-of-the-same-card. The instant Lock It In is tapped, the card itself flips
  (`.v2-confirm-transition`) to a distinct green "Locked in" confirmation card with a pop-in
  checkmark — set optimistically before the network call, reverted only on a real failure.
  Verified via screenshot at both the instant-transition frame and the settled state.
- **Chat arrival**: `send()` rewritten fully optimistic — a temp message renders immediately
  (`pendingMessageIds`), reconciles to the real id on success, and shows a "Didn't send — retry"
  affordance (`retrySend`) on failure rather than silently vanishing.
- **Smart scroll** (the one requirement most likely to have been faked without a real multi-
  message test): the message list only auto-scrolls on a new message if the viewer was already
  near the bottom (`nearBottomRef`, tracked via `onScroll`); otherwise a restrained "New
  messages ↓" pill appears instead of yanking the viewport. Proven, not assumed: seeded 25
  messages into a crew, scrolled a second real browser context to the very top of history,
  sent a new message from the first user, and confirmed via `scrollTop` (stayed at 0, not
  auto-scrolled) plus a screenshot showing the pill floating above an unmoved viewport;
  clicking the pill then scrolled to the bottom. A shorter, non-overflowing conversation
  correctly does the opposite (auto-scrolls, no pill) — same code path, just nothing to
  preserve scroll position against.

**Real bug found and root-caused during verification, not by inspection**: the very first attempt
to exercise the poll flow end-to-end threw a full React error boundary ("Something went wrong")
on posting a poll. Traced via `page.on('pageerror')` to `PollCard` reading
`poll.votersByOption[option]` where `votersByOption` was `undefined` — not a code defect (the
field is unconditionally set in `summarisePoll()`), but a stale `tsx watch` process that had been
running since long before the `chat.ts` edit and hadn't picked up the new field. A clean restart
of the API dev process resolved it immediately, confirmed by re-running the identical repro with
zero errors. Documented here because it's exactly the kind of failure "prove it, don't assume it"
verification is for — a static code read would have called this fine.

**Also in this pass**: wired the now-verified `plotmaker.co.uk` Resend domain into real
transactional email — updated `EMAIL_FROM`'s default and `docs/providers/email.md` to reflect
verified-domain status (removing the earlier "might only deliver to the account's own address"
caveat, which only applies to Resend's *unverified* shared sender). The one remaining step
(setting `RESEND_API_KEY` + `EMAIL_FROM` in Render's dashboard) is outside this sandbox's reach
and documented as such — everything on the code side is done and typechecked.

#### plot-shared-idea-lifecycle — a corrected course after over-rotating on microinteractions

Immediately after the interaction-uplift pass above, a first attempt at "make it more
interactive" wrongly translated into a global CSS pass — every `.v2-btn`/`.v2-card`/
`.v2-hoverable` in the app given the same press-animation and focus ring, applied indiscriminately
by CSS class rather than by what each surface actually needed. Correctly called out and reverted
in full (`git checkout -- globals.css`) before it was committed. The lesson, worth keeping: this
product's "interactive" complaint was never about missing hover states — it was about the UI not
visibly responding to what other people in the Crew are doing. Component-level polish (button
press animation, focus rings) is real work, but it's the *last* item on this priority list, not
the first move, and never a substitute for it.

**What "product-level interaction" actually meant here**, built and proven with a real 3-browser-
context test (`Robin` shares → `Sam` and `Cam`, in separate sessions, vote and see the result
without reloading → `Robin` locks it in → `Sam`'s Home reflects it without ever having been on
the Crew page when it happened):

- **The shared-idea object (`EventCard`) redesigned with an actual life cycle**, not a flat "3/5
  in" counter. The backend (`services/plan.ts#computePlanPulse`/`derivePulseStatus`) already
  computed a full state machine — SHARED → GATHERING_INTEREST → LIKELY → READY → BOOKED, with
  maybe/out breakdown — and the public Plan Card endpoint (`/plans/public/:slug`) already
  returned all of it; the *frontend* card was the only thing throwing it away, destructuring
  only `{inCount, totalMembers}`. Now: "Robin shared this — who's in?" → "2 in so far" →
  "Likely happening · 3 in" → "Ready — 3/5 in" → "🔒 Locked in", each stage genuinely different
  copy, not the same template with a number changed.
- **Voting happens in the conversation, not on a separate page.** This was a real continuity
  gap, not a cosmetic one: there was previously no way to vote IN/MAYBE/OUT on a shared idea
  without leaving the Crew thread entirely for the standalone public `/plans/:slug` page — the
  exact "website, not a product" failure mode called out. Three inline buttons now sit on the
  card itself, optimistic same as reactions/polls.
- **Avatars converge on the card** (`OptionVoters`, reused from the poll work) — who's actually
  in, not just a count, on both the in-progress and the locked state.
- **Cross-screen propagation is real, not implied**: `EventCard`'s data now refreshes on the
  existing 3s poll cycle (skipping `BOOKED` cards, which can't change further) — voting from a
  second session shows up on the first session's already-open card without a reload. Home's
  fetch-once-on-mount was the same class of gap — added an 8s background refresh
  (`apps/web/src/app/home/page.tsx`) so a crewmate's vote or a newly-locked plan appears while
  you're sitting on Home, not only on next visit.

**Verified, not asserted**: the 3-session test above captured a screenshot at each stage
(idea shared → a voter's own "I'm in" state → convergence visible on the *original* session with
no reload → locked confirmation with converged avatars → the second voter's Home showing "Next
up" afterward) — `docs/screenshots` equivalents live in the session transcript, not committed to
the repo, but the sequence is what a real "does Plot feel alive" check requires: the idea
progressing through actual state, not a single interaction proven in isolation.

**Known gap surfaced by this same test, not yet addressed**: "Suggest something" posted three
full-size Plan Cards into the conversation at once — visually heavy for what should be a
lightweight, considered suggestion. Composer/Suggest-Something flow polish is still open work.

#### plot-suggest-something-and-crew-state — two more product-level (not CSS) fixes

**"Suggest something" redesigned as a real picker, not an auto-post.** It used to call
`/crews/:id/suggest-to-chat`, which posts every matched option straight into permanent chat
history in one go — three full-size Plan Cards landing at once, unpickable, un-undoable. Now it
calls the existing `/crews/:id/find-us-something` (already returned matches without posting
anything — this endpoint already existed for the standalone Find Us Something screen, just
wasn't reused here), shows up to 3 as tappable tiles inside the action sheet, and tapping one
sends only that one via the same `shareExperience()` "Share a place" already uses — the other
two are simply never sent, the same as browsing and picking. Verified: exactly 1 Plan Card
appears in chat after picking 1 of 3 offered tiles, not 3.

**Crew previews on Home now show actual state, not just the last message.** Every Crew read
identically before — a name, avatars, and either the last message or "Say hi", regardless of
whether that Crew was mid-decision or dormant. `crewStatusLine()` (`apps/web/src/app/home/
page.tsx`) now prioritises: a plan waiting on your vote → an upcoming locked plan → an
in-progress plan's live tally → the last message → "Say hi" — real signal Plot already computes
server-side (`activePlan.iVoted`, `upcomingPlan`, `activePlan.inCount`), not new tracking. A
Crew that needs you gets a visibly different ring (the signature pink, with a small "!" badge)
on its avatar in both the mobile "Your people" row and the desktop rail, not only smaller text
underneath — verified via screenshot showing the pink ring + "Vote needed" label distinct from
a normal Crew's ring.

**Explicit non-goal, to avoid inventing a fake signal**: a genuine "3 unread messages" state
would need a persisted per-user last-read timestamp per Crew, which doesn't exist yet — not
built here rather than faked with an arbitrary badge. A real next step, not done in this pass.

**Plans now grouped by real temporal urgency** (`apps/web/src/app/plans/page.tsx`) — a plan
tonight used to render in the exact same row style as one six weeks out. `timeBucket()` buckets
by `startsAt` alone (Tonight → Tomorrow → This weekend → Upcoming → Date TBC, real date math, no
new server field), and Tonight specifically gets a visibly different treatment: a pink card
outline, a filled pink date badge instead of the neutral one, and a one-tap "📍 Directions" link
straight to Google Maps for the venue — a contextual action that only appears for a same-day
plan, not cluttering every row regardless of urgency. Verified end-to-end: logged a manual plan
for 3 hours from now, locked it, confirmed it lands under "🔥 Tonight" with the Directions
shortcut visible, via screenshot.
