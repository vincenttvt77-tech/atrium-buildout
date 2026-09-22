# Voice evaluation baseline

Run `node scripts/evaluate-voice.mjs --input /private/path/reviewed-evaluation.json` with Node 22. This offline command reads one local file and prints aggregate JSON. It makes no network requests, phone calls, model calls or writes. Maximum input 10 MiB, 10,000 cases, 1,000 turns per case, 100,000 total turns. An invalid input exits 2 without echoing input values or its path. Exit 0 means a valid report was produced, not that an assistant is production-ready.

## Collect evidence before comparing providers

Use approximately 100 representative, permissioned leasing calls. Deidentify them and keep the mapping to source calls in restricted storage outside Git. Categorize actual intent and outcomes; include failures and human handoffs. Freeze the evaluation set before tuning. Keep development/synthetic cases separate from the held-out real-call cohort. Use one configuration fingerprint per report. Compare equivalent workflows, call conditions and test sets; do not compare provider lab estimates with live phone measurements.

Review factual answers against the approved property source and actions against persisted calendar/lead state. A spoken promise is not evidence of a successful booking or delivered message. Mark unknown outcomes unreviewed. Appropriate staff handoff can be successful task handling without being autonomous containment. Mark containment eligibility before evaluating results; do not remove failed calls from the denominator.

The evaluator validates structure, not permission, reviewer truthfulness, independence or representativeness. A declared held-out label cannot establish that cases were kept out of tuning. Retain reviewer identity, source references, timing methodology, selection dates and approved facts in restricted evidence alongside the dataset. The shared report contains only aggregates and fingerprints.

## Input contract

Exact top-level keys:

- `schemaVersion`: 1; `timingUnit`: `milliseconds` (no implicit conversion).
- `evidence`: `synthetic` or `real_call`; `split`: `development` or `held_out`.
- `measurement`: `audio_annotation` or `instrumentation`.
- `configurationSha256` and `datasetSha256`: 64 lowercase hexadecimal characters identifying the frozen configuration and deidentified source dataset. Hash the source dataset separately, not the self-referential evaluation envelope.
- `cases`: array of the records below. Unknown keys anywhere are refused.

Each case requires a unique pseudonym `case-1`, `case-2`, etc.; `workflow` from `known_unit`, `unit_search`, `property_question`, `book_tour`, `reschedule`, `cancel`, `handoff`; `outcome` from `success`, `failure`, `unreviewed`; boolean `eligibleForContainment`; `containment` from `contained`, `handoff`, `unreviewed`; `criticalFailures` array; and `turns` array. Optional `costUsd` is a nonnegative finite number or null. Absent costs remain unknown. Do not include transcripts, recording URLs, phone numbers, customer names, credentials or raw provider payloads.

Critical categories are `tenant_isolation`, `unauthorized_access`, `duplicate_action`, `false_confirmation`, `data_loss`. A case with a critical failure must have failure outcome. Ineligible cases cannot be labelled contained. A failed case labelled contained does not count as successful containment.

Each turn accepts these optional finite nonnegative millisecond values, each at most one hour. Missing/null values remain unknown; zero is a valid observed value.

| Field | Measurement boundary |
| --- | --- |
| responseMs | Caller end of speech to first meaningful audible response; filler must not stop this timer |
| endpointingMs | Speech end to committed end-of-turn detection |
| transcriberMs | Measured transcription component, using the documented boundary of the instrument |
| modelFirstTokenMs | Model request to first token |
| voiceFirstAudioMs | Speech-synthesis request to first audio |
| toolMs | Tool dispatch to completed result |
| networkMs | Instrumented transport interval with documented boundaries |

Use real turn samples. Do not repeat a call average as if it measured every turn. Do not infer timings from transcript length, call duration or price. Overlapping component timings are not added to create responseMs. Record exactly how tool/transport spans and multiple calls within a turn are handled so comparisons remain meaningful.

## Results and limitations

The report gives separate success rates for reviewed cases and all cases. Unreviewed cases remain in the all-case denominator. Containment uses all eligible cases; only successful cases marked contained count. Each workflow has its own counts.

P50/P95 use nearest-rank percentiles over observed turn values, not percentiles of call averages. Each metric includes sample count and missing count. No measurements yields null, never zero. Long calls contribute more turns; this is a turn-weighted distribution. It does not quantify confidence intervals or sampling bias.

Cost per successful case includes the costs of failed cases, and appears only when every case has cost and a reviewed outcome and at least one succeeds. It is not specifically cost per booking unless the cohort contains only booking tasks.

`observedTargetMet` means at least 95% success in this completely reviewed sample and no recorded critical failures. `realHeldOutEvidence` reports the declared labels independently. Neither establishes release acceptance: `productionReadiness` always remains `not_established`. The separate required security, concurrency, live channel, audio quality and delivery gates still apply. A tiny perfect sample is not credible evidence of 95% real-world success.

## Vapi integration boundary

Vapi exposes per-turn and average performance fields in call artifacts. Its public model-comparison total omits endpointing and transport. Current SDK type documentation explicitly gives milliseconds for transport averages but does not state units for every turn field. **No automatic Vapi conversion is implemented:** verify actual field units and measurement boundaries before mapping to this contract. In particular, provider turn latency is not automatically the time to the first meaningful response.

Sources checked September 22, 2026: [Vapi latency methodology](https://docs.vapi.ai/assistants/model-intelligence/understanding-latency), [performance metrics](https://raw.githubusercontent.com/VapiAI/server-sdk-typescript/main/src/api/types/PerformanceMetrics.ts), [turn latency schema](https://raw.githubusercontent.com/VapiAI/server-sdk-typescript/main/src/api/types/TurnLatency.ts). No saved assistant or provider settings changed. Live metric access was not established in this increment.
