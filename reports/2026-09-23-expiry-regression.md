# Cloud expiry regression repair — September 23, 2026

AT148, Codex root. Base b9c487eeb413ee25f489b743bdf484e229a43e0a;
branch codex/at148-expiry-regression. The full leasing goal remains active.

The previous application cloud check failed before an expiry-race test reached
its intended database wait. The source evidence lasted only2.5 seconds, including
real publication, HTTP and passkey preparation. A deliberate3-second setup delay
reproduced the same null requestVersion failure locally. The application correctly
refused the already-expired request; this was a defective test setup.

## Change and evidence

The repaired native test gives setup a60-second source lifetime and its neighboring
ceremony race a30-second lifetime. A fixture-only authenticated executor permits
bounded longer lock/statement waits for these two commands. Production defaults,
roles, session checks, signatures, SQL functions and clock reads remain unchanged.
The test observes the specific blocking backend and, for final receipt insertion,
the actual RowExclusiveLock on the receipt table. It requires the barrier to be
reached before expiry, then verifies actual database-clock expiry before release.

Rollback checks now cover the decision, command receipt, ceremony consumption and
passkey counter revision. A clear setup assertion replaces the accidental null
dereference. No retries or skipped assertions turn an early failure into a pass.

Validation:

- Original slow-setup reproduction failed as expected, matching the cloud error.
- Repaired native race suite:7/7 passed, including the deliberate slow setup.
- Negative control: removed only the final expiry guard inside a separate disposable
  database. The operation incorrectly fulfilled and persisted one decision, one
  receipt, one counter revision and one consumed ceremony; the repaired assertion
  failed as expected. No application source or live database was altered by this
  control. An initial control exposed the same wrongful fulfillment through an
  undefined-error assertion; the repeat recorded explicit aggregate effects.
- Application types/data/tests:1,794 passed. Production build:22 handlers passed.
- Complete native PostgreSQL suite:639/639 passed in264 seconds, including the final repaired race assertions.
- Diff reviewed. No browser run: this change does not alter UI or runtime behavior.

Logs are local `/private/tmp/at148-baseline.log`, `at148-focused.log`,
`at148-mutation-final.log`, `at148-check.log`, `at148-build.log` and
`at148-database.log`. The longer real-clock tests deliberately cost more time in
exchange for setup headroom on busy runners. They retain bounded failure deadlines.

## Release and reciprocal handoff

Prior [cloud run35898609572](https://github.com/vincenttvt77-tech/atrium-buildout/actions/runs/35898609572)
is terminal failure (1,794 app passed,638/639 database passed, build skipped).
Do not rerun or keep polling that historical job. A new published commit and its
own cloud result are required; local success alone is not cloud or hosted acceptance.

No live provider, message, call, voice, assistant draft, migration or deployment
changed. AT129 promotion authorization remains separate. This repair adds no new
customer feature and does not complete the leasing goal.

Owner to-dos: complete the isolated Preview setup privately; supply approved
property facts and permissioned call samples; choose voice/accent preference after
auditions and set a bounded budget before paid trials. No credentials in chat.

Next Codex/Fable: verify the repair's published commit and cloud check, then resume
staff tour-contact editing and exact saved-confirmation review navigation. Preserve
original reservation/caller identity and require fresh permission for changed email;
do not resend an uncertain prior action. Continue isolated Preview and actual phone
baseline once owner inputs are ready. End with a reciprocal handoff containing
accessible commits/deployments, actual checks, limitations and both parties' to-dos.
