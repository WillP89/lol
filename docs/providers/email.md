# Going live: transactional email (magic links, notifications)

**Status: `plotmaker.co.uk` is verified in Resend** (DKIM + the `send` subdomain's MX/SPF records
all green — confirmed via the Resend dashboard). That removes the one real restriction on the
free/shared sender (`onboarding@resend.dev` can only deliver to the account owner's own address);
a verified domain can send to anyone. **The only thing left to go live is setting
`RESEND_API_KEY` and `EMAIL_FROM=hello@plotmaker.co.uk` in Render's environment variables for the
API service** — this sandbox has no Render dashboard access, so that one step has to happen
outside this session. Once it's set, `requestMagicLink` sends a real email automatically (see the
gating logic below) and the web app's "Continue →" dev-link fallback stops appearing on its own —
no code change needed on top of this.

**Implemented** — `apps/api/src/lib/email.ts` tries, in order: Resend (HTTP API) → SMTP → Postmark
(HTTP API), called from `services/auth.ts#requestMagicLink`. Not exercised against a live send
from *this* sandbox (no outbound network to `api.resend.com` from here) — verify against the
deployed service's logs once `RESEND_API_KEY` is set on Render.

**SMTP is confirmed NOT to work on Render specifically** — a real send attempt there hung and
then timed out (`Connection timeout`, ~8s, the signature of a blocked outbound port rather than
a credentials problem — a wrong password fails in under a second). Render blocks outbound SMTP
ports as an anti-spam-abuse measure, a common policy on shared PaaS hosting. It's kept in the
code for whichever host doesn't block it; **Resend is what actually has a chance of working on
Render**, because it's a regular HTTPS call (port 443), not a raw SMTP socket — that class of
outbound connection is essentially never blocked.

Gating is on any of `RESEND_API_KEY` / (`SMTP_HOST`+`SMTP_USER`+`SMTP_PASS`) /
`POSTMARK_API_KEY` being set, not `NODE_ENV`. None configured → the magic-link API response
returns the raw link directly (any environment) so the web app can show a "Continue →" button
and the whole auth flow stays testable without a provider. `NODE_ENV === 'test'` always skips a
real send regardless of what's configured, so the automated test suite never calls out to any
of them.

If a real send throws (bad credentials, provider outage, unverified sender, a blocked SMTP
port), `requestMagicLink` logs the error and falls back to returning the raw link rather than
leaving the user with nothing — a deliberate pilot-scale tradeoff (this response only ever
reaches the person who requested it), not an oversight. This is also why sign-in kept working
even while SMTP was silently broken on Render — once the request stopped *hanging* (see the
timeout note below), this fallback could actually run.

## Setup — Resend (recommended on Render specifically: HTTP, not blocked) — DONE except one step
1. ~~Sign up at [resend.com](https://resend.com)~~ — done.
2. ~~Add and verify `plotmaker.co.uk`~~ — done: DKIM verified, `send.plotmaker.co.uk`'s MX + SPF
   (`v=spf1 include:amazonses.com ~all`) both verified. Domain status: **Verified**.
3. **Remaining:** in Resend → **API Keys**, create one, then in Render → the API service →
   **Environment**, set:
   - `RESEND_API_KEY` = that key
   - `EMAIL_FROM` = `hello@plotmaker.co.uk` (this is now the code default too — see
     `apps/api/src/lib/config.ts` — but Render's env var wins if set, so set it explicitly for
     clarity).

   No code deploy is required for this step — it's a Render dashboard env var, and
   `providerReadiness.resendEmail` (`lib/config.ts`) flips on as soon as `RESEND_API_KEY` is
   present, at next process start.

Because the domain is verified (not the shared `onboarding@resend.dev` sender), the restriction
that limits free/unverified senders to only the account owner's own address does **not** apply
here — this can send to *any* real recipient, which is what unblocks the actual multi-person
"invite a real friend" journey. Verify by watching Render's API logs on first real send: a
success looks like no `'Resend send failed'` error log and the web app's "Check your email"
screen no longer showing a "Continue →" dev-link (that only renders when `devMagicLinkUrl` comes
back, which only happens when no provider is configured or a real send just threw).

## Setup — SMTP through a mailbox you already have (works on hosts that don't block SMTP ports)
1. On the Google account to send from: turn on **2-Step Verification**
   (myaccount.google.com/security).
2. **myaccount.google.com/apppasswords** → create one ("Plot") → copy the 16-character password.
3. Set: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=<the Gmail address>`,
   `SMTP_PASS=<the App Password>`, `EMAIL_FROM=<the same Gmail address>`.

Confirmed working *as code* (correct credentials, correct protocol) but confirmed **not
reachable from Render** — the outbound connection itself is blocked there. Worth keeping
configured if Plot ever runs somewhere else that doesn't block SMTP ports.

## Setup — Postmark (better once there's a real domain to verify, for real volume)
**Domain verification**: sign up at [postmarkapp.com](https://postmarkapp.com), create a
Server, add and verify a sending domain (SPF + DKIM DNS records), grab the Server API token →
`POSTMARK_API_KEY`, set `EMAIL_FROM` to an address on that domain.

**Sender Signature** (verifies one mailbox, no DNS): Sender Signatures → Add Sender Signature →
the address to send from → click the confirmation link Postmark emails to it → grab the Server
API token → set `EMAIL_FROM` to that exact address. **In practice this has not been enough on
its own** — Postmark's account-approval process rejected/stalled a personal-Gmail-only signup
even after the Sender Signature itself verified successfully.

## Why this order
Resend first because it's the one path that's both (a) not blocked by Render's SMTP policy and
(b) doesn't route through Postmark's account-approval process that a personal-Gmail-only signup
didn't clear. SMTP stays as a fallback for a host that doesn't block it. Postmark stays for
once a real domain exists and higher-volume deliverability reputation actually matters.
