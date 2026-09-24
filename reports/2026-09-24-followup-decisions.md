# Reliable staff follow-up decisions — September 24, 2026

AT154, Codex root. Branch `codex/at154-followup-decisions`, base
`66e011495acfd77bf85bebee21d2dfd643ac74e6`. Source is published for cloud verification;
final acceptance is pending. This is not a production rollout or a voice change.

## Changed behavior

Staff review a follow-up before marking it handled, not needed or open again.
The task retains the staff actor, time and decision history. A checked atomic write
rejects stale context and stale Undo commands. Repeating an uncertain saved command
returns its original acknowledgement and the current task without overwriting a
newer staff decision. Missing tasks cannot be recreated, and retired tour reminders
cannot be reopened. No call, message or attendance claim follows from a staff status.

The browser offers recovery after a lost response or 15-second timeout, retires
forms on navigation and respects current session/property access. Completed tasks
remain recoverable even before their due date. The list shows honest counts and a
Show more control beyond 20 items. All staff POST actions on the leads endpoint now
require same-origin JSON; native testing reproduced the missing origin protection.

No database migration or application dependency is added. See the
[contract and rollback limits](../docs/followup-decisions.md). The previous unchecked
status writer is not a safe rollback after staff begin using this history.

## Actual local evidence and unresolved checks

- Seven new domain cases cover exact retries, stale decisions, new source context,
  changed actor/payload, retired/deleted records, malformed history and the retained
  100-decision limit. Nine new native HTTP/PostgreSQL cases cover concurrent writers,
  actual dropped replies, roles/scopes/current configuration, atomic audit failure
  and all six staff action types refusing foreign or missing browser origins.
- An earlier focused eight-case native run passed; the final broader run also passed
  all nine new follow-up cases. Existing native note/feedback fixtures omitted Origin;
  corrected those request fixtures while preserving their isolation/audit assertions.
- Earlier application verification passed 1,813 cases. After the last added portal
  case, the seven-case focused portal suite passed. The final full application run
  passed 1,812 of 1,814, failing two unrelated subprocess timeout checks after roughly
  513 seconds each. It is NOT counted as full final acceptance.
- The last full native run passed 722 of 726, with three failures and one cancelled
  timeout. Open cases: unavailable email sender reconciliation, vendor-review expiry,
  administration proof expiry and resident-consent expiry while waiting on a receipt.
  The earlier readback-origin expiry case passed this run. Do not dismiss remaining
  failures as environmental until they pass uninterrupted verification.
- The final build log completed its 26-handler API import/refusal smoke checks and
  dashboard generation. The cloud build must still verify the published commit.
- Real local Chrome exercised completion/reopening at 320/390/1280 pixels, actor/history,
  keyboard, future-due completion, stale Undo, changed task context and lost-response
  recovery. The latest run failed waiting for the real 15-second timeout UI; route
  retirement consequently did not run. Full browser acceptance remains pending.
  Screenshots show readable mobile/desktop forms; inspected failure captures retained
  the saving state. A previous test click was intercepted by the success toast; the
  test now dismisses it using its real close button, without forcing the covered click.

The Mac repeatedly slept during testing; power logs confirm system sleep, and test
runs contain multi-minute pauses. One earlier stalled disposable database process
group was explicitly stopped; all replacement local test handles are terminal.
No expiry guard, lease limit or test expectation was weakened to obtain a pass.
Raw failing logs remain locally under `/private/tmp/at154-*` and are not committed.

The quality workflow now runs the follow-up browser suite on an isolated GitHub
runner with pinned Playwright 1.62.1, temporary test tooling, synthetic data and no
live provider requests. Screenshots are retained seven days. Existing application,
native database and build checks remain required. This follows the documented
[Playwright CI installation flow](https://playwright.dev/docs/ci); it does not require
a paid call, cloud database or GPU. Exact cloud run/results will be recorded after
publication, including any actual defects it exposes.

## Owner to-dos

Complete the secure isolated Preview setup and supply approved property rules and
permissioned representative leasing calls. For the requested Black American or
Latina female voice, choose after listening and provide a bounded audio/hosting trial
budget. Enter credentials only in secure provider setup. The existing
[voice audition kit](../docs/voice-audition-kit.md) and
[Vast comparison plan](../docs/voice-provider-evaluation.md) remain the voice direction;
no new voice, generated sample, GPU rental or measured latency gain is claimed.

## Next Codex/Fable to-dos and reciprocal handoff

Verify the exact published commit's application/database/build and browser jobs.
Resolve reproduced failures, independently review the decision/receipt/CSRF boundary,
and check mobile recovery and completed-list navigation. Keep cloud source evidence
separate from managed Preview and actual phone/inbox acceptance. No hosted migration,
production promotion, Vapi edit/publication or AT129 approval workaround occurred.
Preserve unrelated canonical calendar changes. The full leasing goal is active.

Then establish a fresh successful phone baseline, verify candidate voice IDs and
rights, audition the same script and compare voice-only versus Vast-hosting-only
changes before combining them. Hosting compatibility does not establish lower
caller-perceived latency or correct streamed tool calls.

The next agent must end with a reciprocal handoff: accessible commits, deployments,
actual checks/failures, evidence limits, unfinished ownership, owner to-dos and
next-agent to-dos. Publish that handoff with the code for GitHub-only reviewers.
