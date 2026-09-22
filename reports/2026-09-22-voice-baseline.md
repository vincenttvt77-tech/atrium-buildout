# Published voice baseline and comparison preparation

September 22, 2026, AT-136. Branch `codex/at136-voice-baseline`, base `a08234b9a5c01de724f7c69c56a0c77d23f83bda`. This increment makes the owner's Vast.ai/Black American or Latina female voice comparison reproducible. It does not select or publish a new voice/model, establish a latency improvement, or deploy application changes.

## Observed account evidence

- Atrium v2's Version History marked v23 current, created September 12 at 22:44:23.497 UTC. Export obtained through that version's Export control. A separate pre-existing unsaved draft was preserved; it was not published, discarded or restored.
- Published export: Anthropic `claude-sonnet-5` at temperature 0.4; Vapi `Nico`, version `2`; Soniox `stt-rt-v5`, English. Voice speed was not explicitly set in the export. Seven inline function tools and no referenced tool IDs. See the [settings summary](../docs/voice-provider-evaluation.md#published-configuration-observed-september-22) for observed turn-taking values. Nested fallback/endpointing rules were not individually evaluated.
- The inspected phone-number settings selected Atrium v2 for inbound calls and displayed `https://ghost-building.vercel.app/api/vapi` as the server URL. No fresh call, authentication probe or live booking was performed. This proves the displayed routing selection only.
- The unsaved editor's component cards estimated about 2,840 ms in total. These cards are provider estimates and omit endpointing/transport; they are not a measurement of the published assistant's caller experience. [Vapi methodology](https://docs.vapi.ai/assistants/model-intelligence/understanding-latency).
- The displayed Last 14 days history had three calls, latest September 10 on v22. No v23 call appeared in that bounded view. The latest is the previously supplied unauthorized-tool incident, not successful current-channel evidence. Its Latency Summary explicitly labelled values milliseconds: six turns, average 3,646 ms, range 2,410–5,215 ms. The boundary of total latency was not established as first meaningful audio; component zeros cannot be assumed observed zero. No values were mapped into the evaluator's `responseMs`.
- Vapi showed $1.14 in account credit. No call, paid simulation, generated audio, audition, top-up or GPU rental occurred.
- The ElevenLabs voice library displayed 21 default voices. Zoe search returned no results; Leoni was not listed in the displayed set. Exact candidate IDs, account availability, licensing and listening preference remain unverified. Public descriptions remain audition leads; personal ethnicity is not inferred. Vapi v2 female catalog entries did not establish the requested presentation.

Raw version export remains outside Git. Caller identifiers, numbers, recordings, transcripts, credentials and the full prompt are excluded from this report. A configuration hash is not a backup or evidence that an external service still uses those settings.

## New offline comparison

`scripts/inspect-voice-config.mjs` fingerprints the exported assistant and nine component groups. It distinguishes an intended voice/model change from prompt, tool, knowledge, timing, greeting or other drift. Every assistant field participates, including unknown options and credentials; only export-version metadata is excluded. It prints fixed labels and hashes, never original values. Malformed/oversized/non-UTF-8 files fail with a fixed message and no input/path echo. The tool does not access Vapi or validate the provider API schema. [Usage and limitations](../docs/voice-evaluation.md#freeze-and-compare-the-saved-configuration).

Actual v23 export fingerprints:

| Scope | SHA-256 |
| --- | --- |
| Configuration | `f7a308415a1be3998c913b1fc2bf12fcb1b4fb2e8dd1d3a3db9cc696b5a0cc1f` |
| Prompt component | `7282a246dd954b76b957145497e213d06d5ea52669422d450cf5046f844106d6` |
| Tools component | `1822127e075cc7607a3141ca1e190cbec7802208ffc5ef103f7ed8a1d494b29b` |
| Voice component | `f0c04ca25075dd3e5776b92d5f9fdb38c9bc95b48fca62ab2c2e7f0c29ba21f2` |

These are the new inspector's component hashes. The tools component is **not** the application's separate Vapi publisher/schema fingerprint; do not compare hashes from different algorithms or claim publisher synchronization from this report. External tools, referenced knowledge, inventory, routing and provider behavior require separate version tracking.

## Actual checks

Node 22.23.2, local checkout:

- `node --test test/portal/voice-config.test.mjs`: 6 passed. Covers value leakage, malformed/private errors, byte/complexity bounds, stable canonicalization and intended versus unrelated drift, including unknown fields and credential rotation.
- `npm run check`: typecheck and fixture validation clean; **1,701 tests passed, 0 failed**.
- `node --test --test-concurrency=2 'test/database/*.test.mjs'`: **521 isolated PostgreSQL tests passed, 0 failed**.
- `npm run build`: passed; **18 API handlers** imported and refused unconfigured requests in both runtime modes.
- Inspector executed against the actual privately stored v23 export and returned the hashes above. Initial code expected a numeric version; the real export used `v23`. Corrected the contract and regression fixtures, then reran the focused and full checks successfully.

Documentation paths and scoped diff reviewed. No application UI source changed, so the application browser suite was not rerun; the prior AT-135 browser result is separate evidence. No independent review, cloud CI, fresh phone result or production acceptance claimed for this increment. Live assistant/model/voice, pre-existing draft and production deployment remain unchanged by this task.

## Owner to-dos

Ensure calling credit for the next controlled test; agree a bounded hosting/call-test budget before provisioning a GPU or running comparative trials. Choose between licensed voice samples after listening. Provide permissioned representative calls and verified property facts for the held-out evaluation. The separate AT-129 production approval remains pending; this work does not bypass it.

## Codex/Fable to-dos

1. Recheck current publication and compare the private baseline export before any tuning. Preserve the unrelated draft. Record the backend revision and property-data snapshot separately.
2. Establish a fresh successful baseline through actual phone audio and persisted outcomes, with caller-end to first-meaningful-audio measurement and transparent AI disclosure. Do not substitute this old failed v22 call or editor estimates.
3. Resolve exact licensed candidate IDs/account availability; audition the same synthetic leasing script, including numbers, dates, interruptions and error recovery. Test voice only before combining changes.
4. Select and verify a compatible streamed tool-calling model before a budgeted Vast trial. Measure warm, idle and concurrent behavior, quality and total cost including ready GPU capacity; set budgets before tuning. No claim that Vast is faster until measured.
5. Publish only an accepted configuration with a documented rollback and separate live-channel checks. End the next session with a reciprocal handoff: commits/deployments, actual results, limitations, owner to-dos and next-agent to-dos. Require the following agent to do the same.
