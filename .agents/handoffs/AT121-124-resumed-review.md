# AT121–124 resumed independent source review

Reviewer: Codex booking_review_security (AT-124). Coordination remains atrium-buildout; implementation reviewed in ../atrium-booking-resolution.

## Scope and outcome

Branch codex/at121-booking-resolution, HEAD/base 06eb3f4eba3e8628312cdb355246a77a4a523ff8. Reviewed uncommitted domain, calendar adapter/reschedule fence, call-review documents, lifecycle/claim/completion orchestration, calendar/Vapi boundaries, shared portal helper/derivations and Calls cards, plus their focused tests. No application source, providers, deployment, commit or task board was modified by this reviewer.

No unresolved confirmed defect was found in the reviewed local source. Source review accepted after independently passing the final concurrent two-operator projection/reschedule test. Full/native/browser release verification remains root-owned. This is not production acceptance and does not verify voice/audio or hosted behavior.

## Review corrections incorporated

- The original permanent external-key fence would also prevent an independent later call from booking the same phone/slot after an absent result. Revised implementation permanently fences the original call, while fencing that key only during unfinished projection.
- A calendar fence alone does not stop the original webhook from winning call completion and starting projection between the calendar observation and staff lifecycle update. The new durable call claim precedes the calendar decision and is checked inside both webhook completion and the projection's atomic freeze/update. An original completion that wins first makes staff review refuse before writing a fence.
- Completed calendar receipts are immutable checked-at history. Lost final acknowledgement/review closure is repaired without replaying the old profile over a later reschedule or independent same-key booking.
- The first shared-story draft failed to match a general tour whose raw tool omitted unitId against the persisted null unit. The author corrected only raw-tool normalization and added the regression, retaining strict stored DTO checks.
- Absence wording now says no matching reservation was found when checked, rather than claiming the attempt never created one historically. The permanent original-call fence prevents a later original create.

## Inspected invariants

Current operator authorization and selected property are checked by API; body actor/attempt/outcome fields cannot define authority or evidence. PostgreSQL uses its calendar/document transaction; standalone requests require the frozen tenant header. Original call routing, configuration and timezone remain evidence rather than being replaced with the current operator/channel settings.

Original end/key/time interval/unit and tool identity must be persisted before dispatch. Active calls, other admitted work, stale revisions, missing historical evidence, moved/duplicate/mismatched bookings and foreign scope fail closed. Staff resolution calls no booking-create or notification provider. Projection retains caller identity separately from requested callback and preserves independent emergency/tour-change records and holds.

Unknown/lost acknowledgements retain durable claim/receipt and permit another currently authorized operator to finish the original claim without age-based unlock. UI validates exact call/revision/attempt, preserves canonical retry identity, retires private data after scope/auth/timezone change and distinguishes pending from completed checked-at evidence. A resolved booking does not remove unrelated call errors or staff requests.

## Independent checks actually run

Using /private/tmp/node-v22.23.2-darwin-arm64/bin/node from implementation worktree:

- --test src/calendar/test/review-resolution.test.ts src/calls/test/booking-review.test.ts — 29/29 passed (domain/document and real KV CAS ordering).
- --test api/test/vapi-booking-recovery.test.ts src/calls/test/lifecycle.test.ts src/leads/test/inbox.test.ts — 33/33 passed after completion extraction.
- --test src/calls/test/reconcile-booking.test.ts test/portal/review-resolution-shared.test.mjs test/portal/review-resolution.test.mjs test/portal/booking-review.test.mjs — 61/61 passed (19 orchestration, 21 shared helper, 12 Calls cards, 9 existing review UI).
- --test api/test/booking-review-resolution.test.ts — 7/7 passed, including actual delayed original webhook create, end report, staff absence resolution and rejected late original creation/completion.
- --test src/calls/test/reconcile-booking.test.ts — final 20/20 passed, including two concurrent staff resumptions: one projection resumes after the other releases the fence and a complete staff reschedule updates calendar/lead/follow-ups. The stale projection leaves the moved calendar, lead and every follow-up unchanged.
- git diff --check — clean.

Earlier repeated focused runs are not added again to a cumulative test count.

## Limits and next owner

Root must run complete application/type/build and native PostgreSQL transaction/authorization suites, then browser/mobile acceptance after the demo freeze window. PostgreSQL new tests were source-inspected, not independently executed by this reviewer. Browser interaction, generated assets and live phone/provider outcomes were not verified here. The production freeze remains unchanged.

AT124 source review is complete. Root to reconcile any remaining full-gate/native/browser failures before release acceptance/publication. A future handoff must preserve these limits and identify local versus published code separately.

Final reviewer checkpoint (UTC): 2026-09-21T12:20:43.918596+00:00

## Narrow final re-review

Root requested a fresh read after the final defensive completion-state checks and two orchestration regressions landed. Inspected current completion.ts/reconcile-booking.ts and the two new tests. CompletedAt must agree with lifecycle completion and the recorded end; non-string call IDs are rejected before projection. This preserves the established valid completion transition and refuses inconsistent saved state.

Independently reran --test src/calls/test/reconcile-booking.test.ts: **22/22 passed**. The added cases cover a failed claim before any fence, interrupted follow-up projection safely resumed, and an original booking write winning after the staff claim but before calendar observation. git diff --check remained clean. No new actionable issue found; local source acceptance remains in place. No broader suite, browser or provider action was performed for this narrow re-review.

Narrow re-review timestamp (UTC): 2026-09-21T12:22:20.613387+00:00

## Final UI follow-up review

Reviewed restoreBookingReviewFocus and the combined in-flight service/review session-retirement warning. The focus fallback runs only after successful completion when focus was lost to body, selects a visible heading (including mobile call detail), avoids open dialogs and retired documents, and does not replace an existing focused control. Both concurrent uncertain saves remain described in the 401 retirement message.

Independently reran --test test/portal/review-resolution-shared.test.mjs: **24/24 passed**, including mobile focus fallback/no focus theft, both in-flight warning prefixes, and claim-only pending recovery. git diff --check was clean. No actionable issue found in these narrow changes. Actual Chromium acceptance remains root-owned and was not claimed from the VM focus test.

UI follow-up timestamp (UTC): 2026-09-21T12:33:12.853616+00:00
