# Provider / Commercial Contract Audit (P0-FINAL-5)

Real audit against the NEW proactive product contract (see `docs/DECISIONS.md#crew-recommendation-architecture`
and `services/opportunityIntent.ts`'s own header) — not a generic "what providers exist" document.
Every fact below is sourced from the actual adapter code (`src/providers/live/*.ts`,
`src/providers/registry.ts`), the actual booking flow (`src/services/booking.ts`), and the actual
classification logic Plot Found This runs on (`src/services/opportunityIntent.ts`). Nothing here is
inferred or assumed — where a fact could not be verified (this sandbox's outbound network is
blocked to every one of these APIs; confirmed via direct `curl`), it says so explicitly rather than
guessing.

## The commercial reality, stated once, plainly

**Plot captures zero revenue today, from any provider, full stop.** Every live adapter hardcodes
`commissionEligible: false` (grep-confirmed across all 8 files, zero exceptions). The booking flow
(`services/booking.ts#startBooking`) is pure `Booking Model A`: it resolves the listing's own
`externalUrl`, records a local `Booking` row for analytics, and hands the user that external URL —
the actual transaction (payment, ticket issuance, table confirmation) happens entirely on the
provider's own site, outside anything Plot can see or participate in. `docs/providers/payments.md`
confirms this is deliberate for the pilot: no `STRIPE_SECRET_KEY`, no webhook endpoint, no payments
topology decided yet (merchant-of-record vs pass-through) — Plot "never touches money in V1."

**The commercial path today, for every single provider, is:**

```
RECOMMENDATION → VIEW → IN → LOCK → "Book/Ticket" → external provider's own checkout
                                                       (Plot earns nothing, sees nothing further)
```

If a real affiliate/commission path is ever wired in, it slots into `startBooking`'s existing
`externalUrl` resolution and the `commissionEligible`/`Prisma Provider` fields already in the
schema — the architecture anticipates this, it just isn't built or contracted yet.

## Per-provider classification

Columns: **Surface** = Explore / Plot Found This / Both / Neither, under the P0-FINAL contract
(`opportunityIntent.ts`'s `SourceKind` + `derivePlanWorthiness`). **Ticketed/Bookable** = does this
source's own data model carry a real ticket or booking action. **Transaction path today** = literally
what happens when a user taps through. **Verified live** = has this session actually exercised the
real API (see the "network constraint" note below — the honest answer is no, for all of them).

### Ticketmaster (`live/ticketmaster.ts`)
- **Registered when:** `TICKETMASTER_API_KEY` set.
- **Surface:** BOTH — real dated events, `SourceKind: EVENT_PROVIDER`, unconditionally HIGH
  plan-worthiness (`opportunityIntent.ts#CATEGORY_BASELINE` doesn't even apply the place-like
  downgrade to ticketed rows).
- **Ticketed?** Yes, real — Discovery API v2 event data, real price ranges.
- **Bookable?** N/A — it IS a ticket, not a booking-in-advance product.
- **Time-bound?** Yes — real `startsAt`, not synthetic.
- **Actionable URL?** Yes — Ticketmaster's own event page.
- **Transaction path today:** External redirect to Ticketmaster's own checkout. Zero commission
  (`commissionEligible: false`, hardcoded).
- **Affiliate/revenue path today:** **None.** The adapter's own header is explicit: "real
  commission needs their invite-only Partner API, a separate business conversation" — Discovery
  API access alone (what's implemented) is read-only, no commercial terms attached.
- **Image quality:** Provider-supplied images, run through the same resolution/aspect gate as
  every other source (`MIN_IMAGE_WIDTH` = 1600px, byte-verified, never trusted on declared size).
- **Specificity quality:** High — real genre/classification data feeds `subcategories`.
- **Date/time/location/price quality:** All real, provider-sourced, high confidence.
- **Verified live:** No — outbound network to `app.ticketmaster.com` blocked from this sandbox
  (confirmed). Contract implemented against Ticketmaster's own public docs; unexercised.

### Skiddle (`live/skiddle.ts`)
- **Registered when:** `SKIDDLE_API_KEY` set.
- **Surface:** BOTH — same `EVENT_PROVIDER` treatment as Ticketmaster. Genuinely independent
  inventory (club nights, UK festivals, comedy, smaller venues Ticketmaster doesn't carry).
- **Ticketed?** Yes, real.
- **Actionable URL?** Yes, Skiddle's own `link` field, legally required to stay unmodified
  (Skiddle's API terms mandate this — the adapter honours it by construction, see its header).
- **Transaction path today:** External redirect to Skiddle. Zero commission.
- **Affiliate/revenue path today:** **Not established.** Skiddle's terms require attribution
  ("by name and brand logo") — already implemented at the UI layer — but no commission
  arrangement is coded or confirmed. Would need a real business conversation with Skiddle.
- **Image/specificity/date/location/price quality:** Same standard as Ticketmaster — real,
  provider-sourced, gated through the same pipeline.
- **Verified live:** No — network blocked, same as every adapter here.

### PredictHQ (`live/predicthq.ts`)
- **Registered when:** `PREDICTHQ_ACCESS_TOKEN` set.
- **Surface:** BOTH, with one real caveat — **no public click-through URL exists in PredictHQ's
  own data at all** (it's an events-intelligence aggregator, not a consumer listings site).
  `externalUrl` is honestly a Google Maps search for the venue, never fabricated as a booking
  link — the adapter's own header flags this explicitly as "clearly NOT a booking link."
- **Ticketed?** No — PredictHQ surfaces the EXISTENCE of an event, not a ticket. Still classified
  `EVENT_PROVIDER` for plan-worthiness (a real dated occasion), but `isTicketedEvent()` correctly
  returns false for it (no real price / no real booking action).
- **Actionable URL?** Only a maps link, not a booking action — this is Plot's honest limit for
  this source, not a bug.
- **Transaction path today:** There isn't one. A user taps through to "where it is," not "how to
  go." This is the weakest commercial source of the three ticketed-shaped adapters, by design.
- **Affiliate/revenue path today:** None, and structurally unlikely — PredictHQ doesn't own the
  transaction relationship at all.
- **Verified live:** No. Pricing/terms also explicitly flagged as unconfirmed from this sandbox
  in the adapter's own header — "check predicthq.com/pricing directly before applying."

### Eventbrite (`live/eventbrite.ts`) — implemented, NOT registered
- **Surface:** NEITHER, currently — deliberately not wired into `registry.ts` at all.
- **Why:** Researched and confirmed (per the adapter's own header, dated September 2026):
  Eventbrite cut public event search for new API keys in February 2020, and ended official API
  support entirely by 2025. A real `EVENTBRITE_API_KEY` would not make this return real inventory
  — registering it anyway would be presenting fake coverage as live, which the codebase's own
  content directive explicitly forbids. Left implemented only in case Eventbrite reopens search.
- **Commercial verdict:** Not currently activatable at all, regardless of budget — this is a
  platform-access problem, not a missing-credential one.

### OpenStreetMap (`live/openStreetMap.ts`)
- **Registered:** Always (no credential needed, public Overpass API).
- **Surface:** Explore only, by default — `SourceKind: PLACE_PROVIDER`, and under P0-FINAL-1
  RESTAURANT/BAR/CLUBBING/FITNESS/COMMUNITY rows from any source default to LOW plan-worthiness
  unless a real specialness signal or EVENT_PROVIDER occasion is present. An ordinary OSM
  restaurant/pub is exactly the "Hidden Chef" case this session's own P0-FINAL-1 fix excludes
  from Plot Found This — correctly. Only reaches Plot Found This when its own text carries a
  genuine occasion signal (a market, a food festival day, etc.).
- **Ticketed/Bookable?** No — no booking integration exists for any place-provider adapter.
  `deriveBookingType()` always resolves `WALK_IN` for this source.
- **Time-bound?** No — `startsAt` is a synthetic "next sensible time to go" (documented
  convention across every place-provider adapter), never a real reservation slot.
- **Actionable URL?** Whatever real website/OSM data supplies, not always present.
- **Transaction path today:** None — walk-in only, by the data's own nature.
- **Affiliate/revenue path today:** None, and none is realistically available for crowd-mapped
  place data — there's no transaction to attach a commission to.
- **Image quality:** No native photos — falls into the Wikipedia → Commons → Pexels enrichment
  chain, same as every image-less source, gated by the same resolution/aspect/broken-URL check.
- **Verified live:** No — Overpass API blocked from this sandbox.

### FHRS — UK Food Standards Agency (`live/fhrs.ts`)
- **Registered:** Always (government open data, no credential).
- **Surface:** Explore only — same PLACE_PROVIDER/RESTAURANT treatment as OpenStreetMap, same
  P0-FINAL-1 downgrade unless a real occasion signal is present.
- **Ticketed/Bookable/Transaction path:** None — explicitly a hygiene register, not a places
  product. No opening hours, cuisine, price, or photos either (adapter's own header is explicit
  about this limitation).
- **Specificity quality:** Low by design (business name/type/rating only, no cuisine/genre data).
- **Affiliate/revenue path:** None conceivable — this is regulatory open data, not a commercial
  listings feed.
- **Verified live:** No — `api.ratings.food.gov.uk` blocked from this sandbox.

### Google Places (`live/googlePlaces.ts`)
- **Registered when:** `GOOGLE_PLACES_API_KEY` set (real pay-as-you-go cost past a free credit —
  a budget decision, not an engineering one, per the adapter's own header).
- **Surface:** Explore only, same PLACE_PROVIDER reasoning as OSM/FHRS.
- **Ticketed/Bookable/Transaction path:** None — no booking integration; `WALK_IN` always.
- **Image quality:** The best of any place source — real, venue-uploaded photos via the Photos
  endpoint, requested at 1600px to already clear `MIN_IMAGE_WIDTH` at the source.
- **Specificity/price quality:** High — real ratings, real price tier, real opening hours.
- **Affiliate/revenue path today:** None coded. Google's own Places API terms do not offer a
  commission/affiliate program for this use case — monetization here would have to come from
  cost management (staying under free-tier volume), not revenue share.
- **Verified live:** No — `places.googleapis.com` blocked from this sandbox.

### Foursquare (`live/foursquare.ts`)
- **Registered when:** `FOURSQUARE_API_KEY` set (genuine free tier exists).
- **Surface:** Explore only, same PLACE_PROVIDER reasoning.
- **Ticketed/Bookable/Transaction path:** None.
- **Image quality:** No photos at all without a second per-venue request the adapter
  deliberately doesn't make (cost/N+1 discipline) — always falls into the enrichment chain.
- **Price quality:** Foursquare's own coarse 1-4 tier only, kept in `tags`, never converted into
  a fabricated minor-unit price — an honest gap, not a bug.
- **Affiliate/revenue path today:** None.
- **Verified live:** No — `api.foursquare.com` blocked from this sandbox.

### Mock providers (`mock/ticketingProvider.ts`, `mock/restaurantProvider.ts`, `mock/activityProvider.ts`)
- **Registered:** Only as a fallback when NO live source of that shape is configured (ticketed) or
  never at all in production once OpenStreetMap/FHRS exist (places) — `registry.ts`'s own header
  confirms `mockRestaurantProvider`/`mockActivityProvider` are dev/test/QA-only now, not part of
  the live production registry.
- **Surface:** Neither, in production. When the ticketed mock IS the only source available (no
  ticketing key configured), that fact is surfaced honestly to the client (`GET /admin/providers`,
  Explore's own "Sample events — no live ticketing provider connected yet" banner — visible in
  this session's own live screenshots, e.g. the Explore page audit under P0-FINAL-4) rather than
  presented as real inventory.
- **Commercial verdict:** Not a supply source to activate — sample data only, by design.

## Network-verification constraint (stated once, applies to every "Verified live: No" above)

This sandbox's outbound HTTPS policy blocks every one of these destinations — confirmed directly:
`curl` to `en.wikipedia.org`, `upload.wikimedia.org`, and every provider's own API host all return
`CONNECT tunnel failed, response 403` (organization egress policy), and every adapter's own header
comment independently documents the same restriction for its own host. **No provider's real API
behavior, real inventory depth, real image quality, or real pricing/terms can be verified from
this environment.** Every fact above about a provider's OWN data model (does it carry a ticket, a
price, a photo, a click-through URL) is read from the adapter's source code and its own
documented API contract — accurate to what the code implements, but not exercised against a live
response in this session. This must be verified against Render deployment logs (the documented
discipline every adapter header already asks for) before being treated as field-proven.

## Which real providers are commercially worth activating first

Ranked by (a) real ticketed/bookable inventory the P0-FINAL Plot Found This bar actually wants,
(b) genuine platform reach for a UK pilot, (c) real activation cost:

1. **Ticketmaster** — the deepest UK ticketed catalogue, self-serve free key, zero blockers to
   turning on today. Zero commission without the separate invite-only Partner API conversation —
   activate for genuine supply depth now, treat commission as a later business development task.
2. **Skiddle** — genuinely complementary inventory (smaller venues, club nights, UK festivals
   Ticketmaster's catalogue skews away from), also self-serve, also zero commission today.
3. **PredictHQ** — real breadth (food & drink events, expos, community listings Ticketmaster/
   Skiddle's catalogues skew away from) but weaker per-listing actionability (maps link only, no
   real ticket/booking link) — worth activating for coverage, not for commercial path; verify
   current pricing before committing spend.
4. **OpenStreetMap + FHRS** — free, always-on, correctly Explore-only under the new contract; not
   a commercial lever at all, but real supply depth for the surface that should stay broad.
5. **Google Places / Foursquare** — real cost (Google) or real free tier (Foursquare) for
   Explore-only supply with no commercial path; worth it only if Explore's own place-density is
   still thin after OSM+FHRS, not for revenue.
6. **Eventbrite** — not activatable; leave unregistered.

**No provider currently offers Plot a real commission/affiliate path.** The honest next step for
actual revenue (not covered by this audit, which is about current-state provider classification,
not a build plan) is a real business-development conversation with Ticketmaster's Partner API
team and/or Skiddle, or building out `docs/providers/payments.md`'s Stripe Connect path for a
Plot-as-merchant-of-record model — both are deliberately out of scope for the pilot per the
existing anti-roadmap (`docs/ANTI_ROADMAP.md`), and neither is claimed as built here.
