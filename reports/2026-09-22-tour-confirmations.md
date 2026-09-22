# Staff tour confirmation delivery — September 22, 2026

AT-135, Codex root. Branch `codex/at135-tour-confirmations`, base `d8a3d47e823f7661102ead01cba8e4ddb0926a36`. This branch includes the earlier email adapter, public/voice shortlist, evaluation infrastructure and Vast/female-voice direction. Scope: a usable staff calendar flow, backend admission, targeted processing and local acceptance. This is source implementation, not customer activation.

## What changed

In a managed PostgreSQL workspace, staff can open a saved tour, review its exact email confirmation, record the prospect's permission and submit it. The interface separates a saved intent, provider acceptance and verified delivery. It works with keyboard controls at phone and desktop sizes. Missing configuration visibly disables sending.

The server derives the recipient, property/apartment, local date/time, sender and message from current saved data. It rejects missing exact times/email, past or cancelled bookings, pending booking/reschedule reviews, emergency holds and overlapping unit/building holds, including reserved preparation time. Staff cannot replace the recipient or message through the command body.

Admission locks the calendar and commits permission, workflow receipt, action and outbox together. Duplicate operator requests share one action. Processing claims only that action, rechecks known booking changes immediately before submission, and preserves the existing no-blind-resend policy. Lost browser responses recover by loading the same saved confirmation. Staff may manually check delivery; no background runner was enabled.

The new API requires authenticated staff `operate` permission, current property/configuration scope and same-origin JSON for writes. It does not exist in legacy mode. Sender configuration is optional, explicitly scoped, publisher-reviewed and expiring. No migration or dependency was added.

## Actual verification

All commands used Node 22.23.2 in the isolated feature worktree.

| Check | Result |
| --- | --- |
| `npm run check` | Typecheck and fixture validation clean; 1,695 application tests passed, 0 failed. |
| `node --test --test-concurrency=2 'test/database/*.test.mjs'` | 521 disposable native PostgreSQL tests passed, 0 failed. |
| `npm run build` | All 18 shipped API handlers imported and refused unconfigured requests in both runtime modes. |
| `node test/browser/tour-confirmations.mjs` with bundled Playwright/Chrome | 12 scenario groups passed; five synthetic provider submissions, zero real emails. |
| Source review, generated dashboard and `git diff --check` | Reviewed/clean. Phone and desktop screenshots inspected. |

The 13 new database/HTTP cases exercise the actual handlers, sessions, scoped storage and a local HTTP provider: full preview/admission/submission/readback, concurrent operators, concurrent processing, stale/injected commands, changed/cancelled/held tours, missing configuration, anonymous/viewer/foreign-property/cross-site denial, unrelated queue isolation, corrupted permission linkage, original-authority revocation, dropped provider acknowledgement, atomic storage rollback and calendar-lock serialization.

Chromium checks use 320, 390 and 1280px widths and real local handlers/database. They cover keyboard permission/send/readback, unavailable configuration, no horizontal overflow, retained delivery when reopening, dropped queue/process browser responses and a stale form. External browser/server calls are blocked or routed to the synthetic provider. The adapter's separate native HTTP suite remains included in the database result.

Development failures were resolved before acceptance: the foreign-property test fixture initially used the wrong configured timezone; browser tests initially targeted tomorrow's tour from today's mobile view and used a desktop-only selector; release smoke caught a missing no-index response header, now added. Final checks above passed. No independent reviewer, cloud CI or live provider acceptance is claimed.

## Release and operational limits

No real email, paid simulation/call, provider credential, sending domain, Vapi setting, hosted database or production deployment changed. Production was last observed at `5ef6468`; it was not recertified by this work. The pending AT-129 production promotion decision remains separate and must not be bypassed through this feature branch.

The staff checkbox persists the operator's assertion of prospect permission; it is not independent proof. Current saved booking email is required. Permission expires after one hour. Sender review expiry currently gates manual verification as well as dispatch. A changed configuration/original authority can require administrator recovery. Historical confirmations remain in Work queue; the dialog is tied to the current future reservation.

Booking revalidation is immediately before provider IO, not an atomic cross-provider transaction. A valid email can be followed by a later reschedule. There is no network IO under the calendar lock. An ambiguous send without a persisted provider ID needs investigation, not another send. Actual provider normalization, account permissions and inbox delivery remain unverified. See [the delivery contract and setup](../docs/email-delivery.md).

## Owner to-dos

- Resolve the separately pending production release decision when ready; a source push does not activate this feature.
- Choose a verified sending identity/domain and an owner-approved test recipient before real delivery acceptance. Provide provider access through secure configuration at that stage.
- For the voice direction, choose a preferred audition and a bounded hosting/call-test budget. Permissioned representative calls and verified property rules remain necessary for meaningful evaluation.

## Codex/Fable next steps

- Review this branch and integrate the tested feature chain deliberately. Preserve the older checkout's partial calendar edits.
- Complete the approved hosted PostgreSQL rollout and sender setup before offering this flow in production; verify one permissioned real inbox delivery and its persisted evidence.
- Add trusted voice/shortlist permission admission, a bounded scoped runner, delivery-event reconciliation and historical email visibility.
- Establish the actual phone baseline, verify available licensed voices, audition the requested direction, and benchmark Vast hosting against the baseline before any live switch. No improvement has yet been measured.
- End the next session with a reciprocal handoff: exact commits/deployments, actual checks and limits, owner to-dos and next-agent to-dos. The broader product goal remains active.
