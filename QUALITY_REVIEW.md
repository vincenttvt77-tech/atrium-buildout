# Atrium quality review — September 9, 2026

This pass improves the existing leasing demo and staff workspace. It does not establish production readiness for a multi-tenant commercial service.

## What changed

- White and navy CRM theme: branded navigation, property header, clearer typography, consistent cards and controls, responsive layouts, and a matching sign-in page.
- Atomic Redis compare-and-set protects calendar and document updates across instances. Concurrent in-memory updates also retain every change.
- Unreachable or corrupt storage refuses availability instead of becoming an empty, bookable calendar. Redis command errors are detected, requests have timeouts, and caller data travels in POST bodies rather than URLs.
- Calendar generation handles daylight-saving boundaries and non-hour-dividing tour lengths. Invalid, expired, and fabricated slots cannot be booked; verification compares the entire slot duration.
- Availability dates retain their calendar day across time zones. Move-in parsing preserves named days, current months and seasons, and month-end boundaries.
- Warm functions refresh the bundled inventory snapshot. Invalid inventory statuses, impossible dates, and conflicting bedroom counts are excluded.
- Concurrent webhook requests merge captured signals. Malformed tool arguments retain their result IDs without dropping subsequent tools. Deployed webhooks require verification; bearer credentials and legacy secret headers are supported.
- Caller numbers are used for booking identity. Contact capture saves unbooked prospects. Emergency transcripts persist an escalation for staff follow-up. Caller names are no longer included in routine tool-result logging.
- Repeated call reports do not duplicate profile events. Late older calls preserve newer contact details. Anonymous callers have separate stored profiles, and successful tour retries upgrade failed bookings.
- Assistant synchronization preserves existing server credentials. Saved assistants resolve the current New York date on each call; simulations use their injected clock.
- Calendar links open a booked tour even when capacity remains in the slot. Browser back/forward navigation is handled explicitly. Status copy no longer claims support was notified when no notification was sent.
- The build regenerates site and dashboard artifacts. Vercel receives the required build scripts; GitHub Actions installs the npm lockfile, validates, tests and builds.

## Verification

- Baseline: 337 of 338 tests passed; a November 1 date rendered as October 31 on the local machine.
- Final suite: 365 tests passed on Node 22.23.2.
- TypeScript check, data validation, API bundles and generated dashboard/site consistency passed.
- Clean `npm ci`: 12 packages installed, zero vulnerabilities reported.
- Browser checks: authenticated CRM, desktop and narrow layouts, lead search and detail views, staff note saving, tour deep links and calendar details. Additional local checks are recorded in the task.
- Only local fixture data was used for mutating workflow tests.

## Before a paid production pilot

1. Verify the deployed version, Vapi assistant, phone-number routing, webhook credential and real Redis instance together. Run controlled test calls, including a retry, concurrent booking, escalation and an interrupted conversation.
2. Add tenant-scoped storage and authorization before onboarding multiple customers. Current storage keys, shared passcode, and property configuration represent one demo property.
3. Choose staff identity/roles, durable audit history, retention policy, backups, monitoring and incident ownership. Decision events remain process-local; the dashboard reads call history from Vapi.
4. Connect the actual inventory/calendar sources with freshness guarantees. Bundled fictional inventory and a standalone tour calendar are not a PMS integration.
5. Outgoing calls, SMS and email delivery are not wired into the live workflow. The UI must continue to describe follow-ups as staff tasks. The email module is independently tested; that is not evidence of live delivery.
6. Measure missed-call recovery, qualified leads, verified tour bookings, show rate and staff time saved with a pilot customer. Pricing and ARR goals need evidence from actual willingness to pay and retention.

No real voice call, paid model simulation, production deployment, or live Redis failure test is implied by the local test results.

## Vapi references checked

- [Server authentication](https://docs.vapi.ai/server-url/server-authentication)
- [Server URL priority](https://docs.vapi.ai/server-url/setting-server-urls)
- [Dynamic current-time template example](https://docs.vapi.ai/tools/go-high-level/)
