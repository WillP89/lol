# Going live: transactional email (magic links, notifications)

No email provider is wired up. `services/auth.ts#requestMagicLink` logs the link and, outside
production, returns it directly in the API response so the auth flow is fully testable without
one. In production it currently logs a warning and does **not** deliver the link — this is the
single highest-priority integration to close before any real user tries to sign in outside a
development environment.

## Recommended: Postmark or AWS SES
- **Postmark**: fastest to set up, good deliverability reputation out of the box, paid from
  message one. Needs a verified sending domain (SPF/DKIM DNS records).
- **SES**: cheaper at volume, more setup (domain verification, moving out of the SES sandbox
  which caps you to verified recipients only — a real blocker for a public pilot until
  granted).

## Implementation
Add `src/lib/email.ts` exporting `sendMagicLinkEmail(to, url)`; call it from
`requestMagicLink` guarded by `config.NODE_ENV === 'production'`. Needs `EMAIL_PROVIDER_API_KEY`
and a verified sending domain — budget a day for DNS propagation before it works reliably.
