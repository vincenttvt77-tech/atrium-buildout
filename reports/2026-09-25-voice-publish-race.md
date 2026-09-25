# Concurrent voice publishing correction — September 25, 2026

AT-161, Codex root. Branch `codex/at161-voice-publish-race`, based on published
`1f239b56b3c5cae3f19b88dac71b622e82b113de`. This fixes a confirmed managed-runtime
recovery error. It does not publish a Vapi assistant or change the live phone line.

## Failure and cause

[GitHub run 36150066764](https://github.com/vincenttvt77-tech/atrium-buildout/actions/runs/36150066764)
ended in failure: 1,838 application tests passed, 735 of 736 database tests passed,
and the build step was skipped. All three browser suites passed in the separate
browser job. The failed native case was simultaneous HTTP voice publication.
Earlier local results remain valid local evidence; they did not establish cloud
acceptance. Both original jobs are terminal and must not be polled or restarted
as if still running.

A controlled reproduction confirmed this sequence:

1. Request A reads the prepared release, then waits for its provider read.
2. Request B publishes that same review, records its one dispatch and verifies
   the saved provider result.
3. Request A resumes and sees the newly published provider configuration. It used
   its old prepared snapshot to interpret the update as outside drift, returning
   `409 voice_release_changed` despite the saved successful receipt.

The original atomic admission still prevented a duplicate PATCH. The defect was
the misleading error and recovery behavior. A late provider outage could similarly
hide a result already saved by the other request.

## Correction and preserved boundaries

When preflight fails, publication now revalidates the current actor and reloads
the exact reviewed release. If another request already dispatched or cancelled it,
the existing receipt is returned without another provider update. A still-prepared
review keeps its original refusal. The review hash must still match.

This does not convert provider errors into success: a saved unconfirmed state stays
unconfirmed. It does not bypass current permissions, property/binding checks,
expiry, real provider drift, backend compatibility or atomic dispatch. Verification
remains dated saved-state evidence; it is not proof that a phone call works or that
Vapi cannot be edited later by another administrator.

## Verification

- Before the fix, deterministic domain overlap tests failed for both verified and
  unconfirmed outcomes. The actual HTTP/PostgreSQL reproduction returned the same
  `409 voice_release_changed` error.
- An additional delayed-outage regression failed before extending recovery to that
  case. The final focused domain suite passed all **17 tests**.
- The final focused HTTP/PostgreSQL suite passed all **12 tests**, including both
  delayed-read cases, the original four-request race, one-PATCH assertions, foreign
  property/refused authority, channel revocation, audit rollback and lost replies.
- Final `npm run check`: **1,842 tests passed**, 99 suites, with zero failures,
  cancellations or skips; typecheck and fixture validation passed.
- Final `npm run test:database`: **738 tests passed**, with zero failures,
  cancellations or skips, including the deterministic overlaps and the original
  concurrent HTTP test.
- Final `npm run build`: passed, including import/refusal checks for **26 API
  handlers**. The dashboard assets were unchanged. No new local browser run was
  needed for this backend-only fix; exact-commit cloud/browser checks remain pending
  until the new branch is published and those jobs finish.

The deterministic tests coordinate requests with explicit gates instead of hoping
the runner produces a particular timing. The original concurrency assertion still
requires every request to return its saved result and exactly one provider write.
Failure diagnostics now print status, code and release state instead of dumping
the entire synthetic prompt/tool proposal.

All provider traffic in these tests is synthetic and intercepted or loopback-only.
No external phone, email, GPU or paid model request ran. Source changes are limited
to the managed release service, focused tests and this documentation. No schema,
provider credentials, deployment or production promotion changed.

## Reciprocal owner and next-agent handoff

Owner: finish isolated Preview project/private setup; provide a bounded funded
voice trial, approved pilot facts and representative permissioned calls. Choose
the Black American/Latina female voice after comparable listening samples.

Codex/Fable: verify the exact new commit and cloud run, retaining the failed parent
run as evidence. Then complete hosted account/property/booking/recovery acceptance
when configured. Keep the AT-129 production release gate intact. Do not describe
synthetic release tests as a live Vapi publication or a successful phone call.

The latest saved-library recheck still did not find Leoni; do not blindly repeat
its earlier import. Vapi still displayed $1.14. No voice audition or Vast.ai speedup
has been established. The old private Preview and public sample tabs were no longer
in the browser inventory; do not direct the owner to a tab assumed still open.

End the next session with a reciprocal handoff containing accessible commits,
actual deployments and checks, limitations, owner to-dos and next-agent to-dos.
The full leasing platform goal remains active.
