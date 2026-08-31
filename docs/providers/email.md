# Going live: transactional email (magic links, notifications)

**Implemented** — `apps/api/src/lib/email.ts` tries, in order: Resend (HTTP API) → SMTP → Postmark
(HTTP API), called from `services/auth.ts#requestMagicLink`. None has been exercised against a
live account from the environment this was written in (no outbound network to
`api.resend.com`/`smtp.gmail.com`/`api.postmarkapp.com` from that sandbox) — verify against the
deployed service's logs once real credentials are configured.

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

## Setup — Resend (recommended on Render specifically: HTTP, not blocked)
1. Sign up at [resend.com](https://resend.com) with any email, including personal Gmail.
2. **API Keys** → create one → `RESEND_API_KEY`.
3. Set `EMAIL_FROM` to `onboarding@resend.dev` — Resend's own shared sending domain, no
   verification needed.

**UNVERIFIED CAVEAT** — genuinely don't know this part works yet, same honesty bar as the
Eventbrite adapter: some HTTP email APIs restrict their free/no-verification shared sender to
only deliver to the account owner's own signup address until a real domain is verified.
Whether that applies to Resend's `onboarding@resend.dev` isn't confirmed from here. **Test it
in this order before relying on it**:
1. Send a magic link to the same email you signed up to Resend with — should work regardless.
2. Send one to a *different* address (a friend's, or a second personal address you own).
3. If step 2 silently doesn't arrive (or gets rejected), that's the restriction — a verified
   domain (a few minutes of DNS records, same idea as Postmark's) unlocks sending to anyone,
   or a different provider is needed. Tell me what you see either way.

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
