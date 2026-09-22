# September 21 booking review recovery — local implementation

Status: independently reviewed and locally verified; not published or deployed. This report is about
local source, not the deployed investor demo. Do not deploy unfinished work from the
original checkout.

## Customer outcome

Today and Calls now offer a permission-controlled reservation check for an uncertain
booking after its call ends. The check uses the original saved attempt and Atrium's
calendar, records what staff verified and when, and repairs the prospect/follow-up
records. It never makes another booking or sends a notification. Unknown saves remain
retryable; completed results are dated history, not a promise that a reservation can
never subsequently change.

A delayed request from the original call cannot create a booking after staff resolve
it. Another operator can finish interrupted record updates. While those updates are
pending, the matching reservation cannot be manually rescheduled. Once absence is
fully recorded, a new independent call may request the same person/time again.

## Implementation and limits

- Exact attempt interval, unit, booking key and tool identity are saved before dispatch.
- A durable call claim precedes the calendar observation, preventing a race with the
  original webhook completing the same work.
- PostgreSQL uses one authorized property transaction. Legacy KV retains durable
  claim/calendar/document evidence for explicit retry across partial writes.
- Current staff access controls the operation; original call provenance controls its
  historical property, connection, configuration and timezone record.
- Only one unsettled matching booking intent is recoverable. A live call, other
  unsettled work, missing old evidence, mismatched reservation or moved reservation
  refuses automatic resolution and needs inspection.
- Existing emergency and tour-change concerns remain separate and visible.
- This is staff-triggered standalone-calendar recovery, not a PMS integration or a
  background queue. Calendar review receipts currently have a bounded history limit.

## Verification

- `npm run check`: **1,624 passed, 0 failed**, with typecheck and data validation clean.
- `node --test --test-concurrency=2 'test/database/*.test.mjs'`: **498 passed,
  0 failed** in 179.21 seconds against disposable local PostgreSQL. This includes the
  previously failing resident-service race fixture and the new staff-recovery HTTP
  test. The earlier 496/497 result remains historical evidence; this pass does not
  prove its original setup-failure cause. No runtime timeout/security workaround was made.
- The focused real-PostgreSQL Vapi HTTP suite passed 25/25, including staff role/property
  boundaries and rollback of calendar, call, lead and review when projection fails.
- `npm run build`: **17 API handlers** bundled and smoke-checked in both runtime modes.
- Actual synthetic Chromium: **24 checks passed** at 320, 390 and 1280 pixels; no unexpected
  browser/network errors or document overflow. Root visually inspected the 320px retry
  dialog, 390px confirmation and 1280px absence layouts. Browser testing found and verified
  a fix for lost mobile keyboard focus after completing a review.
- Final generated HTML SHA256:
  `4d14a16b660f4cc0dccf120e15702958d0f213e821644d78b7f18312e73911db`.
- Independent source review accepted the final orchestration 22/22 and shared UI 24/24
  checks. These overlap the application suite and are not additional total tests.
- Seven staff-review handler tests cover authorization and a real local webhook held
  between dispatch and calendar mutation, call-end reporting, staff verification of
  absence, and refusal of the original late create/completion.

Logs are `/private/tmp/atrium-at121-{check-final,database,pg-http,build-final}.log`.
Browser screenshots/results are in the outer workspace's
`reports/investor-demo-2026-09-21/booking-review-browser/`. The runner is committed at
`test/browser/booking-review-resolution.mjs`. Initial sandboxed native startup was
refused permission to bind localhost; the authorized isolated rerun above passed.

No phone call, paid simulation, Vapi edit, push or deployment occurred for this slice.
The last verified production application is `5ef64688ddc687fd24d393f91f4b84b15b77078c`,
with durable legacy KV. Read-only production preflights at 7:59am and 8:31am Eastern each passed eight
assertions. Those do not prove fresh phone audio, current deployment commit identity
or a live booking write. The temporary demo monitor was restored to the original
daily 6pm Eastern EOD audit at 8:30am.

## Owner/team to-dos

1. Top up Vapi before relying on the demonstration phone line. The owner said they
   would do this; the top-up has not been independently verified.
2. Complete one fresh real-phone rehearsal and inspect its dashboard result. A new
   phone test remains unverified.

## Codex next actions

1. Publish the reviewed local release through a separate deployment step after the
   presentation freeze is closed, then verify the exact deployed commit and authenticated
   property workflow. The current live demo was deliberately preserved.
2. Verify a fresh real phone-to-backend rehearsal after credit is available. Read-only
   health and synthetic call tests cannot establish audio latency or provider delivery.
3. Continue the managed PostgreSQL rollout, customer onboarding, resident-service
   completion and connector roadmap. No PMS has been selected; none was enabled here.
4. Keep daily EOD reports and reciprocal handoffs current, distinguishing local,
   published and deployed work. Preserve the older paused files in the original
   checkout until their replacement is integrated explicitly.

## Handoff to Claude Fable 5

Implementation checkout:
`/Users/evanmavashev/Documents/ChatGPT/Atrium/atrium-booking-resolution`.
Branch: `codex/at121-booking-resolution`; base `06eb3f4eba3e8628312cdb355246a77a4a523ff8`.
Coordination checkout remains `atrium-buildout`; consult its board and AT121–124
status files before editing. The original checkout retains older unfinished calendar
files intentionally; these are not the implementation to publish. Root owns API,
generated files, docs and release checks; AT122 owns calendar/call orchestration;
AT123 owns app/Calls UI and its tests; AT124 reviews independently. This reviewed slice
has not been pushed and local paths are unavailable to a GitHub-only agent until publication.

Do not infer deployed behavior from this branch or from test counts. Preserve the
investor demo and explicit unverified voice boundaries. At the end of your session,
write a return handoff for Codex with the same distinctions: changed paths and commit,
actual tests/results, deployed state, unfinished work, owner actions and next actions.
