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

The live Atrium v2 assistant v19 was published on September 9, 2026, and its complete native configuration was verified after reload. The limited six-field update changes the greeting to disclose the AI/demo and recording, uses the current New York date, sets the response wait to 0.4 seconds and the three endpoint thresholds to 0.3/1.2/1.0 seconds. Existing Nico, model/transcriber providers, six reusable tools, knowledge file and webhook were preserved. No live call or latency measurement occurred; full backend-dependent prompt/tool synchronization still requires a coordinated new-backend rollout. The local demo still uses fictional data and resets operational records/settings when the preview restarts; account credentials persist. The later timezone work below generalizes calendar arithmetic; a general multi-property configuration/PMS integration remains unfinished.

## SaaS architecture safeguards

The follow-up adds an explicit developer handoff in ARCHITECTURE.md and three operational boundaries: hosted runtimes require configured durable storage and explicit tenant scope; bulk demo resets are refused on hosted runtimes; and finished-call processing records a replayable receipt before updating caller/follow-up projections. A failed finished-call write returns retryable 503 instead of acknowledging success, and completed receipts discard the duplicate prospect payload. Vapi diagnostics now include tenant, request, call and tool identifiers with elapsed tool time while excluding caller words and contact details.

Validation: **495 tests passed**, TypeScript/data checks and the full build passed. New tests cover storage configuration/outage handling, scoped hosted access, disabled hosted resets, partial projection failure, preserved original event data, replay, and duplicate completion. Scheduled recovery workers, transactional relational repositories, membership/property authorization, durable audit history and real customer onboarding remain future milestones; these guards do not establish full SaaS or SOW readiness.

## Sandbox isolation, property time and safety regressions

- Local text simulations now create a synthetic tenant in a dedicated worker per scenario, with memory stores and denied application network transports. Operational credentials are not inherited. A key-free preflight verifies the isolation path; it does not evaluate a model. The parent model adapter pins its destination and suppresses provider error details.
- Calendar API, staff portal, Vapi scheduling, follow-up processing and confirmation templates use validated property timezones. Chicago and other timezone fixtures cover local midnight, daylight-saving changes and non-hour offsets. The Larkin remains the bundled property. Calendar writes require the page's expected timezone, and retained blocks display and restore their original UTC coverage after a timezone correction.
- Emergency screening inspects all tool arguments before any leasing action. A per-interaction safety hold shares the atomic calendar update with bookings, so a hold that commits first prevents stale booking requests and retries from committing. Existing bookings are preserved. Partial failures keep the strongest available safety signal and return retryable failures without replacing known guidance with routine callback copy. No delivery or dispatch is claimed.
- A passed appointment time no longer counts as tour attendance. Post-tour tasks ask staff to verify attendance. Current-call emergency staff-review tasks are due immediately, including after hours; old reports do not create fresh urgent tasks on unrelated calls.

Validation: **573 tests passed**, with TypeScript, data validation and the full build on Node 22.23.2. Tests include an actual mocked Redis compare-and-set race, failure of each safety projection, replay, malformed nested arguments, property timezones, original block restoration and simulation isolation. The local preview was restarted through the real fixture seeder and authenticated portal; account credentials persisted.

A native Vapi smoke suite was saved with six enabled tool mocks and two required evaluation criteria. A one-iteration Chat run was refused by Vapi's payment-method precondition, so no native simulation transcript, evaluation score or audio latency result exists. The suite setup is not a passing voice test. New backend behavior remains on the development branch pending coordinated deployment and assistant synchronization.
# PostgreSQL foundation checkpoint — September 9, 2026

The new database path is implemented behind explicit repository interfaces. Existing
portal/API callers still use the previously tested account and memory/Redis adapters;
no hosted database, customer data migration or portal cutover occurred in this checkpoint.

- `npm run check`: **602 tests passed**, with TypeScript and bundled-data validation.
- `npm run test:database`: **36 tests passed against native PostgreSQL 17.10**, using
  temporary loopback-only databases and the real restricted application/authentication roles.
- `npm run build`: passed. Existing generated portal artifacts did not change.
- Database cases include two organizations/four properties, identical contact/provider
  keys, explicit grants, viewer restrictions, password/session/channel revocation, pooled
  context cleanup, immutable configuration, unchanged source freshness, and atomic audit.
- Concurrent requests preserve all document increments and admit only three tours for
  three available staff. A building mismatch is refused before booking. Emergency holds
  remain effective through the PostgreSQL calendar adapter.
- Deterministic mid-request revocation tests reject reads instead of reporting empty
  data and roll back affected writes and audits. A caught SQL failure cannot be mistaken
  for a successful commit. Async document mutations are rejected without changing data.
- The CLI-generated migration applies once, verifies checksums and rejects insertion of
  an earlier migration into applied history. A synthetic snapshot restores exact account
  hashes, organization/property ownership and UTC booking intervals into a fresh database;
  an invalid ownership reference rolls back the entire restore.

Supabase's advisor command was attempted against the isolated native PostgreSQL instance.
It could not execute its lints because the Supabase-specific `anon` role is absent. This
is not an advisor pass. The database tests independently inspect role attributes, ownership,
forced RLS and function privileges. Run the provider's advisors against the selected actual
deployment before activation. A production backup/restore drill, supported production patch,
API/UI integration, legacy migration reconciliation and full SOW acceptance remain open.
