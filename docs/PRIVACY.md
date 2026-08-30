# Privacy principles (engineering-level, not a legal document)

**This is not legal advice and does not substitute for it.** GDPR/UK GDPR compliance, a real
privacy policy, cookie consent, and data processing agreements with any provider all need
specialist legal review before real users are onboarded outside a controlled pilot — see
brief §54. What follows is how the code actually behaves today.

## Calendar: free/busy only

`AvailabilityWindow` stores a boolean `busy` flag and a time range — never an event title,
location, or attendee list. This is enforced by the schema shape, not just a policy: there is
no column that could hold a title. See `prisma/schema.prisma` and `services/availability.ts`.

## Contacts: hashed matching, not a stored address book

`ContactMatch` records that a hashed contact identifier turned out to belong to an existing
Plot user — it does not store the uploaded contact list itself. (The upload/hashing client
flow is not yet implemented; this is the storage-layer commitment it will need to honour.)

## Account deletion vs. deactivation

- **Deactivate** (`POST /users/me/deactivate`): reversible, revokes all sessions immediately.
- **Delete** (`POST /users/me/delete`): PII is overwritten (email, phone, display name), all
  sessions revoked, an `AuditEvent` is recorded. `IntentSignal` rows are retained with `userId`
  set to null rather than cascade-deleted — aggregate analytics (funnel conversion rates,
  category popularity) survive; the specific person does not remain identifiable in them.

## Admin access

See `docs/DECISIONS.md#admin-auth` — a shared-secret stopgap, explicitly flagged as needing
replacement before real operational use, precisely because it has no per-person audit trail.

## What still needs real legal review before launch

Cookie consent (the web app currently sets no tracking cookies beyond the session cookie,
which is functionally necessary and typically exempt, but confirm this), a real privacy
policy and terms of service, a data processing agreement template for any provider we send
user data to (none currently — Booking Model A sends the user to the provider's own site, we
don't transmit their data to the provider ourselves), and age-restricted event handling (not
implemented).
