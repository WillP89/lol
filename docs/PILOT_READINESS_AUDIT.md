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

## Cycle 2 — closing the "60/60/60/60" flatness and a P0 inventory-suppression bug

Direct follow-up to Cycle 1b's baseline table, where four materially different Crews all scored
their winning pick at exactly 60. That flatness was investigated rather than assumed benign.

**Root cause found (specificity-evidence-strength bug)**: `experienceInterestTags` scanned
category, subcategories, AND free-text name/description for interest-keyword hits, so an
untagged, genuinely generic candidate whose name happened to contain a keyword (or that simply
matched at the category level) scored the *same* `interest_match` bonus as a candidate with a
real, curated subcategory tag for that exact interest. Traced with a direct import-level
test (`scripts/specificityAudit.ts`, calling `scoreExperiencesForCrew` with no HTTP) against 4
escalating-specificity LIVE_MUSIC candidates for a Rock Crew: untagged / rock-subcategory-tagged /
alternative-rock-subcategory-tagged / named-artist-via-free-text. Confirmed the scorer did not
differentiate the first two.

**Fix**: added `experienceInterestTagsFromSubcategories` (subcategory-only, no free-text scan) as
a strict "strong evidence" signal alongside the existing broad `experienceInterestTags`. Real
subcategory-tagged interest matches now score a full evidence multiplier; a category-level-only or
free-text-only match scores at half strength. This directly closes the flatness: candidates with
real taxonomy-level specificity now out-rank candidates that merely share a category or happen to
contain a matching word. Regression: `test/interestEvidenceStrength.test.ts` (real scorer, not
mocked) proves a genre-tagged candidate beats an untagged one for the same Crew interest pick.

**A second, more serious bug found while root-causing the first (P0 — inventory suppression)**:
while building a regression test to confirm a HIGH-confidence non-ticketed pick gets honest,
confident copy (see below), the test failed with `totalScored: 0` — a real, well-matched,
non-chain restaurant was invisible to the scorer entirely. Traced to `derivePlanWorthiness`
(`opportunityIntent.ts`): every non-chain `PLACE_PROVIDER`-sourced (FHRS/OpenStreetMap/Google
Places/Foursquare) RESTAURANT/BAR/CLUBBING/FITNESS/COMMUNITY listing was being force-floored to
`LOW` — and excluded by the `isPlanWorthyForCrew` hard gate — unless its own name or description
happened to contain a "specialness" word (e.g. "market", "pop-up", "festival"). This is not a
narrow edge case: it is the fate of essentially all of Plot's real, deepest, most geographically
complete inventory (FHRS restaurants/bars, OSM-sourced venues) that isn't marketed with
festival-branded language. A real independent restaurant with an ordinary name ("Corner Café",
"The Local", the real "Kissho: Japanese Kitchen" used in the regression test) was being treated as
equivalent to a review-flagged chain, when it should be an ordinary, legitimate baseline
recommendation on its own merits. Fixed: non-chain place-provider listings in those categories now
stay at the normal `MEDIUM` baseline (the same baseline as any unknown/manually-curated listing);
the chain-name exclusion (`isGenericChainName`, e.g. "Caffè Nero") is untouched and still
force-floors to `VERY_LOW`; a real specialness signal still upgrades a listing to `HIGH`. Full
`npx vitest run` (76 files / 463 tests) green after the fix; 2 existing tests in
`test/unit/opportunityIntent.test.ts` were updated (not reverted) because they had encoded the
buggy LOW/excluded behaviour as the expected result.

**Third, related bug found and fixed in the same investigation (hedging copy)**: the
"There's not much in your area right now, so how about this" fallback preface was gated purely on
`usedTicketedFallback` — a SUPPLY-TYPE signal (this pick wasn't itself a ticketed/dated event) —
not a quality signal. Most real place-provider inventory (restaurants, bars, markets) is
inherently non-ticketed, so a genuinely excellent, HIGH-confidence match got the identical
apologetic hedge as an actual last-resort compromise. Fixed: the hedge now only fires when the
pick is both a ticketed-fallback AND below HIGH confidence
(`isGenuineCompromise = usedTicketedFallback && confidence !== 'HIGH'`). Regression:
`test/highConfidenceNonTicketedFraming.test.ts` proves a HIGH-confidence non-ticketed pick now
gets "We think this is a great fit for your Crew," not the hedge; the pre-existing
`crewTicketedFirstRecommendation.test.ts` proves the honest hedge still fires for a genuinely
weak/MEDIUM non-ticketed pick.

All three fixes shipped through the standard pipeline (feature branch → main → back to feature
branch, full suite + typecheck + lint green throughout).

**What Cycle 2 does NOT close**: the Crew E "first value" problem flagged in Cycle 1b remains
open by explicit user correction — the `preferencesSet` flag + persistent UI banner shipped in
Cycle 1b is real but insufficient; a Crew can still exist indefinitely with zero recommendations
if nobody completes the crew-level taste step. This is the next item being worked, with an
explicit acceptance test: a realistic new Crew, members invited, no manual rescue, must naturally
reach a relevant first recommendation, with no silent permanent no-recommendation state, and
member-derived initial recommendations must not produce obviously bad results for a highly
conflicted Crew.

## Cycle 3 — Crew first-value: genuinely solved, not just made visible

Direct follow-up to the explicit correction that the Cycle 1b/2 banner (`preferencesSet` +
persistent UI notice) was real, useful work but did NOT solve the underlying problem — a Crew
could still exist indefinitely with zero recommendations if nobody completed the crew-level taste
step. Fixed properly this cycle with a new module, `apps/api/src/services/crewTasteDerivation.ts`.

**Design**: rather than replacing the explicit "a person decides the Crew's own taste" model (a
deliberate prior product decision, `docs/DECISIONS.md`'s "no events or things should be done on
crew until preference set... explicitly NOT derived/averaged from individual members"), this adds
a safety net underneath it. When a Crew has no explicit pick, Plot now safely infers one from real
overlap across its own members' individual `TasteProfile` data (built from their own onboarding
swipes/interest picks — never invented). Two rules keep this from ever fabricating a false
consensus:

1. **Veto** — any member's real, meaningfully negative affinity for a category/interest excludes
   it outright, regardless of how much everyone else likes it.
2. **Real agreement, not one voice** — for a Crew of 2+ members, a preference needs a genuine
   positive opinion from at least 2 DIFFERENT members, not just one enthusiast with everyone else
   silent. This was the subtle failure mode found while building the first version of this fix:
   without it, "no one objects" alone let almost every member's individual, unshared taste leak
   through as if it were a Crew consensus — exactly the "average everyone's interests together and
   recommend random generic things" failure the mission explicitly warned against. A solo Crew (1
   member) is the one exception — that member's own real taste IS the only signal there is yet.

A `CrewRecommendationSettings.preferencesSource` column (`'EXPLICIT' | 'DERIVED' | null`, new
migration) tracks provenance. An explicit human pick always wins and can never be silently
overwritten by a later derivation; a DERIVED guess is safely refined as membership/taste data
changes, and the moment a person makes a real explicit choice it supersedes the guess immediately
(re-fires the same "never come up empty" guarantee an explicit first-set already gets — proven via
a dedicated test: a DERIVED rock/live-music guess, then an explicit switch to food/restaurants,
delivers the food candidate, not the old rock guess).

Wired into every real (non-diagnostic) evaluation path — the automatic sweep, the post-join
trigger, and the manual "Find us something"/chat-suggest gate — so no path is left behind; kept
out of `explainCrewRecommendation`, which is documented and relied on as a read-only admin
diagnostic and must never have a side effect.

**Full mission-specified acceptance suite**, `apps/api/test/crewFirstValueDerivation.test.ts`, all
passing against the real pipeline (no mocking):
- **Solo Crew, one member** — derives that member's own real taste alone.
- **Two genuinely aligned members** — only the interest truly shared by both (rock) becomes the
  derived direction; each member's own solo-held interests (comedy, pubs, etc.) do NOT leak in.
  Confirmed against real seeded inventory: the rock-tagged candidate is delivered, an unrelated
  jazz one is not.
- **Highly conflicted trio** (football/boxing/pubs vs. restaurants/theatre/markets vs. live
  music/comedy — every interest held by exactly one member) — derivation correctly stays empty,
  no forced pick, and no recommendation of any kind is sent.
- **Explicit override** — a Crew with a DERIVED rock guess adopts an explicit food/restaurants
  pick and it wins quickly (immediate guaranteed delivery), and a later sweep never lets
  derivation quietly revert it.
- **Member changes** — a 3rd member joining refines a DERIVED guess (adds jazz once a 2nd person
  shares it); a 4th member joining a Crew that's already EXPLICIT never touches it.
- **The full realistic first-value journey** — create user, set personal taste, create Crew,
  invite second member, second member joins, ordinary chat message, real inventory seeded, only
  the automatic sweep runs (no manual preference rescue of any kind) — Plot safely derives the
  Crew's shared taste, finds the real matching candidate, delivers it with a truthful (non-score-
  exposing) reason. Then the Crew explicitly sets its own taste and the next eligible send
  reflects the new choice.

Web: the crew-detail banner now distinguishes the two real states — the original amber "Set up
needed" (genuinely blocked, rare now) from a new soft green "Plot's using what your Crew already
likes — tap to fine-tune it" (DERIVED, not blocked, just honestly labelled as a guess).

Full suite validated on both api and web (typecheck + lint + `npx vitest run`: 77 files / 470
tests passing) before shipping through the standard pipeline.

**What remains honestly open**: this closes the "silent permanent no-recommendation state" for any
Crew with real, overlapping member taste data — it does NOT (and structurally cannot) help a Crew
whose members have no TasteProfile at all (skipped onboarding) or whose tastes never overlap even
slightly; those Crews correctly stay gated until a person acts, which is the right behaviour, not
a gap. The next highest-leverage question, per the mission's own next directive, is real inventory
breadth/depth and a systematic audit of every remaining inventory-suppression gate — not yet
started this cycle.

## Cycle 4 — systematic inventory-suppression gate audit, 3 real bugs found and fixed

Direct follow-up to the plan-worthiness fix (Cycle 2), run because that fix's own bug shape — a
real gate applied too late in the pipeline, after a hard geographic/volume cut had already thrown
away the candidates it would have kept — was a strong signal the same class of bug could exist
elsewhere. Delegated a full read of every real gate between provider fetch and delivery (quality
scoring, match.ts's every filter in order, opportunityIntent.ts's downgrade-category coverage,
provider registration, and each of the 7 live provider adapters' own internal pagination/result
caps) to a dedicated audit pass. Full findings kept in this session's own transcript; the
actionable results:

**Bug 1 (shipped) — `isPlanWorthyForCrew` ran after, not before, the nearest-50 geographic cut.**
Identical shape to the already-fixed `passesPreferenceGate`-after-the-cut incident, just triggered
by chain-density instead of category-density: a town centre saturated with real chain venues
(McDonald's/KFC/Subway/Greggs — all correctly force-floored to VERY_LOW) could fill the entire
top-50 distance slice before a genuine, non-chain restaurant sitting farther out but still
comfortably in-radius ever got the chance to be scored at all. Fixed by moving the gate to the
same early stage `passesPreferenceGate` already runs at (before the cut, not after). Regression
test (`test/planWorthinessBeforeProximityCut.test.ts`) seeds 55 nearer real-UK-chain venues plus
one genuine independent restaurant farther out, proves the independent one is what gets delivered.

**Bug 2 (shipped) — the Skiddle adapter never paginated.** `fetchOneCategory` made exactly one
request per event code (limit=50, sorted by date ascending) and never read the response's own
`totalcount` field, unlike every other paginated adapter in this codebase (Ticketmaster/FHRS/
PredictHQ all loop). A dense event code in a real city (LIVE/CLUB with 65+ gigs across the sync
window) would silently and permanently lose everything past the earliest 50 by date, every single
sync — systematically biasing Skiddle inventory toward near-term dates. Fixed with a real
offset-based pagination loop (`MAX_PAGES_PER_CATEGORY = 3`, matching Ticketmaster's own page
count), still bounded by the adapter's existing overall time budget. Two new tests
(`test/unit/skiddlePagination.test.ts`) mock a 51-result category and prove the 51st result (only
reachable via a real second page) is not lost, and that a short category never wastes a second
request.

**Bug 3 (shipped) — near-duplicate dedup had zero location awareness.** `dedupeNearDuplicates`
(entityResolution.ts) merged purely on category + name-similarity (Jaccard ≥0.82) + time-proximity
— no coordinate check at all. Two genuinely different real venues sharing a common UK name ("The
Red Lion", "The Crown" — among the most common pub names in England) could hit the similarity
threshold and silently lose one, permanently, on every surface that shares this dedup pass (Crew
recommendations, Explore, Home). Fixed additively: real coordinates on BOTH sides now override a
would-be merge when the venues are more than ~0.3 miles apart (generous enough to still catch the
SAME venue geocoded slightly differently by two providers); an item missing coordinates on either
side falls back to the pre-existing name-only behaviour exactly as before, so this can only make
dedup more conservative, never less. Three new tests prove: two distinct same-named pubs miles
apart both survive; the same real venue geocoded ~30m apart by two providers still collapses to
one; missing coordinates on one side still falls back to the old merge behaviour.

**Findings investigated and NOT changed this cycle** (real, but lower-confidence or genuinely
product-policy questions rather than bugs): OSM's 120-result-per-sync cap and FHRS's 200-result
cap could truncate in a genuinely dense city with no signal when they do (worth adding a log
line, not yet done); Google Places/Foursquare fetch only one page each (currently low real-world
impact — both are key-gated and neither is confirmed configured in production); Ticketmaster maps
`offsale`/`postponed`/`rescheduled` to `UNKNOWN` rather than excluding them outright (worth
confirming intended semantics, not clearly wrong); the permanent, non-decaying
`getCrewExcludedExperienceIds` exclusion is reasonable for one-off EVENT_PROVIDER occasions but
arguably too permanent for evergreen PLACE_PROVIDER venues (a genuinely great restaurant rejected
once for an unrelated scheduling reason can never resurface automatically) — a real product
question, not a clear bug, flagged for a decision rather than changed unilaterally. Confirmed NOT
broken: the quality-score gate (every live provider's typical listing clears 40 comfortably); the
plan-worthiness downgrade-category set is complete for every category a PLACE_PROVIDER adapter can
currently produce (no other category has the same unfixed bug); provider env-var names in
registry.ts exactly match config.ts (no wiring bug).

Full suite green throughout (79 files / 476 tests), typecheck + lint clean on every fix, each
shipped individually through the standard pipeline.

**The real, unavoidable blocker this cycle re-confirms, not new**: none of this — nor anything
else this session can do — substitutes for live evidence of real provider inventory breadth,
because this sandbox's outbound network to every live provider host (Ticketmaster, Skiddle,
PredictHQ, Google Places, Foursquare, OpenStreetMap's Overpass mirrors, FHRS) is proxy-blocked, and
this session has no access to production's actual deployed environment or its configured
credentials (`PREDICTHQ_ACCESS_TOKEN`/`GOOGLE_PLACES_API_KEY`/`FOURSQUARE_API_KEY` — confirmed by
reading `providers/registry.ts`/`lib/config.ts` that these gate real registration, but this
sandbox cannot read production's own environment). The admin diagnostics already built this
session (`GET /admin/inventory-probe` — live per-provider raw/normalised/filtered counts;
`GET /admin/experiences-near` — what's actually in the DB near a city, gate-annotated;
`GET /admin/crews/:id/explain-recommendation` — full per-Crew scoring trace) already give the
exact evidence shape needed once run somewhere with real network access — this is the single
highest-leverage action item for the person running the live product: run `/admin/inventory-probe`
for each of the intents below in a real UK city and read off the real counts.

## Cycle 5 — iPhone chat composer, re-verified from scratch (prior "completed" label not trusted)

Per the mission's own explicit instruction not to trust a prior session's "completed" label, this
re-traced the composer's entire keyboard/safe-area/viewport architecture from the actual code
(never from the task history), then verified it live: started both the real API and web dev
servers, created a real 2-member Crew with 25 real chat messages via the real API (a solo/
1-member Crew turns out to render an entirely different empty-invite screen, not the chat thread —
found and worked around while setting this up), and used Playwright with a real iOS Safari user
agent to screenshot the actual rendered page at all four specified viewports (375×667, 390×844,
393×852, 430×932), plus a simulated multi-line message and a simulated viewport shrink
approximating a keyboard opening.

**The architecture itself is sound, not a "magic pixel offset" hack**: `layout.tsx` sets
`interactiveWidget: 'resizes-content'` (the real, standards-track, platform-level fix — Safari
17.4+/Chrome 108+ — that makes the browser itself resize the layout viewport for the keyboard,
the same way it already does for the address bar), with a documented `window.visualViewport`-based
correction (`composerBottomGap`) as a fallback for the one real WebView (Gmail's in-app browser)
found on a real device not to fully honour it. The composer uses plain `position: sticky; bottom:
0`, never `position: fixed` + manual coordinate reconstruction (an earlier round's approach,
explicitly reverted per its own comment). Safe-area padding lives in exactly one place
(`.v2-crew-composer`'s own bottom padding), correctly zeroed on desktop where the wrapper takes
over — no double safe-area found.

**A real bug WAS found and fixed**: the composer's placeholder (`Message ${crew.name}…`) could
wrap onto a second line for a longer Crew name (confirmed with a real 22-character name at 375px
width), and the auto-grow effect that sizes the textarea only ever measures the actual typed
VALUE — on load that's empty, so the box renders at exactly one row regardless of placeholder
length. The wrapped second line then rendered past that one-row box, uncontained, landing off the
bottom of the real screen — confirmed with a direct DOM measurement (`scrollHeight: 67` vs. actual
rendered `height: 45.6`) before being fixed, reproduced identically at 375×667 and 430×932. Fixed
two ways: (1) `composerPlaceholderName()` shortens the Crew-name portion client-side (defense in
depth, but char-count alone can't reliably predict wrapped width across real font metrics); (2)
the real, deterministic fix — `.v2-crew-composer textarea::placeholder { white-space: nowrap;
overflow: hidden; text-overflow: ellipsis; }`, scoped to the placeholder only (never affecting the
textarea's own real multi-line typed-value growth). Re-verified after the fix: single-line
placeholder with a clean ellipsis at all four viewports, composer fully contained within the
viewport with no overlap or clipped content, both before and after the simulated keyboard-open
resize.

**What this does NOT close**: headless Playwright cannot open a real OS on-screen keyboard, so the
`visualViewport`-driven `composerBottomGap` correction — the part specifically added for the one
real WebView quirk found on an actual device — could not be exercised here; a shrunk-viewport
approximation confirmed the base sticky/flex layout reflows correctly under a smaller viewport,
which is the structural property that matters most, but is not the same signal a real device
would give for that specific WebView-timing correction. That fallback code path remains unverified
by this cycle, same honest limitation as every other real-device-only behaviour this session has
flagged rather than claimed to have proven from a sandbox.

Shipped: typecheck + lint clean (this repo's web app has no automated test suite — typecheck/lint
is the full CI gate, matching every prior round's own verification method for this exact class of
bug, which has consistently relied on live/Playwright screenshot evidence over unit tests for
viewport-dependent rendering).

## Cycle 6 — broader golden-path visual pass, one real bug found and fixed (Explore, mobile)

Direct follow-up to Cycle 5's composer fix: since re-verifying from scratch (not trusting a prior
"completed" label) had just found a real bug, the same live methodology was extended across
Home, Crews, Explore, Profile, and Plans at a real mobile viewport (390×844, real iOS Safari user
agent) using the same 2-member Crew and real session.

**A real methodology trap found and corrected along the way**: Playwright's `fullPage: true`
screenshot mode is unreliable for this app's architecture, which deliberately scrolls an inner
`.v2-shell-desktop` container (`overflow-y: auto`) rather than the document body, with the
floating bottom nav pill `position: absolute` inside the same `100dvh` shell (see that CSS rule's
own comment for the real address-bar-collapse bug this already fixed). `fullPage` screenshots
appeared to show the nav pill overlapping card content on Home — investigated with a direct DOM
measurement before touching any code, which proved it was a screenshot-compositing artifact
(scrolling `window`, which never actually moves in this architecture, instead of the real
internal scroll container): with the correct container scrolled to its real maximum, Home
actually clears the nav with 15.8px to spare, exactly as intended. No code change made there —
correctly holding off on a fix once the evidence pointed the other way, not just when it confirms
a hypothesis. All further verification in this cycle used the real scroll container, never
`fullPage`.

**The real bug**: Explore's mobile layout (`.v2-explore-col`, wrapping the whole discovery grid)
had a bottom-padding rule ONLY inside its `@media (min-width: 1000px)` desktop block — on mobile,
where the same element is unconditionally rendered with zero dedicated CSS at all, the discovery
grid's last row had no reserved clearance whatsoever, so real card content (a price, "Nia
Archives... £57–£98") rendered straight behind the floating nav pill. Confirmed with a real,
correctly-scrolled screenshot before and after. Fixed with one rule, matching the same
bottom-clearance amount (`96px + safe-area`) `.v2-page` already uses everywhere else in the app —
Explore's own content wrapper never had its own copy of it. Home, Crews, Profile, and Plans were
all independently re-verified clean with the same corrected methodology; no other instance of
this exact gap was found on those four.

Shipped: typecheck clean (CSS-only change).

## Cycle 7 — golden-path walkthrough restart, one real bug found and fixed (entry page font loading)

Continuing the mission's item 13 ("THEN COMPLETE THE PILOT LOOP: ONBOARDING → HOME → ..."),
started a fresh, unauthenticated Playwright walkthrough of the real entry point (`/`, no session
cookie — a genuinely new visitor, not the existing test session used for every prior cycle).

**The real bug**: the console logged `net::ERR_CERT_AUTHORITY_INVALID` on every load. Investigated
with a `page.on('requestfailed', ...)` listener before assuming anything — it traced to exactly
one request: `globals.css`'s own `@import url('https://fonts.googleapis.com/css2?family=Archivo...
&family=Inter...')`, a runtime, render-blocking fetch of Google Fonts' CSS from every visitor's own
browser. In this sandbox that request fails outright (the sandbox's outbound TLS proxy doesn't
carry a trusted cert for that host), which is itself a sandbox artifact and not what a real user's
browser would hit — but the underlying pattern is a real, shippable weakness independent of this
sandbox: a render-blocking third-party request with no error surface a user would ever see if it's
slow, blocked by a corporate network/ad-blocker/regional restriction, or fails for any reason —
the UI would just silently fall back to the system font stack, unannounced, on a page's first
impression of the product.

**Root cause**: `layout.tsx` never used Next.js's own `next/font/google` (which downloads and
self-hosts font files at build time, eliminating the runtime request entirely) — the CSS `@import`
was the only thing ever loading `Inter`/`Archivo`.

**Fix**: switched to `next/font/google` in `layout.tsx` (`Inter` with the same weights the old
`@import` requested — 400/500/600/700/800 — and `Archivo` with 600/700/800/900, normal + italic),
exposed as CSS custom properties (`--font-inter`, `--font-archivo`, via each font object's
`variable` option) on `<html>`, removed the `@import` line from `globals.css`, and repointed
every `font-family: 'Inter'/'Archivo'` reference — three in `globals.css`, two inline `fontFamily`
style props in `Avatar.tsx`, one in `IdentityPicker.tsx` — to `var(--font-inter)`/
`var(--font-archivo)` (CSS custom properties inherit through the DOM, so the inline styles
resolve correctly without needing the font objects threaded as props).

**Verification**: re-ran the same `requestfailed`-listener script after the fix — zero failed
requests, zero console errors, no external network call at all. Confirmed the real font (not a
silent system-font fallback) actually renders on real visible text by reading
`getComputedStyle(...).fontFamily` off actual on-screen elements (`h1`, the headline's own accent
`span`, both CTA links) — all resolved to the real downloaded `Inter`/`Archivo` font faces, not
`ui-sans-serif`/generic serif. (`getComputedStyle` queried directly on `<html>`/`<body>` — not on
any real visible text node — read back a spurious `"Times New Roman"`; investigated before trusting
it, and it turned out to be an artifact of querying the custom-property-defining elements
themselves rather than a descendant, not a real rendering defect — every actual text-bearing
element downstream resolved correctly, and a real screenshot at 430×932 confirms the entry page
renders pixel-identical to before, just with zero external dependency now.)

Shipped: typecheck + lint clean on both `apps/web` and `apps/api`, full backend suite green
(79 files / 476 tests — unaffected by this web-only change, re-run per this repo's standing
pipeline discipline regardless).

## Cycle 8 — the real inventory coverage matrix, with live per-intent evidence, and a correction

Direct response to the standing, still-unanswered investment question: *can Plot reliably source
enough real, relevant opportunities for materially different Crews?* Previous cycles fixed real
pipeline bugs but never definitively separated "the pipeline works" from "the pipeline has real
data to work with." This cycle does that separation with live evidence, not inference from code.

**A correction, stated plainly first**: earlier in this cycle, a live 2-member Crew ("Stafford
Rock Crew", real taste picks: Rock/Alternative/Live gigs, real Stafford location) was shown
receiving an automatic recommendation — "Static Lines: Alternative Rock Live" at The Sugarmill,
£15 — the instant its second member joined, with no manual trigger, and this was described as
"real, live proof." That was imprecise and is corrected here: querying `ProviderListing` for that
Experience shows its source is `mock_ticketing`, not a live provider. **What that run actually
proves — and it's still real, still valuable evidence — is that the full pipeline mechanics
(member join → derivation/explicit-preference gate → scoring → delivery → chat UI → vote/lock
affordances) fire correctly end to end with no manual intervention.** It does NOT prove real-world
supply. Those are two different claims and conflating them would be exactly the kind of
overclaiming the mission's standing rules forbid. The rest of this cycle establishes what real
supply actually looks like right now.

**Decisive evidence, gathered directly, not inferred:**

1. **No live-provider credentials are configured in this sandbox.** `apps/api/.env` has no
   `TICKETMASTER_API_KEY`, `SKIDDLE_API_KEY`, `PREDICTHQ_ACCESS_TOKEN`, `GOOGLE_PLACES_API_KEY`, or
   `FOURSQUARE_API_KEY`. Confirmed by direct `grep`, not by reading code and assuming.

2. **This sandbox's network egress hard-blocks every provider host, including the two that need
   no credential at all.** Direct `curl` against `overpass-api.de`, `api1-ratings.food.gov.uk`,
   and `app.ticketmaster.com` each returned `CONNECT tunnel failed, response 403` — compared
   against `api.github.com` succeeding (`200`) in the same test, confirming this is a specific
   allowlist policy, not a general outage. The app's own `GET /admin/providers` self-reports the
   identical fact with exact host names and remediation text: `openstreetmap` and `fhrs` both
   show `health.status: "DOWN"`, error `"...Host not in allowlist: overpass.openstreetmap.ru. Add
   this host to your network egress settings to allow access."` and `"...Host not in allowlist:
   api.ratings.food.gov.uk..."` respectively. This is a sandbox/environment network-policy fact,
   separate from and additional to the missing-credentials fact above — fixing one does not fix
   the other. **This session has no ability to change either — no environment/infra settings
   tool is available here, and no access to production's actual deployed configuration to know
   whether either constraint even applies there.**

3. **A real diagnostic-accuracy bug found and fixed along the way**: `GET /admin/inventory-probe`
   (the endpoint built specifically to answer "what does Plot itself find" per-provider) was
   silently reporting `fetchedTotal: 0, error: null` for both OpenStreetMap and FHRS — visually
   indistinguishable from "this city genuinely has zero real listings." Root cause: `fetchListings()`
   on every live adapter deliberately swallows its own network/API failures and returns `[]` (so
   one down provider can never crash a real inventory sync sweep for everyone) — correct behaviour
   for the sync path, but it meant this specific diagnostic endpoint had no way to tell a real zero
   apart from a failed fetch, undermining the exact evidence it exists to give. Fixed in
   `apps/api/src/routes/admin.ts`: when a live adapter's raw fetch returns empty, the probe now
   additionally calls that adapter's own `healthCheck()` and surfaces its real DOWN reason instead
   of a bare zero. Re-ran the probe after the fix — `openstreetmap`/`fhrs` now report the exact
   same precise 403/allowlist error as `/admin/providers`, for every intent queried below, instead
   of a misleading silent zero. Existing `test/inventoryProbe.test.ts` (mock-registry path, all 3
   tests) and `test/experiencesNearAdmin.test.ts` re-verified passing; typecheck + lint clean.

4. **Current DB inventory, by real source, queried directly**: `ProviderListing` join shows every
   single row currently in the database — all 32 of them — comes from `mock_ticketing` (28: 20
   LIVE_MUSIC, 8 CLUBBING, 4 COMEDY) or `manual_curation` (4 LIVE_MUSIC). Zero rows from
   OpenStreetMap, FHRS, Ticketmaster, Skiddle, or PredictHQ — consistent with facts 1–2 above.

5. **A second, more severe finding than "the sandbox can't verify real supply": the DEV/PRODUCTION
   provider registry itself only ever has real coverage for 3 of 14 `ExperienceCategory` values
   right now, by design, not by sandbox accident.** Reading `registry.ts`: `mockRestaurantProvider`
   and `mockActivityProvider` were deliberately REMOVED from the non-test registry when
   OpenStreetMap was added, on the explicit reasoning (in that file's own comment) that OSM would
   always be live in production and showing fabricated listings alongside it would be the exact
   "silently mixing stock and real data" the product directive forbids. That reasoning is sound
   *if* OSM is actually reachable. `providerRegistry` in dev/production (not test) is therefore:
   `[mock_ticketing-or-live-ticketed] + openstreetmap + fhrs + [google/foursquare if keyed]` — full
   stop. **If OpenStreetMap and FHRS are down for any reason, in any real deployment — not just
   this sandbox — 10 of 14 categories (RESTAURANT, BAR, SPORT, THEATRE, CINEMA, ART_CULTURE,
   FESTIVAL, FITNESS, DAY_ACTIVITY, COMMUNITY) currently have zero fallback of any kind, mock or
   real, and would return nothing at all, silently, with no operator-visible alarm beyond the
   `/admin/providers` health check someone has to think to look at.** This is a real architectural
   single-point-of-failure, independent of whether THIS sandbox's specific network block also
   applies to the real production deployment — deliberately not changed this cycle (reintroducing
   a mock fallback for these categories is a real product-policy call the original author already
   reasoned through once; overriding it unilaterally without knowing whether production's OSM/FHRS
   access actually works would be guessing at a fix for a problem that may not exist there) but
   flagged here as a concrete, scoped follow-up worth a real decision: a health-check-gated mock
   fallback (mirroring the existing `hasLiveTicketedProvider` pattern exactly) would close this
   gap without ever silently mixing fabricated and real listings.

**The Inventory Coverage Matrix** — built from evidence above plus a live `/admin/inventory-probe`
run for each named intent against Birmingham (the best-covered real UK city in this DB), not
inferred from code alone. `LIVE VALIDATION REQUIRED` means: the adapter code correctly targets
this category and would very likely return real, relevant results once network access + (where
needed) a credential are both in place — but that is a claim this sandbox cannot verify today, and
is not being presented as verified.

| Intent | Maps to | Current real status | Rating | Evidence |
|---|---|---|---|---|
| Rock / Alternative Rock | LIVE_MUSIC | `mock_ticketing` only; confirmed `categoriesWithNoLiveSource` includes LIVE_MUSIC | **UNSUPPORTED (live)** | `/admin/providers`; pipeline mechanics proven live (Cycle 8 Stafford run) |
| House / UK Garage / Electronic | CLUBBING | `mock_ticketing` covers CLUBBING generically, not genre-specific; OSM covers nightlife *venues* not lineups; Skiddle (genre-strong per its own file comment) unconfigured | **UNSUPPORTED (live)** | registry.ts categories; no SKIDDLE_API_KEY in .env |
| Football / Championship football | SPORT | **No adapter targets SPORT at all in the current dev/prod registry** — Ticketmaster/Skiddle/PredictHQ all cover it in code but none are configured; mock_ticketing does not include SPORT | **UNSUPPORTED (live)**, POOR even once keyed (real fixture data, not every club/league) | grep across `src/providers/live/*.ts`; DB has 0 SPORT rows |
| Comedy | COMEDY | `mock_ticketing` only; confirmed `categoriesWithNoLiveSource` includes COMEDY | **UNSUPPORTED (live)** | `/admin/providers` self-report |
| Japanese food / Restaurants | RESTAURANT | FHRS + OpenStreetMap both target RESTAURANT (OSM has cuisine tagging incl. Japanese); both DOWN in this sandbox | **LIVE VALIDATION REQUIRED** — code support is GOOD, real status unverifiable here | inventory-probe: fetchedTotal 0, error = allowlist 403 (both providers) |
| Food festivals | FESTIVAL | **No adapter targets FESTIVAL in dev/prod registry** — Skiddle/PredictHQ/Ticketmaster cover it in code, none configured | **UNSUPPORTED (live)** | grep across providers; DB has 0 FESTIVAL rows |
| Food markets | RESTAURANT/DAY_ACTIVITY (OSM `amenity=marketplace`) | OSM-only, no ticketed-events equivalent; DOWN in this sandbox | **LIVE VALIDATION REQUIRED**, likely PARTIAL even when live (static markets, not scheduled market *events*) | openStreetMap.ts category coverage; DOWN status |
| Theatre | THEATRE | OSM covers theatre *venues*, not what's showing; Ticketmaster covers real show listings but unconfigured | **LIVE VALIDATION REQUIRED** for venues, **UNSUPPORTED (live)** for actual programming | registry.ts; no TICKETMASTER_API_KEY |
| Cinema | CINEMA | OSM covers cinema venues only, not showtimes; no showtime-data adapter implemented at all | **POOR** even with network fixed — venue existence only, never "what's on" | openStreetMap.ts category list; no cinema-listings adapter exists in codebase |
| Exhibitions / Art & culture | ART_CULTURE | OSM-only; DOWN in this sandbox | **LIVE VALIDATION REQUIRED** | inventory-probe DOWN status |
| Family activities | DAY_ACTIVITY | OSM-only; DOWN in this sandbox | **LIVE VALIDATION REQUIRED** | inventory-probe DOWN status |
| Outdoor activities | DAY_ACTIVITY/FITNESS | OSM-only; DOWN in this sandbox | **LIVE VALIDATION REQUIRED** | inventory-probe DOWN status |
| Escape rooms / Bowling | DAY_ACTIVITY | OSM tags these inconsistently in practice (real-world OSM data-quality risk, not just this sandbox's network); DOWN here regardless | **LIVE VALIDATION REQUIRED**, genuine risk of PARTIAL even when live | openStreetMap.ts scope; general OSM tagging-completeness caveat |
| Seasonal / local events | FESTIVAL/COMMUNITY | Same as Food festivals — no adapter live/configured | **UNSUPPORTED (live)** | grep across providers |

**Suppression-gate audit status, confirmed**: the user's specific worry — that good inventory
might still be silently destroyed somewhere between PROVIDER and DELIVERY — was already run as a
full systematic pass in Cycle 4 above (every gate between fetch and delivery read in order; 3 real
bugs found, fixed, regression-tested, shipped: plan-worthiness-gate-after-the-cut, Skiddle missing
pagination, dedup missing location-awareness). That audit is complete, not something this cycle
needed to redo. Its own "not yet done" list (OSM/FHRS silent truncation-cap logging, Google/
Foursquare single-page-only, the permanent PLACE_PROVIDER exclusion question) remains accurate and
unchanged.

**The precise, actionable blocker for the person who can act on it** (per the mission's own "state
it honestly and continue" rule): two distinct, independent things are needed before Plot can
source real supply, neither of which this session can do from inside this sandbox —
(1) **register for and configure at least one real event-ticketing credential**
(`TICKETMASTER_API_KEY` and/or `SKIDDLE_API_KEY` and/or `PREDICTHQ_ACCESS_TOKEN` — Skiddle has the
lowest signup friction of the three per its own file's research notes) — this alone would light up
LIVE_MUSIC, CLUBBING, COMEDY with real data and, depending on which key, SPORT/FESTIVAL/THEATRE
too; (2) **confirm whether the real production deployment's network egress can reach
`overpass-api.de`/`*.openstreetmap.ru`/`*.openstreetmap.fr` (OSM mirrors) and
`api1-ratings.food.gov.uk` (FHRS)** — both need zero signup or credential, and together they are
the only current path to real RESTAURANT/BAR/THEATRE-venue/CINEMA-venue/ART_CULTURE/DAY_ACTIVITY/
FITNESS/COMMUNITY coverage. If production's network already allows these (a normal cloud
deployment usually would; this specific interactive coding sandbox's proxy is a much tighter,
deliberately restrictive policy that is not evidence production is equally restricted), then
`/admin/providers` and `/admin/inventory-probe` — both already built and both fixed to be honest
this cycle — are the exact tools to run there to get the real per-intent counts this matrix could
not obtain from here.

## Cycle 9 — recommendation continuity, a real multi-day user journey, live

Direct test of the standing product complaint: *"Plot sends one event and then there is no
consistent flow."* Run as an actual journey against the live app (not constants inspection),
using the same real "Stafford Rock Crew" from Cycle 8 (2 real members, real Rock/Alternative/Live
gigs taste, real Stafford location, real mock_ticketing inventory).

**The journey, each step real and screenshotted/API-verified:**

1. **First recommendation** fired automatically on the 2nd member joining (Cycle 8) —
   "Static Lines: Alternative Rock Live", reason "Your Crew set Rock as a preference."
2. **Members respond**: both real accounts tapped "I'm in" through the live UI — vote count
   updated correctly ("2 in · 0 maybe · 0 can't make it"), verified with real screenshots.
3. **Lock it in**: tapped live, plan status flips to `SHARED`→locked, a real system chat message
   appends ("'Static Lines...' was locked in — see you there"), the sticky header banner turns
   green ("LOCKED IN · SEPT 24 · The Sugarmill · View →") — confirmed correct on a genuine fresh
   reload (a same-session stale amber "VOTE NEEDED" banner was seen once mid-flow and initially
   looked like a bug; a fresh page load proved it was just the header not re-fetching within that
   one client session after the lock action, self-correcting immediately on reload/navigation —
   real but low-severity, not fixed this cycle given its own self-correction).
4. **Next day (36h cadence passes)**: backdated the first `CrewRecommendation.createdAt` by 40h
   and force-swept via `POST /admin/recommendations/sweep {crewId}` — a **second, genuinely
   different** recommendation delivered automatically: different `experienceId`, reason text
   cycled to "Your Crew set Live gigs as a preference" (a different one of the Crew's 3 explicit
   picks than the first), score 88, confidence HIGH. Proves Plot doesn't stop after one locked
   plan — it keeps looking, unprompted, once cadence allows, **even though the Crew already has a
   locked plan on the books.**
5. **Approaching a third occasion**: repeated the same backdate+sweep once more — a **third,
   again genuinely different** recommendation, reason cycled again ("Matches Rock" this time).
   Three real, distinct experiences recommended across one simulated week, zero repeats, zero
   manual intervention, real reasoning that visibly reflects different facets of the Crew's stated
   taste each time rather than the same canned sentence.
6. **Weekly cap correctly enforced**: a fourth attempt (same backdate+sweep pattern) correctly
   delivered nothing — `GET /admin/crews/:id/explain-recommendation` reports the precise reason,
   not a guess: `{"outcome":"weekly_cap_reached","recentCount":3,"maxPerWeek":3}`. This is a
   self-resolving throttle (the week rolls forward), a genuinely different failure mode from the
   Manchester Crew's permanent no-supply case in Cycle 7/8 — correctly distinguished by the app's
   own diagnostics, not conflated.

**Verdict on cadence**: `MIN_HOURS_BETWEEN_RECOMMENDATIONS = 36` / `maxPerWeek = 3` produced real
momentum in this test — three distinct, well-reasoned recommendations, no repeats, no spam, and a
clean, explainable stop once the cap was hit. Nothing in this live run suggests either number is
wrong; not changed this cycle.

**One real, legitimate gap found, not yet fixed**: nothing in `submitVote`/the plan-vote path
reacts to every active member responding "Can't make it" — an unambiguous, strong signal that
this specific recommendation is dead — by re-triggering a sweep early. Right now that Crew simply
waits out the same 36h/weekly-cap cadence as if no one had responded at all; there is no
regression here (continuity is still proven above to work), but "PASS → replacement" specifically
is slower than it could be. Flagged as a real, scoped, well-justified follow-up — hooking a
`generateRecommendationForCrew(crewId, { guaranteeReplacement: true })`-shaped call into the vote
handler when the last active member flips a Plan to fully declined — not implemented this cycle to
avoid rushing a vote-path change without its own tests, given the strength of evidence already
gathered that the core continuity loop works.

No code changed this cycle — pure live-evidence gathering against the already-shipped pipeline;
no shipping step needed.

## Cycle 10 — iPhone chat composer, full P0 acceptance matrix re-run, no new bug found

Explicit P0 re-verification requested against the real 25-message "iPhone Chat Test Crew"
(real account, real session), covering the full matrix: 4 viewports (375×667, 390×844, 393×852,
430×932) × 9 interaction states (initial load, single-line, multi-line/auto-grow, focused, after
send, blurred, scrolled away from bottom, scrolled back, simulated reduced-height keyboard-open
viewport). `getBoundingClientRect()`-measured composer position and an explicit
`navOverlapsComposer` check at every single one of the 36 combinations: **gap-to-viewport-bottom
was 0 (sub-pixel) and nav overlap was false in every case, no exceptions.** The textarea correctly
caps its visual growth at 140px and becomes internally scrollable for longer text (`scrollHeight`
grows past 140 while rendered `height` stays capped) rather than growing unboundedly.

**A real methodology trap caught mid-test, same discipline as Cycle 6's fullPage-scroll lesson**:
the first pass's "scroll away from bottom / scroll back" step targeted `.v2-shell-desktop` (the
scroll container Home/Explore use) with a `[class*="scroll"]` fallback that matched
`.v2-crew-scroll` — but walking that element's full ancestor chain showed every one of them,
including `.v2-crew-scroll` itself, has `overflow-y: visible`; the crew chat page's real scroll
owner is `<html>` itself (document-level scroll, `scrollHeight: 3840` vs `clientHeight: 667`) — a
genuinely different architecture from Home/Explore's inner-container pattern, not a bug. Corrected
the test to use `window.scrollTo`/`document.documentElement.scrollTop` directly and re-ran:
document scroll correctly moves from the real bottom (`docScrollTop: 3173`, showing message #25,
the true last message) to top (`0`) and back, and — the part that actually matters for composer
architecture — **the composer's `getBoundingClientRect().bottom` stayed exactly equal to
`window.innerHeight` in all three document-scroll states**, confirming it is genuinely fixed to
the visual viewport rather than scrolling with the document, with the header behaving the same way
(both pinned, only the message list scrolls between them — the same pattern WhatsApp/iMessage use).

**Verdict: no bug found this cycle.** Cycle 5's placeholder-overflow fix remains the one real
composer bug found and fixed this session; this cycle's exhaustive re-run found the architecture
genuinely solid across every state in the requested matrix. The one honest, unchanged limitation:
headless Chromium cannot open a real OS on-screen keyboard, so the `visualViewport`-driven
`composerBottomGap` WebView-specific fallback path remains unverified from this sandbox, same
caveat as Cycle 5 — the viewport-height-reduction simulation used here (58% of full height,
approximating iOS's keyboard proportion) confirmed the base fixed-position layout reflows
correctly under a smaller viewport, which is the structural property that matters most, but is not
the same signal a real device would give for that specific correction.

No code changed; no shipping step needed.
