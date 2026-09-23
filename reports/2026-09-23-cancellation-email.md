# Staff cancellation email — September 23, 2026

AT152, Codex root. Base `84c7a69ba00bcc53af9c90fd161ccde9a043ef6a`;
branch `codex/at152-cancellation-email`, worktree `atrium-cancellation-email`.
Local acceptance checkpoint: 2026-09-23T20:47:06Z. Full leasing goal remains active.

## Delivered

Staff can open a saved cancellation from Calendar history, review its exact email
and recipient, record the prospect's permission and send the cancellation email.
The form separates saved permission, provider acceptance and verified delivery.
Cancelling by itself still sends nothing. The outgoing message omits internal
staff reasons and says no replacement tour was reserved.

The cancellation purpose has its own property sender authorization. The reviewed
source, recipient, content and sender bind one immutable action. Calendar-locked
admission commits the permission, message, purpose index, workflow receipt and
outbox together. Simultaneous staff, double clicks and lost responses reuse that
action. Changed details show the earlier recipient and exact Work queue action
instead of silently sending a second copy.

First dispatch checks current cancellation, source, configuration and authority.
Provider uncertainty remains verification-only; an unknown acknowledgement never
authorizes another send. Exact provider message readback establishes delivery,
not human reading. Existing Work queue/post-call reconciliation can check an
already attempted cancellation email without initiating one.

The shared confirmation/cancellation modal now bounds requests at15seconds and
offers recovery. A late reply cannot continue a timed-out/retired send sequence.
Mobile320/390 and desktop1280 flows use the existing navy/white accessible dialog.
Documentation distinguishes the historical archive's `notification: not_sent`
from a later email's independent permission and delivery evidence.

## Checks and actual results

- `npm run check`: **1,800/1,800 passed**, including TypeScript and data validation.
  Five new pure cancellation draft/sender tests; the new endpoint participates in
  immutable property-header and response-scope tests.
- `node --test test/database/tour-cancellation-emails.test.mjs`: **22/22 passed**.
  Actual HTTP and temporary PostgreSQL with independent pooled connections cover
  concurrent admission/dispatch, lost API/provider responses, exact purpose and
  sender, scoped authorization/configuration, malformed input, calendar locking,
  transaction rollback, changed/missing/conflicting source, expired consent,
  revoked origin, escaped content, recipient mismatch and readback truth.
- `npm run test:database`: **702/702 passed**, approximately130seconds. Includes
  original leasing, confirmation, workflow, RLS and authority regressions.
- `npm run build`: **25 shipped API handlers** imported and refused incomplete
  configuration in both runtime modes; site/portal generation passed.
- Real Chrome + HTTP + PostgreSQL, signed synthetic MFA: **10 new cancellation
  email groups**, **27 existing confirmation/contact groups**, **8 original
  cancellation groups** passed. Covers320/390/1280px, keyboard operation, history,
  delivery/reopen, unconfigured state, lost committed replies, a real15second
  stalled response, changed recipient navigation, route retirement and foreign
  property response fencing. Zero real messages/provider calls.
- Final mobile/desktop cancellation-email screenshots visually inspected.
  `git diff --check` passed. Source reviewed by root; no independent review claimed.

The first native run passed18/22: two fixtures attempted to mutate a published
configuration instead of publishing a new version; another advanced only the
application clock beyond the database lease; another expected immediate review
instead of the worker's bounded verification attempts. Corrected fixtures preserve
real immutability/leases and assert eventual review with exactly one provider effect.
No production safeguard was weakened.

The first full app run passed1,799/1,800 and the browser reproduced a missing portal
scope-header registration for the new endpoint. Registering it corrected both.
A later browser fixture's socket drop did not surface the intended browser error;
the final test lets the real handler commit and deliberately drops only the browser
response. Lost reply, no-duplicate and actual persisted effects remain asserted.
All final suites passed after these corrections; no skipped failures.

## Release limits and reciprocal handoff

No live email, paid call/audio/GPU, Vapi setting, hosted schema/runtime change or
production promotion occurred. Source publication is separate from activation.
This slice adds no migration; its parent includes the unapplied AT151 workflow
read-policy migration. Managed hosted setup, sender/domain credentials, permissioned
test recipient, inbox readback and actual voice/tool/dashboard acceptance remain.
AT129's pending promotion decision remains separate.

This is staff email for an existing cancellation, not caller self-service
cancellation, SMS, archive contact editing, automatic notification or a PMS adapter.
One cancellation gets one reviewed email purpose; the UI does not offer silent
replacement/resend. Shared provider history remains a later improvement: a latest
`opened` event alone is intentionally not reported as delivery/human reading.
Confirmation and cancellation requests still share the existing bounded document
stores, with large-history normalization/pagination work remaining.

The parent84c7a69 GitHub run35915031566/job107364236650 is terminal **SUCCESS** for
application/database/build. Do not poll it as pending. Current branch publication
and its exact cloud result must be recorded separately; this report cannot imply
that a not-yet-created deployment has been accepted.

Owner to-dos: finish secure isolated Preview provisioning, provide approved building
rules and permissioned representative leasing calls, choose voice/accent after
audition, and set a bounded audio/hosting trial budget. Credentials stay private.

Codex/Fable next: verify the exact published commit/current CI; independently review
the cancellation-email boundary and parent's policy equivalence; activate only the
reviewed managed test environment and verify real sender/inbox behavior. Continue
remaining caller rescheduling/cancellation and permissioned follow-ups, then measure
a successful real phone baseline and compare Vast hosting and licensed female voice
candidates separately. Preserve the active full leasing goal and current live demo.

The canonical board/status remain in `atrium-buildout`; unrelated calendar edits
there are preserved. End the next session with a reciprocal handoff containing
exact commits/deployments, checks/failures, local versus hosted evidence, remaining
limits and separate owner/agent to-dos. This report is published with implementation
so a GitHub-only reviewer can read it; outer EOD/Fable notes are convenience ledgers.
