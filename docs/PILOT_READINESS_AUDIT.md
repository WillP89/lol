# Pilot Readiness Audit — working document

Started 2026-09-17, in response to the full pilot/investment-readiness mission. This is a
living document, not a one-shot report — updated at the end of each audit→fix→verify cycle.
Format per issue: **severity / evidence / root cause / fix / validation / remaining risk.**

Rule this document follows throughout: a prior session's own claim that something is "done"
(a completed task, a passing test, an implemented route) is a starting hypothesis, not a fact.
Everything below was re-verified this cycle, either by reading the actual code path end to end
or by reproducing real behaviour (mostly already forced by this session's own live production
incident with two real test Crews in Stafford — see the chat history this doc doesn't repeat).

---

## Cycle 1 — 2026-09-17

### What this cycle actually verified (not just re-read)

This session had, immediately before this mission brief arrived, already run a real live
production incident to ground: two fresh Crews in a real UK town (Stafford), materially
different tastes (House/Techno/Disco vs. Football/Boxing/MMA), both returning
`no_eligible_candidate`. That is about as close to "Phase 12 real-world pilot simulation" as
this single-session format allows, and it surfaced two genuine, serious, previously-undetected
production bugs, both now fixed and shipped to `main`:

1. **`syncProvider`'s per-listing image-enrichment loop had no time budget** — a fresh sync of a
   city with 100+ un-photographed listings (routine for FHRS) could run for minutes, which is
   exactly what turned the new admin "Sync now" button into a hard 502. Fixed with a bounded
   budget matching the pattern every other adapter's own fetch already used. This wasn't just an
   admin-tool bug — `ensureInventoryProduction` awaits the identical unbounded loop for any
   genuinely-new city, which is the exact code path a brand-new Crew's first "send a
   recommendation the moment it hits 2 members" trigger goes through. A real P0 risk for any
   first-time user in a city Plot has never synced before, not just a diagnostics-page cosmetic.

2. **The core matcher starved category-preferred Crews out by unrelated local density** —
   `scoreExperiencesForCrew`'s proximity query selected the 50 physically nearest Experience
   rows *across every category* before ever applying the Crew's own category/interest
   preference. Stafford's real FHRS feed (~130 restaurant/bar rows, all within ~2km of the town
   centre — routine for a food-hygiene open-data feed) filled that entire top-50 slice before a
   real, in-radius SPORT or LIVE_MUSIC event 15–40km out ever got a chance to be considered.
   This is not a Stafford-specific or test-data artefact — it's structural: **any city with a
   locally dense category (which FHRS makes true almost everywhere) would starve out every
   other category the same way**, for real users, not just test Crews. This was very likely
   costing every non-food-preferring Crew in the pilot real recommendations silently, with no
   error, no log line calling it out — the scorer just returned `0 scored` and reported the
   honest-sounding "nothing good enough" message, which reads as correct behaviour instead of a
   bug. Fixed by moving the preference gate before the nearest-N cut. Proven with a live,
   end-to-end after-fix confirmation on both real test Crews (one delivered a real recommendation,
   the other correctly surfaced 50 real scored SPORT candidates instead of 0).

**Why this matters for the mission brief specifically**: PHASE 4/5's own demand — "prove
different Crews get materially different, genuinely relevant results from identical inventory"
— was not just unverified before this fix, it was **actively broken** in a way that would have
made the pilot's very first week look like "Plot doesn't understand niche Crews," for a reason
that had nothing to do with taxonomy depth or scoring weights and everything to do with a query
ordering bug three layers below the part of the system anyone would have thought to inspect.
This is exactly the kind of gap Rule 1 exists for.

3. **OpenStreetMap/Overpass provider was reporting DOWN in production** with `TypeError: fetch
   failed`, confirmed via `/admin/providers` this session. Code inspection found no bug in the
   query/parsing logic — the likely cause is the single shared public Overpass instance itself
   (rate-limited or blocking this app's egress IP), a real single-point-of-failure risk that was
   already flagged as a known risk in that file's own original comments but never mitigated.
   Fixed with multi-mirror fallback (tries 2 other known, maintained public Overpass mirrors
   before giving up). **Cannot be verified as actually-fixed from this sandbox** — outbound
   network to these hosts is proxy-blocked here, same restriction documented in every live
   provider file. This needs a real production check after deploy (`/admin/providers` should
   show `openstreetmap: ACTIVE`, or at minimum a different failure mode if all 3 mirrors are
   genuinely unreachable from Render too).

### Taxonomy re-audit (Phase 3) — already substantially done, contrary to what the brief assumes

Read `packages/shared/src/tasteTaxonomy.ts` in full. This is **not** the flat "Music / Food /
Sport / Culture" taxonomy the brief warns against — it already has real depth:

- Music: house, techno, UK garage, drill, grime (deliberately kept distinct, not merged),
  hip-hop, R&B, disco, drum & bass, afrobeats, reggae, latin, and ~15 more, each as its own
  interest id with real synonym lists for matching provider genre strings.
- Sport: Premier League vs. Championship vs. League One/Two vs. non-league vs. women's football
  as *distinct* interests, plus boxing/MMA/rugby/cricket/darts/motorsport/etc.
- Food: cuisine-level (Japanese, Thai, Korean, Middle Eastern...) plus format-level (street food,
  food festivals, pop-ups, fine dining, markets).
- Explicit, documented handling of exactly the failure modes the brief worries about: a
  catch-all category (`COMMUNITY`) that providers dump under-classified events into is
  deliberately never trusted as a real signal; a category claimed by two territories (`CLUBBING`
  under both `music` and `drinks_nightlife`) is never implied from bare category membership; the
  `music` territory specifically (broadest, most genre-diverse) requires an explicit curated
  relation (drill↔grime, boxing↔MMA) rather than a blanket "any music interest matches any music
  event" shortcut — this is the exact "someone liking rock does not mean they want house" case
  from the brief, already solved, with three real historical bug writeups in the file's own
  comments proving it was found and fixed the hard way, live.

**What's genuinely unverified**: free-text/specific-artist matching (Foo Fighters, QOTSA-level
specificity) beyond the fixed taxonomy. `experienceMatchesFreeText` exists and is used in
scoring (confirmed via `match.ts` reason codes `free_text_match`), and `aiTasteSetup.ts` exists
for free-text-to-preference onboarding — but I have not yet traced whether a specific artist
typed during onboarding actually survives into a stored, matchable signal, or only maps onto the
nearest taxonomy interest. **Next cycle: trace this specific path.**

### Provider/inventory coverage (Phase 2) — honest matrix, evidence-based

| Source | Registered when | What it actually covers | Verified how |
|---|---|---|---|
| Ticketmaster | `TICKETMASTER_API_KEY` set | Major ticketed events (concerts, sport, comedy, theatre) | Confirmed live+healthy this session (2,427 listings nationally) |
| Skiddle | `SKIDDLE_API_KEY` set | Club nights, festivals, comedy, smaller/independent venues | Confirmed live+healthy this session (1,917 listings nationally) |
| PredictHQ | `PREDICTHQ_ACCESS_TOKEN` set | Broad events-intelligence aggregator — added specifically because Ticketmaster+Skiddle skew comedy/live-music for small towns | **Not confirmed whether a token is actually set in production** — not present in the `/admin/providers` health data seen this session. This is a genuine, high-leverage gap: this provider exists in code specifically to solve the exact "Stafford has thin SPORT/CLUBBING coverage" problem just proven live. |
| Google Places | `GOOGLE_PLACES_API_KEY` set | Real places (paid, pay-as-you-go past free credit) | Not confirmed configured |
| Foursquare | `FOURSQUARE_API_KEY` set | Real places (genuine free tier) | Not confirmed configured |
| FHRS | always on, no key | UK-wide restaurant/bar/food-hygiene register | Confirmed live+deep this session (1,079 listings nationally, 131 for Stafford alone) |
| OpenStreetMap | always on, no key | Restaurants/bars/clubs/cinemas/theatres/museums/fitness/day-activity, UK-wide | Was DOWN in production; multi-mirror fallback shipped this cycle, **unverified post-fix** |
| Eventbrite | never (deliberately) | N/A | Correctly NOT presented as live — code comment documents that Eventbrite's public API was killed 2020–2025; registering it would be exactly the fabricated-coverage the brief forbids. This is the taxonomy being honest, not a gap. |

**The real, actionable gap this table surfaces**: if PredictHQ/Google Places/Foursquare keys
are not actually set in the live environment, Plot's entire event-category coverage for a
mid-size UK town rests on exactly two sources (Ticketmaster + Skiddle) plus one keyless,
currently-recovering one (OSM). That is a thin base for the brief's own worked-example breadth
(house/techno/UK garage/jazz/country/darts/motorsport/immersive/family activities/seasonal
events all need to be found *somewhere*). **This is an external blocker only the user can
resolve** — I cannot create these accounts or obtain these keys myself, and I do not have
visibility into which are actually set on the live Render deployment.

**Direct question for the user, not deferred**: are `PREDICTHQ_ACCESS_TOKEN`,
`GOOGLE_PLACES_API_KEY`, and `FOURSQUARE_API_KEY` currently set in production? If not, getting
PredictHQ configured is very likely the single highest-leverage inventory action available —
higher-leverage than any code change left in this list, given the live evidence already gathered
this session.

### Not yet touched this cycle (real gaps in the audit itself, stated honestly)

- Phase 1 full pipeline trace: done for the recommendation path specifically (deep, evidence-based,
  via this session's own live incident); NOT yet done for onboarding → profile → taste capture →
  storage, which is a different code path.
- Phase 6 (recommendation rhythm/cadence) — current constants (3/week, 36h spacing) read but not
  evaluated against whether they're actually right; no changes made.
- Phase 7 (learning visible in results) — `recommendationLearning.ts` exists (prior session's own
  "Phase 4: recommendation learning + weekly discovery engine") but not yet re-verified with
  fresh before/after evidence per Rule 1.
- Phase 8 (mobile chat composer) — marked "completed" by name in 2 prior tasks (#66, #86), but per
  Rule 1 that is not evidence. Not yet re-tested live on a real viewport this cycle.
- Phases 9–15 (full consumer audit, analytics, pilot ops, adversarial QA, investor review) — not
  started this cycle.

### Cycle 1b — real baseline test, 5 Crew personas, identical shared inventory

User correctly redirected: infrastructure fixes alone don't prove the commercial thesis. Built
`apps/api/scripts/baselineAudit.ts` (kept as a reusable pilot-ops tool, not a throwaway) — runs
the REAL `buildApp()`/scoring/taxonomy code in-process via `app.inject()`, no mocking, against a
single shared 17-candidate pool seeded within ~3 miles of one shared centre. 6/17 candidates are
the exact real names this session's own live Stafford investigation returned earlier in this
conversation (Josh Pugh comedy night, John Hedges v Pat Brown boxing, Apex Combat Championships
MMA, Walsall v Rochdale, Ye Olde Rose & Crown, The Empourium); the other 11 are realistic
UK-style events for genres that real dataset didn't happen to cover (rock, house, UK garage,
techno, Japanese food, etc.), clearly labelled as such in the script itself — never presented as
live-fetched.

**Hard, honest constraint, stated once**: this sandbox has zero live provider credentials
(checked `apps/api/.env`) and outbound network to every real provider host is proxy-blocked —
confirmed repeatedly this whole session. This test therefore cannot and does not claim to prove
live inventory breadth. It proves what it can prove: whether the real scoring/taxonomy pipeline
discriminates correctly given comparable inventory. See "still unverified" below for what this
does NOT close.

**Results** (full raw output in git history / re-runnable via `npx tsx scripts/baselineAudit.ts`):

| Crew | Stated interests | Delivered | Category | Score |
|---|---|---|---|---|
| A — Electronic/Nightlife | UK garage, house, electronic, cocktails, late nights | "2step Sundays: UK Garage Special" | CLUBBING | 60 |
| B — Sport/Comedy | football, championship football, boxing, stand-up, pubs | "John Hedges v Pat Brown" (real) | SPORT | 60 |
| C — Food/Culture | Japanese, food festivals, food markets, indie cinema, theatre, walking | "Flicker Club: Independent Cinema Night" | CINEMA | 60 |
| D — Rock (explicitly not electronic) | rock, alternative, live gigs | "Static Lines: Alternative Rock Live" | LIVE_MUSIC | 60 |
| E — 3 conflicted members, NO crew-level pick | football/pubs/boxing · restaurants/theatre/markets · live music/comedy | — | — | blocked: `preferences_not_set` |
| E2 — same 3 members, crew-level pick = union of all three | (as above) | "Josh Pugh: Ha Ha, Yeah Sound" (real) | COMEDY | **85** |

**Direct answer to "if five materially different Crews exist in the same town, does Plot behave
like it knows they are different"**: yes, on this evidence. Four Crews with genuinely
non-overlapping tastes got four different, taxonomically-correct real recommendations from one
shared pool. The specific trap the user described — "Crew says ROCK, taxonomy maps to Music,
ranking sees Music match, Plot sends House DJ night" — was deliberately built into this pool (2
rock candidates seeded directly alongside 3 house/techno/garage candidates) and did **not** fire:
Crew D got the rock gig, not a club night, despite the club nights sharing similar price points
and being at comparable distance.

**Crew E finding (real, structural, not a bug)**: a Crew with no explicit crew-level
category/interest pick is hard-blocked (`preferences_not_set`) regardless of how much individual
per-member taste data exists — a mandatory-crew-setup gate from a prior session
(`docs/DECISIONS.md`, task history: "Mandatory crew-level taste setup before first
recommendation"). This means the "three people with different tastes, Plot arbitrates" scenario
never actually exercises individual-member blending to resolve a CATEGORY-level conflict —
someone has to make an explicit crew-level pick first. Once that's done (E2), individual member
taste clearly DOES differentiate which of the many now-eligible candidates wins — the comedy
event scored 85 vs. every other Crew's 60, because it uniquely matched member 3's own explicit
"love" picks on top of the shared crew-level eligibility. This is a legitimate design choice
(a Crew is a stated group decision, not an algorithm silently picking a side), but it's a real
onboarding-dependency risk: if real pilot Crews don't complete the crew-level preference step,
they get nothing, ever, however much individual taste data exists. Onboarding/Home need to make
this step impossible to skip past unknowingly (Phase 9 follow-up).

**Copy finding**: every delivery above was framed as *"There's not much in your area right now,
so how about this"* — the SAME hedging, apologetic copy regardless of whether the match was
strong (e.g. the 85-scoring comedy pick) or weak. This directly undercuts the "Plot found this
because it understands us" feeling the brief calls for, even when the underlying match is
genuinely good. Real Phase 9 finding, not yet fixed.

**What this run does NOT prove (honest gaps)**: (1) live inventory breadth/depth per real intent
— genuinely blocked by lack of network/credentials in this sandbox, only the user or a
network-enabled environment can close this; (2) the full ranked top-10 per Crew — the debug
`explain-recommendation` call in this script runs AFTER the guaranteed-first auto-delivery
already fired, so it reports `too_soon` with no scoring detail; only the single winning candidate
and its real score were captured, not the full candidate table. Re-running with recommendations
initially disabled (to capture the debug view before any auto-send) would close this specific gap
— flagged for a follow-up run, not yet done.

### Priority for cycle 2 (proposed, not yet started)

1. Confirm with the user whether PredictHQ/Google Places/Foursquare are actually configured in
   production — this single answer changes the entire inventory-breadth priority.
2. Trace onboarding → free-text/specific-interest storage → whether it actually affects retrieval
   (closes the open question from this cycle's taxonomy audit).
3. Live-test the mobile chat composer on real viewport sizes with Playwright — do not trust the
   "completed" label.
4. Re-verify recommendation-learning behaviour with fresh before/after evidence (IN/PASS/LOCK
   changing subsequent candidate rankings), using the same rigor as this cycle's density-starvation
   proof.
