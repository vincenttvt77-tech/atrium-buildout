# Staff tour cancellation — September 23, 2026

AT150, Codex root. Base `9fd205908c26c96d1b9d0530df89f016a4fbff13`;
branch `codex/at150-tour-cancellation`. Full leasing goal remains active.

## Delivered in source

Staff can cancel a saved future tour from Calendar details after reviewing its
identity and entering a reason. The reservation leaves active capacity and remains
in a durable archive with its contact, exact times, apartment, original call,
actor and reason. Recent history is available from Calendar and the lead's tour.
The form explicitly distinguishes cancellation from notifying the prospect.

- Atomic calendar, receipt, archive/index, profile/follow-up and audit; exact
  same-command recovery after lost acknowledgement. Stale contacts/schedules,
  changed input, current authority/configuration and foreign scope are refused.
- Original-call and exact-reservation fences prevent delayed creates and cached
  voice results from presenting the cancelled tour as confirmed. Fresh calls can
  book the released capacity. Late call completion and old reschedule projection
  preserve cancellation, including cancellation before any lead record exists.
- Only matching tour work is retired; unrelated bookings/callbacks and historic
  call summaries remain. Done/skipped task status is retained, with cancellation
  metadata preventing reactivation. Ambiguous older tasks remain flagged.
- Queued confirmation dispatch refuses the removed booking; already submitted
  messages cannot be recalled. No cancellation message is sent or invented.
- Responsive reviewed form, explicit retry, reason/history, work-queue navigation,
  route/property retirement, developer routing and shipped API bundle included.
  No SQL migration, new dependency, live provider change or paid call.

## Checks and evidence

- `npm run check`: 1,795 passed; typecheck and fixture validation clean.
- Full isolated PostgreSQL suite, `node --test --test-concurrency=2 'test/database/*.test.mjs'`:
  671/671 passed in 273 seconds. Includes 17 new cancellation cases and two new
  signed voice/email cases. Explicit multi-connection gates cover both race orders.
- `npm run build`: 24 handlers imported and refused unconfigured requests in both
  runtime modes, with external network blocked by the bundle verifier.
- Focused new cancellation suite: 17/17 passed. Voice cancellation/replay and
  obsolete queued-email cases: 2/2 passed; full suite covers existing 49 voice cases.
- Booking uncertainty/review regressions: 11/11 passed after preserving existing
  negative responses during a calendar-read outage.
- Browser evidence and source publication are recorded in the completion checkpoint
  below. Root review; no independent reviewer was launched.

Initial failures were retained as evidence: the first race fixture used a one-
connection pool and deadlocked its own gated test; it was stopped and corrected to
an independent eight-connection pool. New voice fixtures initially used incorrect
field names. A redundant cancellation read overwrote unconfirmed booking-recovery
responses during an outage; the guard now preserves those already-negative
responses, and all 11 affected regressions pass. Bundle smoke initially lacked the
new managed-only endpoint's expected legacy404 entry. Browser testing found an
incorrect navigation method and fixture timing around same-document navigation;
source navigation was fixed and fixture resets now wait for the actual new
reservation revision and rendered calendar. No business assertion was removed.

## Cloud evidence and remaining limits

The base AT149 GitHub run `35906639434`, job `107335862518`, is terminal FAILURE:
application checks passed, native651/652 passed, build skipped. The exact saved
work-item lookup test failed before reading its first-page actions. Its response
status is now asserted explicitly instead of being masked by an undefined-array
error. The focused test and the full local native suite pass. This is **not** a
verified repair of the cloud failure; the next run and any repeated failure need
investigation before release acceptance. Do not restart or keep polling this
terminal base job as though it were live.

No production promotion, hosted migration/configuration, Vapi publication, real
call, GPU rental or real email occurred. The managed hosted Preview and actual
phone-to-dashboard acceptance remain separate gates. AT129 promotion approval is
not bypassed. Cancellation notifications, caller self-service cancellation and
large-history indexed/paginated repositories remain further work; this feature
uses the existing bounded transitional stores.

## Owner to-dos

Complete secure isolated Preview provisioning; provide verified property/showing
rules and permissioned representative calls. Choose the voice after auditions and
set a bounded paid voice/hosting trial budget. Do not send secrets in chat. No new
owner input was required for the local cancellation implementation.

## Next Codex / Fable to-dos

Verify this branch's exact cloud run; investigate the work-queue failure if repeated.
Independently review cancellation/late-call locking, archived identity, retry and
notification boundaries. Validate the managed hosted workflow once configured,
then actual phone→tool→calendar→lead results. Continue permissioned notification
and follow-up completion, scale-appropriate repositories and controlled onboarding.
For voice, resolve licensed IDs/account access, audition matched clips and establish
a successful measured baseline before testing Vast and changing speech separately.

End the next session with a reciprocal handoff: exact source/deployments, actual
checks, unresolved risks, owner to-dos and next-agent to-dos. Source tests are not
evidence for the goal's representative real-call success or latency targets.

## Local completion checkpoint — 2026-09-23T19:45:21Z

Final browser8/8 scenario groups passed at320/390/1280px using actual Chromium,
HTTP handlers, isolated PostgreSQL and signed synthetic MFA. Tested exact
reservation/reason/attestation, actual freed capacity, history, lost committed
reply, stale snapshot/re-review, work queue navigation and route/property retirement.
Zero synthetic or real email sends. Narrow/desktop screenshots visually inspected.
All local tests/processes are terminal. Diff reviewed and clean; scoped source
publication and its own cloud verification are next. The base cloud failure above
remains explicitly separate from these successful local results.
