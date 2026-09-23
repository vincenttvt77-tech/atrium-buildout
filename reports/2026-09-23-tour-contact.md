# Atrium work report and Codex → Fable handoff — September 23, 2026

Post-booking contact correction now keeps a managed voice call and its exact saved
reservation together. A caller can book first, then provide an email, or correct a
name/email without creating another tour. Two baseline failures were reproduced:
a late email never reached the reservation, and changing the saved recipient made
the staff service offer a second confirmation for the same reservation revision.

## Source and release

- Branch: `codex/at146-tour-contact`; base `a7f33216a56e6edd010c7687e397cb4631f913f6`.
- Implementation worktree: `/Users/evanmavashev/Documents/ChatGPT/Atrium/atrium-tour-contact`.
- Owner/coordinator: Codex root. Canonical board remains in `atrium-buildout/docs/agent-tasks.md`.
- Source publication follows final acceptance; this report's containing commit identifies the published source.
- No production promotion, hosted migration, live Vapi publication, real email/call,
  audition, paid simulation or GPU rental occurred. AT129 remains separately pending;
  a source branch is not a workaround for that release decision.

## Changes

1. Added an original-call contact service using the existing authorized PostgreSQL
   calendar/document transaction. Exact reservation, original call, admitted tool,
   previous contacts, times, apartment and review/safety state guard the write. Both
   records and their audits commit together or roll back. Scheduling revision,
   occupancy, reservation ID and caller number remain unchanged. Volunteered callback
   numbers remain separate evidence. Same-batch booking/correction and already-admitted
   correction racing call end preserve the booking readback and final lead projection.
2. Staff and voice email admission share per-reservation confirmation history. Contact
   or content changes cannot make a second automatic email for the same scheduling
   revision. A cancelled, never-dispatched action can be replaced after fresh permission
   for changed details; a possible prior send stays held for review. Actual reschedules
   retain distinct confirmation purposes. Legacy unknown revisions are conservative.
3. A prepared offer's old permission cannot authorize the corrected email. Status checks
   can still observe the original action after contact changes, explicitly naming its
   original recipient. A failed preparation does not erase that earlier offer.
4. The staff preview shows the corrected address and prior-confirmation review reason,
   with no new-send permission control. Source tool wording and prompt explain the
   supported correction and continued restrictions on changing an older tour.

No workflow is redirected or recalled. If a provider request is already in flight,
the contact correction cannot retract it. Its original action remains authoritative.

## Verification

- `npm run check`: **1,794 passed**, typecheck and fixture validation clean.
- Voice confirmation acceptance: **48 native HTTP/PostgreSQL cases passed in the final suite**,
  including **24 new cases**. The fixture uses multiple actual
  connections for staff-admission/correction races, actual scoped repositories and
  synthetic HTTP providers. Coverage includes duplicate/lost responses, fresh consent,
  original recipient status, transactional calendar/document/audit/index rollback,
  legacy history, mismatched/duplicate reservations, stale staff contacts, tenant
  boundaries, call-end ordering and same-batch booking/correction.
- Full native database suite: **639 passed, zero failed** in 337 seconds.
- `npm run build`: **22 API handlers** built and smoke-checked in both runtime modes.
- Actual Chromium + HTTP handlers + disposable PostgreSQL + signed synthetic MFA:
  **15 scenario groups passed at 320, 390 and 1280 pixels**. Includes keyboard permission,
  delivery readback, lost queue/process responses, stale forms and corrected-contact
  prior-send review with no horizontal overflow. Five synthetic sends; zero real emails.
  The narrow review-state screenshot was visually inspected.
- Source diff and documentation reviewed by root; no independent reviewer was launched.
  Logs/screenshots are local `/private/tmp/at146-*`, not customer data or hosted evidence.

Intermediate failures are not counted as passes. The two initial baseline regressions
failed before implementation. The first expanded suite passed 41/44; three new assertions
incorrectly assumed lowercase permission text, immediate review instead of truthful
unconfirmed delivery, and 200 instead of the existing retryable 503 while call work is
pending. Those assertions were corrected against the actual contract; runtime gates
were not loosened. The 46-case focused run passed. The first full native run passed
636/637: an older staff test counted all operational documents as confirmations,
so the new history index made its expected total wrong. It now requires exactly
one confirmation, one matching index, one action and one receipt; all 13 staff
cases passed. Source review then replaced property-wide fallback document reads
with an exact-reservation scoped lookup and made discovery include delayed older
writes missing from an existing index. Both have new native coverage. Initial
typecheck caught union/null
narrowing in the new service, corrected before final verification.

## Limits and next actions

This synchronized contact write is PostgreSQL-only and limited to the original active
call. Legacy KV retains its existing call-contact capture. A returning caller cannot
modify an older reservation based on a shared phone number. A staff contact editor,
direct correspondence links and an explicit resend-after-dispatch flow remain open.
Older emails without a scheduling revision require review; no bulk migration or
historical deletion was performed. Source tool wording changes the source fingerprint;
a later controlled release must verify backend/tool/prompt alignment before publishing
Vapi. No latency improvement or real phone/inbox acceptance is claimed by these tests.

Owner to-dos:

- Finish the previously prepared free isolated Preview database form, store its password
  privately and confirm creation. No completion reply has been received.
- Provide verified property rules and representative permissioned leasing recordings.
- Set a bounded paid voice/audio/hosting trial budget and choose a licensed Black American
  or Latina female voice after auditions. Vast.ai remains an evaluation candidate.

Next Codex/Fable to-dos:

- Review this exact published source and its own cloud CI result; keep failed/unknown
  sends separate from actual delivery. Do not equate build readiness with hosted acceptance.
- Add a usable exact correspondence/review path and staff correction/resend authority,
  preserving reservation identity, explicit permission and uncertain-send recovery.
- Finish isolated hosted Preview activation after secure owner input; remove inherited
  live integrations for Preview only and preserve Production.
- Establish a fresh successful phone→tool→dashboard baseline, then compare voices and
  hosting separately using matching held-out cases, real audio and cost coverage.
- Keep the full leasing goal active and provide a reciprocal handoff at the end of the
  next session, including commits/deployments, actual checks, limits, owner actions
  and next-agent actions. Preserve unrelated canonical checkout changes.
