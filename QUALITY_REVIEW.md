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
2. Complete multi-property onboarding and role authorization before a commercial portfolio rollout. Named accounts now use tenant-scoped storage and sessions; the bundled property/inventory template still represents The Larkin.
3. Choose staff identity/roles, durable audit history, retention policy, backups, monitoring and incident ownership. Decision events remain process-local; the dashboard reads call history from Vapi.
4. Connect the actual inventory/calendar sources with freshness guarantees. Bundled fictional inventory and a standalone tour calendar are not a PMS integration.
5. Outgoing calls, SMS and email delivery are not wired into the live workflow. The UI must continue to describe follow-ups as staff tasks. The email module is independently tested; that is not evidence of live delivery.
6. Measure missed-call recovery, qualified leads, verified tour bookings, show rate and staff time saved with a pilot customer. Pricing and ARR goals need evidence from actual willingness to pay and retention.

No real voice call, paid model simulation, production deployment, or live Redis failure test is implied by the local test results.

## Vapi references checked

- [Server authentication](https://docs.vapi.ai/server-url/server-authentication)
- [Server URL priority](https://docs.vapi.ai/server-url/setting-server-urls)
- [Dynamic current-time template example](https://docs.vapi.ai/tools/go-high-level/)

## Named Larkin account follow-up

- Added username/password sign-in, salted scrypt credentials and independently signed, tenant-bound sessions. Removal, password change and membership change revoke sessions.
- Separated leads, follow-ups, active/finished calls, calendar records, events and call-history caches by tenant, including reset and deletion controls. Legacy records remain isolated during staged migration.
- Restricted Vapi reads and publishing to bound assistants. Preview publishing is disabled; publishing requires a canonical server origin and verifies saved configuration.
- Added an explicit local `larkin` fixture account. Credentials persist locally as a hash; sample operational records reset with the preview. No local account or password is provisioned into production.
- Further call-identity regressions cover repeated hidden-caller reports, delayed reports, terminal-call mutations and anonymous follow-up collisions.
- Negative tests exercise matching record IDs across accounts, forged scope inputs, legacy namespace escapes and concurrent KV/memory operations. See TENANCY.md.

Account follow-up validation: 419 tests passed on Node 22.23.2; TypeScript, data validation and the full build passed. Browser sign-in with the named Larkin account was verified, including account identity and sample records. Gitignored credential storage uses owner-only permissions.

## Practical scheduling and voice follow-up

- Calendar navigation requests the visible week or day and supports arbitrary future dates. Booking lead time and an optional advance limit are separate from staff browsing; the default has no advance booking limit.
- Each workspace can set concurrent showing capacity, duration, start spacing, preparation/reset buffers, minimum notice, daily tour hours and exclusive/shared apartment access in the portal. Revision checks prevent silent settings overwrites.
- Reservations retain actual start/end and occupancy intervals. Capacity uses peak simultaneous occupancy, including buffers, under the same atomic update as the active settings. Existing bookings survive hours, notice, duration and capacity changes.
- Availability and booking use the same rules through the portal and Vapi. Apartment-specific conflicts return usable alternatives. Invalid dates/units and changed-apartment retries cannot falsely confirm. DST, interval blocks and midnight-crossing buffers are covered.
- Staff see each actual tour once, including on Today after distant calendar browsing. Reopen targets the original block and Undo restores its saved interval. Production refuses bulk tour resets.
- Voice configuration removes avoidable pauses after routine intake, avoids duplicate tool calls, uses the current date, keeps contact email optional and avoids promising automatic messages or callback deadlines. Spoken budgets/bedrooms and conflicting, expired or foreign-property knowledge have regression coverage.

Validation: **465 tests passed**, with TypeScript checking, unchanged data validation and the full build on Node 22. Browser checks covered username/password sign-in, settings save/reload, three-person capacity with 45-minute tours, and June 2032 navigation with repeated paging. Integration tests drove real portal/Vapi handlers using local test data, including capacity three versus a fourth request and tenant-specific settings.

The signed-in live Vapi assistant was inspected. It has a pre-existing unpublished draft that changes the published voice and an old hardcoded date. No assistant publish or call occurred in this pass, and live latency has not been measured. A local rollout review records the concrete pending dashboard changes. The local demo still uses fictional data and resets operational records/settings when the preview restarts; account credentials persist. Scheduling currently uses the Larkin's New York timezone, and the code is not yet a general multi-property configuration/PMS integration.

## SaaS architecture safeguards

The follow-up adds an explicit developer handoff in ARCHITECTURE.md and three operational boundaries: hosted runtimes require configured durable storage and explicit tenant scope; bulk demo resets are refused on hosted runtimes; and finished-call processing records a replayable receipt before updating caller/follow-up projections. A failed finished-call write returns retryable 503 instead of acknowledging success, and completed receipts discard the duplicate prospect payload. Vapi diagnostics now include tenant, request, call and tool identifiers with elapsed tool time while excluding caller words and contact details.

Validation: **495 tests passed**, TypeScript/data checks and the full build passed. New tests cover storage configuration/outage handling, scoped hosted access, disabled hosted resets, partial projection failure, preserved original event data, replay, and duplicate completion. Scheduled recovery workers, transactional relational repositories, membership/property authorization, durable audit history and real customer onboarding remain future milestones; these guards do not establish full SaaS or SOW readiness.
