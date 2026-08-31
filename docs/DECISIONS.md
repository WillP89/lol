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
script now runs the migration itself before booting the server:
`"start": "prisma migrate deploy && node dist/src/server.js"`. Render always runs the start
command on deploy, on every plan tier, so this applies any pending migration automatically and
needs nobody to remember a manual step — `prisma migrate deploy` is a no-op (fast, safe) when
there's nothing pending, so this is free to leave in permanently rather than only for this one
fix.
