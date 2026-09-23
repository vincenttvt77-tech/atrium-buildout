# Post-call email verification — AT-138

A submitted apartment-shortlist or tour email can now be checked after the call ends. Staff get **Check email delivery** in the managed Work queue. A separate authenticated, property-scoped endpoint can perform bounded scheduled checks when deliberately configured. Both paths observe an existing submission and cannot send a first or replacement email.

This is implemented on `codex/at138-email-reconciliation`, based on `586e6370d6ef22303b08b9909520ba219636e11b`. It is feature-branch work, not activation in the hosted demo. Publishing code does not configure a sender, schedule, managed database or Vapi release.

## Completed

- Database claims constrain verification atomically, preserve the displayed revision under lock, skip active leases and recover expired ones. A verification-only worker cannot schedule another write even when a connector reports authoritative absence.
- Each scheduler invocation selects at most five oldest due email actions in one registered property. First sends, other connectors, future retries, other properties, completed work and review holds remain outside selection. Overlapping invocations share durable leases.
- Scheduler authentication precedes runtime construction and property lookup. A registered `email-reconciler` channel and expiring published property opt-in are both required. Existing original actor/configuration checks remain in place before and after provider IO.
- Staff checks require `operate`, same-origin JSON, frozen property/configuration headers and the displayed action revision. Queue recovery remains a separate administrator action. Responses omit recipient, message content, provider reference and credentials.
- Dashboard states distinguish not sent, accepted, unknown submission, delivered and review needed. Email checks have keyboard controls and narrow-screen layouts. Lost/malformed responses require saved-state reload and do not cause a blind repeat. “Delivered” does not claim a human read the message.
- Setup, limitations and activation guidance are in [email delivery](../docs/email-delivery.md); proposed architecture is in [ADR0015](../docs/adr/0015-email-reconciliation.md).

## Checks

Validation used Node 22 and synthetic data only. All final local checks below passed.

| Check | Actual result |
| --- | --- |
| `npm run check` | 1,715 tests passed, 0 failed; typecheck and fixture validation passed on the final application changes. |
| `node --test --test-concurrency=2 'test/database/*.test.mjs'` | Final uninterrupted run: 556 passed, 0 failed, about 182 seconds, including 19 new reconciliation cases. |
| `npm run build` | Passed; all 19 API handlers import and refuse unconfigured legacy/managed requests correctly. |
| `node test/browser/workflow-queue.mjs` | Final 9 scenario groups passed with actual local handlers/database and an injected synthetic provider; two email readbacks, zero sends. |
| Scoped portal suite | 21 passed after final display changes. |
| Diff and documentation links | Clean whitespace check; local relative links resolve. |

Browser checks cover keyboard use, page continuation, inner-list scroll retention, 320/390/768/1280px layouts, property state, cancellation/requeue safeguards and lost browser replies. Repeated email-card resizing measured three intermediate viewport overflows; all disappeared after two paint frames, with zero painted-layout overflow. Screenshots were visually reviewed. The `agent-browser` CLI was unavailable; the repository's Chromium/Playwright acceptance harness provided verification instead.

Corrections during development: strict test-fixture typing, an outdated banner expectation, generated-page rebuild ordering, the missing shared endpoint scope registration, unavailable-sender batch starvation, and long status badges at 320px. One copy-cleanup follow-up exposed intermediate resize measurements; the final browser test waits two paint frames before judging layout and retains diagnostics. Earlier browser load checks timed out while other heavy tests/pause conditions were present; the final check ran alone with a timeout longer than the UI's own 15-second request bound.

Two earlier full database attempts recorded 531/556 and 553/556 passes. Their failures coincided with hundreds of seconds of elapsed pauses, expiring MFA proofs, leases and session deadlines. They were not counted as passes. The final isolated run prevented idle sleep for its duration and passed all 556 without relaxing any production deadline or authorization rule. Automatic approval-review timeouts were retried once where explicitly allowed. No independent reviewer or cloud CI result is claimed.

## Live boundary and remaining limits

No real email, paid call/simulation, voice/model change, GPU provision, Vapi draft/publication, provider secret/domain, cron installation, hosted migration or production promotion occurred in this task. AT-129's separate promotion decision remains pending after automatic review rejection. No deployment path was used to bypass it. No new database migration is required for this increment.

This is provider readback, not complete delivery-event history. An opened/clicked latest event does not prove a prior delivery event to this implementation. A missing provider UUID cannot be automatically recovered. Revoked original authority or a new property configuration may hold older actions. First-send dispatch remains explicit; this runner cannot repair or resubmit a message. No phone-to-inbox acceptance or current voice latency improvement is claimed. Work queue history is not yet a call/prospect correspondence timeline. Scheduler provisioning, portfolio orchestration, lag alerts, and controlled live provider normalization/inbox checks remain work.

Vast.ai and the requested Black American/Latina female voice remain measured trial candidates from AT-134/136; this email change does not switch the live assistant or establish lower latency.

## Owner to-dos

1. Supply an approved sending identity/domain and test recipient when controlled email activation is prepared; enter provider credentials directly into the deployment secret store.
2. Resolve the separately pending production promotion decision and coordinate managed-runtime activation. No extra environment file is needed for ordinary staff login.
3. Fund phone credit and a bounded voice/hosting comparison when ready; choose the preferred voice after auditions. Provide permissioned representative calls and verified property facts for evaluation.

## Codex / Fable next

1. Review and integrate this branch; retain tenant and no-resend guards. Publish exact accessible commits with actual checks.
2. Prepare scoped worker provisioning, deployment readiness, monitoring/lag signals and a funded/reviewed schedule. Verify the exact compatible backend and Vapi tool contract before activation.
3. Run a permissioned phone-to-tool-to-email-to-dashboard test against an approved property; retain evidence of actual inbox delivery. Add authenticated delivery-event history and call/tour links.
4. Continue the separate licensed voice/Vast comparison and representative held-out evaluation. Do not substitute local synthetic test counts for phone success, latency or inbox evidence.
5. Finish each session with a reciprocal handoff: exact commits/deployments, changes, actual checks, unresolved risks, owner to-dos and next-agent to-dos, and request the same handoff from the following agent.
