# Going live: transactional email (magic links, notifications)

**Implemented** — `apps/api/src/lib/email.ts` sends via Postmark's REST API, called from
`services/auth.ts#requestMagicLink`. Not exercised against a live Postmark account from the
environment this was written in (no outbound network to `api.postmarkapp.com` from that
sandbox) — verify against the deployed service's logs once a real key is configured.

Gating is on `POSTMARK_API_KEY` being set, not `NODE_ENV`: configured → a real email is sent
and the magic-link API response omits the raw link; not configured → the link comes back
directly in the response (any environment) so the web app can show a "Continue →" button and
the whole auth flow stays testable without a provider. `NODE_ENV === 'test'` always skips a
real send regardless of whether a key is present, so the automated test suite never calls out
to Postmark.

If a real send throws (bad key, Postmark outage, unverified domain), `requestMagicLink` logs
the error and falls back to returning the raw link rather than leaving the user with nothing —
a deliberate pilot-scale tradeoff (this response only ever reaches the person who requested
it), not an oversight.

## Setup
1. Sign up at [postmarkapp.com](https://postmarkapp.com), create a Server.
2. Add and verify a sending domain (SPF + DKIM DNS records) — budget for DNS propagation, up
   to a few hours.
3. Grab the Server API token → `POSTMARK_API_KEY`.
4. Set `EMAIL_FROM` to an address on that verified domain.

Without a verified domain, Postmark's sandbox mode only delivers to pre-approved test
addresses — enough to confirm the integration works, not enough for a real pilot.

## Why Postmark over SES
Postmark: fastest to set up, good deliverability reputation out of the box, paid from message
one. SES is cheaper at volume but needs more setup and starts in a sandbox that caps you to
verified recipients only — a real blocker for a public pilot until AWS grants production
access. Postmark is what's implemented; swapping to SES later means a new
`sendMagicLinkEmail`-shaped function in `lib/email.ts`, not a rearchitecture.
