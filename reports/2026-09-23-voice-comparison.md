# September 23 — matched voice trials and CI race correction

Author/coordinator: Codex root. Base `01475420b94d7077304bda9e339652d0978cba97`;
branch `codex/at143-voice-comparison`. This report covers an offline evaluation
capability and a test correction. It does not claim a new voice, faster phone
responses, a Vast deployment, or production acceptance.

## Delivered

The [matched-trial comparison](../docs/voice-evaluation.md#compare-matched-trials)
checks baseline and candidate against the same dataset, case identities, workflows,
containment eligibility and declared measurement/provenance labels. It rejects
dropped or substituted cases rather than silently comparing different cohorts.
Array order can differ; comparisons use case identity without publishing those IDs.

The report preserves both full aggregates and paired outcome transitions. An
unchanged overall success rate can still contain a newly failed booking; that
regression is visible. Critical-category changes distinguish reviewed judgments
from unreviewed cases, which cannot establish a resolved failure. Failed and
unreviewed calls remain in the relevant denominators.

Latency deltas require recorded coverage for every matched case and turn for that
metric. Missing measurements remain unknown, and observed zeros remain zero.
Turn counts can differ and are reported explicitly. These are differences between
turn-weighted percentile distributions, not paired-turn effects or causal evidence.
Costs include failed cases and require complete reviewed coverage for deltas.
There is no automatic provider recommendation or release-pass flag.

The CLI reads bounded regular UTF-8 files and prints aggregate evidence only. It
refuses malformed/mismatched inputs, oversized files, final-component symlinks and
nonregular files; opening a named pipe cannot wait indefinitely for a writer.
Error messages reveal neither private values nor paths. It makes no network
requests, writes no files and requires no provider account or credits.

This prepares a consistent baseline/new-voice/Vast-model comparison. It does not
verify the truth of declared provenance, reviewer judgments, source permissions,
measurement boundaries, voice licensing or completeness of the recorded evidence.
Actual licensed Black American/Latina female voice auditions and hosting trials
remain separate, budgeted work.

## CI finding and correction

The prior branch's exact GitHub run `35883424595`, job `107257634502`, completed:
**1,741 application tests passed; 611 of 612 database tests passed; build skipped**.
It was inspected to completion rather than restarted while running.

The failing staff/voice email race test allowed only queued/accepted on a repeated
query. The existing service can legitimately verify delivery once its short
backoff has elapsed. Making the saved synthetic action immediately due reproduced
the same assertion failure locally. The test now deliberately reaches that boundary
and requires a delivered response, the same staff confirmation, persisted delivered
evidence, exactly one dispatch and verification, one action and one provider send.
No runtime behavior or production delivery guarantee was relaxed.

The first corrected focused run exposed the PostgreSQL bigint counter's string
representation in the new assertion. That assertion now normalizes the counter
before comparing it. These intermediate failures are recorded, not counted as passes.

## Verification

- New comparison/CLI regression tests: **22 passed**.
- `npm run check`: **1,763 passed**; typecheck and fixture validation passed.
- Complete native PostgreSQL suite: **612 passed**, including the corrected race;
  completed in 199 seconds.
- `npm run build`: **22 API handlers** imported and refused unconfigured requests
  in both runtime modes; site/dashboard generation passed.
- Scope/diff and local documentation-link review: passed. New cloud CI and
  independent review remain separate from these local results.

New tests cover reordered identities, changed/missing cases and eligibility,
changed provenance/methodology, unchanged net success hiding paired regressions,
critical failure transitions, missing timing/cost coverage, zero values, percentile
math, different turn counts, failed-call costs, empty trials, input privacy, CLI
argument validation, invalid UTF-8, oversized files and FIFO/symlink refusal.
No visual components changed; no new browser suite was needed. Native email
verification uses disposable PostgreSQL and a synthetic loopback provider.
Local logs are `/private/tmp/at143-*`; no real caller records are in the test inputs.

## Owner to-dos

1. Finish the previously prepared **Atrium Preview** project form in the Atrium
   Demo Free organization. Enter/save its password privately and reply “created.”
   This secure input remains pending; elapsed time does not complete it.
2. Set a bounded voice/hosting test budget, provide permissioned representative
   leasing examples, and choose the preferred licensed voice after hearing samples.
3. Supply verified property rules and confirm the workflows for the next demo/pilot.

## Codex/Fable next actions and reciprocal handoff

1. Review this exact published revision and its new cloud quality run. The older
   run above failed and must not be described as green. Do not equate publication
   or a Ready preview build with a working hosted portal.
2. Continue the isolated hosted preview setup after secure project creation. The
   earlier inspection found protected routes returning 503 and shared live KV/
   lead-webhook inheritance. Follow [the isolated procedure](../docs/hosted-preview.md)
   before enabling preview login; preserve Production settings.
3. Establish a successful current phone-to-tool-to-dashboard baseline. Freeze
   source cases, configuration and external tool/data versions, then compare voice
   and model changes separately using this command. Measure actual meaningful
   audio response and task completion, not dashboard estimates or filler speech.
4. Verify exact audition IDs, commercial rights and account access; obtain bounded
   paid-trial authorization before paid calls, generated audio or GPU rental. Keep
   the current published assistant and unrelated unsaved draft intact.
5. End the next session with a reciprocal handoff containing exact commits and
   deployments, actual checks and limitations, owner to-dos and next-agent to-dos.

No hosted resource, schema, assistant, voice, model, sender or production setting
changed in this task. Production was not rechecked here; dated earlier observations
are not current acceptance. AT-129 promotion remains separately pending after the
automatic approval rejection; this source publication is not a workaround. Preserve
the canonical checkout's unrelated dirty calendar work. The full leasing goal stays
active.
