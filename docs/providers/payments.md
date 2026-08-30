# Going live: payments (native checkout, Booking Model D)

`Payment` model and the booking-model abstraction (`BookingModel.NATIVE`) are in the schema
and `services/booking.ts`, but the Stripe integration itself is a documented stub —
`src/providers/payments/stripe.ts` throws a clear error if called without `STRIPE_SECRET_KEY`.

## What's needed to activate it
1. A real Stripe account, business verification completed (this takes real-world days, not
   API calls) — Stripe requires KYC before enabling live payments, especially for a
   marketplace/split-payment flow like group booking.
2. Decide the payments topology **before** activating: is Plot the merchant of record
   (collects payment, pays out to venues — needs Stripe Connect), or purely a pass-through to
   provider checkout (Booking Model A/B, no Payment rows created at all)? The pilot uses
   Model A exclusively for this reason — see `docs/DECISIONS.md#booking-models`.
3. `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` env vars.
4. Webhook endpoint (`POST /webhooks/stripe` — not yet built) verifying signatures with
   `STRIPE_WEBHOOK_SECRET`, idempotent on `event.id`.
5. Card details are NEVER handled server-side — Stripe Elements/PaymentSheet on the client,
   only a PaymentIntent id ever touches our backend. This is already how `stripe.ts` is
   structured so it's a slot-in, not a rewrite, once the above exists.

## Why this is out of scope for the pilot
Group-checkout payments (holding funds, splitting, refunding a no-show) is a real compliance
surface — see brief §20 and §75 "payments before proven demand" is on the explicit
anti-roadmap. The pilot's booking flow is Model A (deep link to the provider's own checkout);
Plot never touches money in V1.
