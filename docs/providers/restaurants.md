# Going live: restaurant availability providers

Ships with `mockRestaurantProvider` (`apps/api/src/providers/mock/restaurantProvider.ts`).

## OpenTable
- **Access**: the Availability API is **partner-gated**, not self-serve — requires a
  commercial conversation with OpenTable/Booking Holdings. No API key gets you in on its own.
- **Env**: `OPENTABLE_API_KEY` (placeholder)

## Resy
- Similarly partner-gated; API access historically limited to specific integration partners
  (mostly POS/reservation-adjacent companies), not open to a new consumer app by default.

## SevenRooms
- Venue-by-venue API access, granted per restaurant/group that uses SevenRooms as their
  reservation system — realistically means **direct venue relationships** (see
  docs/DECISIONS.md#local-supply), not one integration that unlocks many restaurants at once.

## DesignMyNight / Quandoo
- More accessible self-serve/partner programs for bar and restaurant bookings in the UK —
  worth investigating first for the London pilot precisely because the barrier is lower than
  OpenTable/Resy.

## Realistic pilot path
Given the above, **direct relationships with a handful of independent restaurants** (the
"Phase 1: affiliate/deep-link inventory" step in the roadmap) are more achievable in the pilot
timeframe than any restaurant-aggregator API integration. `POST /admin/experiences/manual`
(see `docs/DECISIONS.md#local-supply`) exists for exactly this — a venue emails their weekly
availability, an operator enters it, it flows through the same canonical pipeline as an API
adapter would.
