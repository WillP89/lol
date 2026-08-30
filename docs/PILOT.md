# Pilot plan

## The question that governs everything else

Not "do people like the app?" — **will existing friend groups repeatedly use Plot to decide
what to do?** Every metric below exists to answer that, not to look good on a dashboard.

## Cohort

50–100 people forming 10–20 real Crews, selected for existing planning frequency and history
— not broad demographics. The sharpest wedge is groups that **already plan together
repeatedly** (five-a-side teams, uni society alumni, a standing trip group), because Group DNA
and repeat "Find us something" usage are only valuable once a Crew has planning history — a
brand-new Crew has none yet (`docs/DECISIONS.md#cold-start-defaults`). Recruit through each
Crew's "Decider" — the person who already picks the restaurant — rather than broad ads.

City: London, per the earlier market research (culturally active 22–34s, high WhatsApp usage,
high spontaneous-planning behaviour). The codebase treats city as data, not a code branch —
see `Crew.defaultCity`, `Venue.city` — so a second city is a config change, not a rewrite,
once the first stops needing mock data to feel alive.

## North star metric

**Confirmed Plans per Active Crew (per month).** A rate, not a raw count — self-normalises
for Crew size and count, and rewards follow-through (booked) over mere proposals (shared).

Leading indicators, tracked because they predict the north star before there's enough volume
to trust it directly:
- **Time to group consensus** (first Plan Card sent → `READY` status) — the sharpest proxy for
  "did this actually remove coordination friction."
- **% of externally-sent Plan Cards that convert to install** — the growth-loop health check.
- **Plan → booking conversion rate** — whether Match's recommendations are actually good, not
  just well-received.

## Success criteria (hypotheses, not certainties — revisit after the first 4 weeks of real data)

- ≥60% of activated Crews create at least one Plan.
- ≥40% of created Plans receive votes from more than half the Crew.
- ≥25% of "Find us something" sessions result in a Plan being sent.
- ≥20% of activated Crews confirm a real-world booking within 30 days.
- ≥30% of Crews that book once create a second Plan (`CrewSecondPlan` event, already
  instrumented — see `services/plan.ts#markCompleted`).
- Plan Card → response rate exceeds 50% (a Crew member responds within 48h of a Plan Card
  landing in their thread).

## Instrumentation

Every event above is already wired through `packages/shared/src/analytics.ts` and persisted
via `services/analytics.ts#track` into `IntentSignal`. `GET /admin/dashboard` (see
`routes/admin.ts`) surfaces weekly active Crews, plans-by-status, bookings-confirmed, and
7-day event counts — the seed of the "operating dashboard" the business needs once there's
real usage to show.

## Feedback loop

`POST /feedback` (see `routes/feedback.ts`) accepts structured reports — wrong info, price
incorrect, not my vibe, too far, too expensive, great recommendation — from authenticated or
anonymous users alike, surfaced at `GET /admin/feedback`. Pair this with real structured pilot
interviews; the quantitative funnel tells you *where* it breaks, interviews tell you *why*.
