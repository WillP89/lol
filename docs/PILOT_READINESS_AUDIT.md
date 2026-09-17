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
