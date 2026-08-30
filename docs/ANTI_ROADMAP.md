# Anti-roadmap

Explicit, so scope creep has something to point at and say no to. Every one of these has come
up naturally while building the loop — the discipline is not building it just because it would
be easy to bolt on.

- **Generic messaging / chat replacement.** Plot does not compete with WhatsApp for
  conversation. The Plan Card + voting is structured intent, not a chat feature. If a Crew
  wants to argue about pre-drinks, that's what WhatsApp is already good at.
- **Public follower feeds / creator economy / Stories.** Wrong status currency for this
  product — see the phase-2 strategy note on "momentum, not follower count." Adding public
  broadcast dynamics imports Instagram's comparison-anxiety failure mode into a product
  explicitly positioned against it.
- **Photo-sharing / memory-reel network.** Rewind (one tap, post-plan) captures the training
  signal we actually need at near-zero cost. A full photo network is a different, harder
  product with different competitors (BeReal, Instagram) — see `docs/DECISIONS.md#rewind-not-memory-reel`.
- **Complex expense splitting (Splitwise-style running balances).** Booking cost-splitting at
  the point of a specific plan is in scope (`BookingParticipant`); a general-purpose IOU
  ledger between friends across all their spending is not — that's Splitwise's product, not
  ours, and building it doesn't strengthen Match/Agree/Lock.
- **Live friend location tracking.** Explicitly rejected in the phase-2 design pass — the map
  shows aggregated area activity, never a pin on a specific person, precisely to avoid Snap
  Map's stalking-risk failure mode.
- **Native ticketing infrastructure before proven demand.** Plot is not going to become a
  ticketing company (holding inventory, handling refunds, chargebacks) speculatively. Booking
  Model D (native checkout) stays unimplemented until real transaction volume through Model A
  justifies the compliance investment — see `docs/providers/payments.md`.
- **A general-purpose AI chatbot tab.** Natural-language planning ("sort us something
  Saturday") is a real V1/V2 direction, but it routes to the same typed Match/Plan objects
  everything else uses — it is not a freeform chat interface bolted onto the side of the
  product.
