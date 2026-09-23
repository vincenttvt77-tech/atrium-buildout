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

## Compare matched trials

Use Node 22 on macOS or Linux with two evaluation files following the contract above, kept outside Git:

```sh
node scripts/compare-voice.mjs --baseline /private/path/baseline.json --candidate /private/path/candidate.json
```

The command refuses different dataset fingerprints, evidence/split/measurement labels, case sets, workflows or containment eligibility. It matches cases by their pseudonymous IDs regardless of array order. Freeze those identities and labels before reviewing results; changing both input files can defeat a structural check, so preserve the original dataset and review history separately. The same configuration fingerprint is allowed for repeatability trials. Timing units must be explicit milliseconds in both inputs.

Output contains both aggregate reports and matched outcome transitions, with no individual case IDs. Net success can conceal one improved case and one regression; the transition counts expose both. Critical categories show newly recorded failures on previously reviewed versus unreviewed cases separately. A missing critical label on an unreviewed candidate is **not** counted as resolved. The complete case and eligible-case denominators retain failures and unreviewed outcomes.

All deltas mean **candidate minus baseline**. Rate deltas are fractions, so `0.05` is five percentage points. Latency P50/P95 deltas are emitted only when each matched case has at least one recorded turn and every recorded turn has that metric on both sides. Otherwise the delta is null, and coverage counts identify cases without turns or with missing metrics. Original aggregate distributions and their missing counts remain visible. Zero is an observed value; component timings never manufacture response time.

These are differences between **turn-weighted distributions**, not paired-turn measurements or proof of causality. Different turn counts are reported, not rejected; conversations can legitimately have different lengths. Failed calls' recorded turns remain included. Complete recorded coverage cannot prove that all real turns were captured, that measurement boundaries were consistent, or that conditions were equivalent. Review unsuccessful and unreviewed outcomes alongside speed: a fast failed booking is not an improvement.

Cost deltas require costs and reviewed outcomes for every case on both sides; cost per successful case additionally requires at least one success on each side. Costs include failed cases. Charge allocations for shared or idle GPU capacity must be documented consistently outside the aggregate file. No confidence interval, voice-quality score, licensing verdict, rollout recommendation or production readiness is inferred.

The command performs no network requests or writes and prints no input paths, raw calls or credentials. Each input is bounded to 10 MiB with a bounded read, valid UTF-8 and JSON, and the existing case/turn limits. It requires a regular file, refuses final-component symlinks and opens nonblocking so a named pipe cannot hang waiting for a writer. Parent-directory links are not a filesystem sandbox. Unsupported file-opening guarantees fail closed. All failures use a fixed redacted error and exit 2. Exit 0 means a valid comparison was produced, **even if the candidate failed every case**; it is not a CI quality gate or release approval. Fingerprints still require review before sharing.

No real trial results are bundled. Synthetic regression tests verify this calculator; actual phone baseline and candidate measurements remain separate work.

## Freeze and compare the saved configuration

Use Node 22 and a Vapi **Version History export** kept outside Git:

```sh
node scripts/inspect-voice-config.mjs --input /private/path/baseline-export.json
node scripts/inspect-voice-config.mjs --input /private/path/baseline-export.json --compare /private/path/candidate-export.json
```

The expected envelope has exactly `assistant` and `version` objects; `version.version` is a string such as `v23`. The assistant must contain nonempty model, voice and transcriber objects. This validates the supported export shape, **not** the provider's full API schema or whether that file is actually published. Both facts remain explicitly false in the output flags until separately verified by a reviewer. A successful command does not change those flags.

The offline command prints only fixed report labels, SHA-256 fingerprints and comparison flags. It never prints original prompts, IDs, URLs, credentials, private metadata or input paths, and performs no network requests or writes. Files are limited to 1 MiB, regular-file reads, valid UTF-8 and JSON; canonicalization also bounds depth and node count. Invalid input exits 2 with a fixed error. Exit 0 means inspection succeeded, not that the candidate passed quality or release checks.

Object-key order is normalized; array order and missing/null/empty distinctions are preserved. Export-version metadata is excluded from configuration equality. All assistant fields are included, including unknown provider options and credential changes. Nine component fingerprints distinguish model, prompt, tools, knowledge, voice, transcriber, turn-taking, greeting and remaining settings. A `remaining` change still needs review. Assistant metadata or credential rotation can change a fingerprint without changing spoken behavior. Hashes are comparison evidence, not restorable backups or a general-purpose deidentification tool; keep the original export protected and review any report before sharing.

For a voice-only trial, verify that only the voice component changed; for a model-only trial, verify the intended model change and explicitly review any additional differences. Record how the baseline was obtained separately. The same assistant configuration does not freeze external tool code, property data, phone-number routing, referenced knowledge or provider model behavior: track those separately. Never publish an unrelated pre-existing draft just to obtain a candidate.

## Vapi integration boundary

Vapi exposes per-turn and average performance fields in call artifacts. Its public model-comparison total omits endpointing and transport. Current SDK type documentation explicitly gives milliseconds for transport averages but does not state units for every turn field. **No automatic Vapi conversion is implemented:** verify actual field units and measurement boundaries before mapping to this contract. In particular, provider turn latency is not automatically the time to the first meaningful response.

On September 22, Vapi's Latency Summary for one historical September 10 v22 call explicitly labelled its displayed values as milliseconds. Its six-turn average was 3,646 ms. That confirms the unit for that UI view only; it does not establish SDK field units, first-meaningful-audio boundaries or a current v23 baseline. Do not import the displayed totals as `responseMs`, or interpret zero component values as measured zero without confirming missing-value behavior. See the [baseline evidence report](../reports/2026-09-22-voice-baseline.md).

Sources checked September 22, 2026: [Vapi latency methodology](https://docs.vapi.ai/assistants/model-intelligence/understanding-latency), [performance metrics](https://raw.githubusercontent.com/VapiAI/server-sdk-typescript/main/src/api/types/PerformanceMetrics.ts), [turn latency schema](https://raw.githubusercontent.com/VapiAI/server-sdk-typescript/main/src/api/types/TurnLatency.ts). No saved assistant or provider settings changed.
