# Staff tour contacts and exact email review — September 23, 2026

AT149, Codex root. Base `d234b9251019d782bf8ec7e2d34f3ded0c73a55a`;
branch `codex/at149-staff-tour-contact`. The full leasing goal remains active.

A saved reservation could display its lead profile's older email instead of the
corrected tour email. Staff also lacked a safe tour-contact editor and a direct
way to open the exact earlier confirmation when a corrected address was blocked
by duplicate-send protection.

## Delivered in source

- Calendar → saved tour → **Edit tour contact** corrects the name/email, including
  clearing a wrong address, with a required reason and paged history. Calendar and
  Today use the actual reservation's contact. Original caller/call/lead identity,
  time, apartment, occupancy and scheduling revision stay intact.
- Staff contact revisions and protection prevent AI from overwriting a reviewed
  contact. Later volunteered call details can still be retained for staff review.
- Calendar, history, command receipt and audit commit atomically. Stale snapshots,
  uncertain retries, simultaneous edits, current permissions and property scope
  are enforced on the server. A lost reply retries the same command; it cannot
  silently create another correction or overwrite a newer one.
- The confirmation panel exposes the earlier email's original recipient/status
  and opens its exact saved action, even outside queue filters/first-page results.
  It works after clearing the current email. Missing/mismatched action references
  cannot select another row. A contact change sends nothing and grants no consent.
- An authorized manager can cancel an earlier unsent queued email, then separately
  review the corrected draft and record fresh permission. Sent/uncertain messages
  retain existing duplicate protection; no new resend-after-dispatch authority.
- Responsive form, keyboard operation, scoped request registration, developer
  routing, generated dashboard and deploy-bundle checks included. Uses the current
  PostgreSQL calendar/document storage; no SQL migration added.

## Verification

| Check | Actual result |
| --- | --- |
| Old-source contact-display regression | Failed as expected: 18/19 pass; lead email incorrectly replaced the reservation email. |
| `npm run check`, Node22 | 1,795 tests passed; typecheck and fixture validation passed. |
| Full native database suite, concurrency2 | 652/652 passed in 255 seconds against disposable PostgreSQL. |
| Focused contact, confirmation, voice and work-queue HTTP suites | 80/80 passed before the final session-revocation case; full suite includes that additional case. |
| `npm run build` | Passed; all23 API handlers imported and refused unconfigured requests in both runtime modes. |
| Updated property-scope suite | 48/48 passed, including immutable scope headers on the new contact and exact-action requests. |
| Actual Chromium, HTTP handlers, PostgreSQL and signed synthetic MFA | 27 acceptance groups passed at320/390/1280px. Six synthetic provider sends; zero real emails or paid calls. |
| Source/diff review | Root reviewed scope, locking, authority, retry/history validation and source/generated consistency; no independent reviewer. `git diff --check` passed. |

Native cases cover exact replay after lost HTTP acknowledgement and after a later
edit/deleted tour; concurrent competing commands; foreign tenants/roles/sessions;
stale configurations/tours; strict input/CSRF; pending/ambiguous/past bookings;
corrupt history/receipts; paginated history; AI staff-marker refusal; and receipt
or audit failure rolling back calendar/history/audit together. The transaction's
locked calendar reader cannot be used after its owning transaction ends.

Browser cases include desktop/mobile keyboard saves, original schedule/caller
preservation, existing permission/delivery flow, original recipient review,
completed-action navigation, exact action beyond25 newer rows, safe queued-email
cancellation and newly permissioned replacement, lost replies, stale/cleared
contacts, missing action IDs, navigation during an in-flight read and a mismatched
property response retiring the form and cached workspace. Narrow and desktop
screenshots were visually inspected. Local evidence is under `/private/tmp/at149-*`.

Initial test issues were corrected openly: loopback required the normal isolated
test escalation; a new fixture expected the wrong seeded staff ID; the first app
run used stale generated output and an old lead-email-authority assertion; browser
fixtures initially expected a closed disclosure to be visible, clicked before all
workspace resources loaded, read before an async reload finished, and expected a
queue-wide cancellation label on an email-specific display. Final runs passed
without removing authorization, recovery, atomicity or delivery assertions.

The preceding AT148 GitHub run35902276001/job107321192684 is now terminal SUCCESS
(application, database and build). Its old cloud failure is resolved. AT149's own
publication/CI are separate checks; see the current task status and reciprocal
handoff for the exact published commit/run.

## Limits and next actions

This is accepted local managed-workspace behavior, not a production activation or
a phone acceptance result. No hosted database was changed, no migration ran, no
Vapi assistant/draft was edited, and no production promotion or provider purchase
occurred. Preserve the separately pending AT129 promotion decision. The current
hosted legacy workspace cannot expose this PostgreSQL-only editor.

Owner: finish the isolated Preview database setup privately; provide approved
property rules and permissioned call examples; choose voice/accent/language from
listening samples and define a bounded paid voice/hosting test budget. Vast.ai
and licensed Black American/Latina female voice candidates remain evaluations,
not selected production replacements or measured speed improvements.

Next Codex/Fable: verify this commit's cloud run and preserve exact handles while
running; activate and accept an isolated hosted managed workspace once its secure
inputs are available; verify actual phone-to-tool-to-dashboard behavior before
production promotion. Continue independent leasing work, especially reliable
permissioned follow-up and cancellation flows with staff recovery. Resolve voice
IDs/rights/access, establish a successful measured baseline, then compare model
hosting and voice independently. Do not claim the full leasing goal is complete.
Leave a reciprocal handoff with source/deployment IDs, actual checks/limitations,
owner to-dos and next-agent to-dos.
