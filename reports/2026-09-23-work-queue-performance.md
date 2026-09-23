# Work queue performance and access review — September23,2026

AT151, Codex root. Base `36e263b73de40bd8c3f2008c9861ca728057d70b`;
branch `codex/at151-work-queue-performance`, worktree `atrium-work-queue-performance`.
Full leasing goal remains active.

## Delivered

The Work queue's list query avoids property-wide repeated joins, and an additive
read-policy migration avoids repeating the same statement-stable property
permission check for every history row. Tenant equality, current sessions and
MFA, role checks, forced RLS, existing write guards, exact action identities,
precise paging and safe recovery revisions are preserved. No messages/calls are
sent and no dashboard controls or live provider settings changed.

The failure is concrete: the old query timed out at10sec with300 synthetic actions.
The correlated query alone returned26 rows in210ms. A3,000-action empty filter still
timed out with query-only changes, prompting the narrowly scoped policy migration.
With both changes, the same diagnostic returned a page in33ms and the empty filter
in410ms. These are local samples, not percentile, hosted or voice-latency claims.
The [technical report](../docs/workflow-query-performance.md) records remaining
history-scan limits and rollout requirements.

## Evidence and corrections

- Focused native checks:47/47 passed, including9 new scale/policy cases plus
  existing HTTP, workflow, authority-race and migration checks.
- The new regression was run with the original query before adding the migration:
  it failed with PostgreSQL57014 at the actual statement limit. Revised source was
  restored after the negative control.
- Real RLS and registered signed-MFA scope are used, with3,600 synthetic actions
  across three properties. Raw unscoped/mixed/foreign/invalid-context reads, pooled
  and prepared executions, membership/session/channel changes and migration row
  preservation are covered. Query-plan InitPlans execute once per statement.
- `npm run check`:1,795 passed; typecheck and fixture validation clean.
- `npm run build`:24 handlers imported and refused unconfigured requests in both
  runtime modes with network blocked by the verifier.
- Actual Chrome/HTTP/PG/MFA Work queue:9 acceptance groups passed, including
  keyboard paging, cancellation/requeue, stale/lost response recovery, preserved
  scrolling, mobile320/390/768/1280 and verified synthetic email results. Three
  transient resize overflows cleared after two animation frames; zero settled
  overflow. No real provider execution. Source UI unchanged.
- Full native result is recorded in the final checkpoint below. Root source
  review; no independent reviewer was launched.

Initial diagnostic setup omitted required property JSON fields and was corrected.
The first expanded focused run36/37 failed an invalid synthetic channel status
(`revoked` rather than the schema's `inactive`); the final47 passed. The browser's
old banner expectation predated callback support; its exact assertion was updated
to the already shipped text, then the complete suite passed. No business assertion,
RLS check or deadline was removed to pass tests.

Supabase CLI2.117.0 generated the new migration filename. Current official RLS
guidance and changelog were reviewed. The CLI initially needed sandbox permission
for its own telemetry preference file; help and local generation then succeeded.
The database advisor was attempted on the standalone fixture but reported missing
platform `anon` role. It did not validate the hosted Supabase project. Runtime
security/authority checks were verified directly through the native suites.

The base AT150 GitHub run35911654015/job107352709658 is terminal SUCCESS across
application/native/build checks. The earlier AT149 run failed one work-item test;
this investigation found a plausible related bottleneck but does not prove that
historical failure's root cause. Do not conflate these results or rerun terminal
jobs as if they were pending. Current-branch publication/CI is separate.

## Owner and next-agent actions

Owner: complete secure isolated Preview provisioning, supply approved property
facts and permissioned representative calls, choose voice/accent/language after
samples, and set a bounded audio/hosting trial budget. Keep credentials private.

Codex/Fable: verify this branch's exact cloud run, obtain independent review of the
policy equivalence and query projections, apply the additive migration only through
the reviewed hosted maintenance process, then verify managed Preview and real
phone/tool/dashboard behavior. Continue remaining leasing notifications/recovery
and larger-history indexing. Establish a successful real phone baseline before
comparing Vast hosting and licensed female voice candidates independently.

No hosted migration, production promotion, live Vapi change, paid call/audio/GPU,
real email or AT129 approval bypass occurred. AT129 remains a separate boundary.
End the next session with a reciprocal handoff containing exact commits/deployments,
actual checks, limitations, owner to-dos and next-agent to-dos. Local source tests
do not complete the pilot or full leasing goal.

## Final local checkpoint — 2026-09-23T20:17:52+00:00

Complete native suite: **680/680 passed**,262seconds. All1,795 application checks,24-handler build and9 actual desktop/mobile browser groups passed. All test processes are terminal. Narrow/desktop screenshots inspected; local documentation links and diff checked. Scope is ready for source publication; current-branch cloud and managed hosted verification remain pending.
