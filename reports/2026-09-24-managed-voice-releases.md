# Managed property voice releases — September 24, 2026

Task AT-156, Codex root. Branch `codex/at156-managed-voice`, application base
`92ab85c403a1e09ec87dbcab78d1b6bd83fb9818`. CI-only parent
`f13be3ea11b77a8199b7bafeac19ea83a5606560` adds the browser release scenario; it was
published with CI skipped until the accompanying application commit is ready.
The source implementation replaces the managed account's unconditional publisher
refusal with an actual property-specific review, publish and recovery flow.
No Vapi assistant, editor draft, voice, model host, phone number, production
deployment or hosted database was changed by this task.

## What changed

- Status now offers current configuration managers a mobile review of the greeting,
  complete leasing script, nine tools, connection and timing settings. An explicit
  checked review is required before publication. Release history, cancellation
  before dispatch and unresolved-result recovery are included.
- Configurations use the selected, validated published property. Building-local
  date resolution is no longer hardcoded to New York. Required identity cannot
  silently fall back to bundled Larkin facts.
- A property-owned PostgreSQL journal saves review/actor/version evidence and the
  dispatch identity before a provider write. Concurrent/replayed submissions send
  once. Unknown results are verified through GET and cannot trigger a replacement
  PATCH. Permission, session, property version and channel binding are rechecked.
- Provider identity is tied to the bound assistant and configured Vapi account.
  Existing voice, transcriber, custom model endpoint and model settings are kept.
  Raw provider credentials are not stored in the journal or shown in the review;
  masked provider values refuse publication instead of replacing real settings.
- The official SDK is pinned to 2.0.1 with retries disabled, a fixed API origin,
  refused redirects, bounded response time/bytes and redacted failures. A provider
  acknowledgment is insufficient; saved-state readback must match.
- The existing browser CI job now includes the managed voice scenarios while
  retaining the follow-up scenarios and seven-day screenshot artifacts.

## Actual verification

- Final `npm run check`: **1,828 tests passed**, no failures, cancellations or
  skipped cases; TypeScript and data validation passed.
- Final `npm run build`: **26 API handlers** built and passed isolated imports and
  unconfigured-request refusal checks in legacy and PostgreSQL modes.
- Focused final voice configuration/release/transport run: **19 passed**, including
  the last masked-credential guard and cross-timezone midnight regression.
- Final native `npm run test:database`: **735 passed**, zero failures,
  cancellations or skipped cases, including the final masked-credential guard.
  The exact final session 8457 exited successfully; no test remains running.
- Actual Chromium, loopback HTTP, signed MFA and PostgreSQL: **8 scenario groups
  passed** at 320/390/1280px, including lost committed replies, provider drift,
  unresolved-history reopening, cancellation, a real 15-second UI timeout and
  route retirement. No browser errors or real provider requests. Narrow screenshot
  visually inspected. The last core masked-value guard was subsequently covered by
  the focused suite; exact-source cloud browser acceptance remains separate.

Earlier failures were retained during diagnosis: ignored package lifecycle scripts
left the native PostgreSQL library symlinks absent; those were restored through the
pinned package's reviewed local hydration script. The first fixture reused an
existing unique assistant ID and leaked a setup handle; distinct fixture IDs and
cleanup fixed it, and that exact stopped worker was not treated as a live test.
The first database adapter requested a row lock requiring table privileges it does
not have. The adapter now rechecks authorized binding state without broadening
privileges. An audit assertion expected an integer instead of PostgreSQL's bigint
string representation; the exact expected value was corrected. The bundle smoke
test now expects managed GET to refuse incomplete runtime with503, while legacy
GET remains405. None of these changes relax tenant isolation or write admission.

## Remaining acceptance and limitations

Source acceptance is not hosted or phone acceptance. Exact-source cloud CI and a
review of the new provider behavior remain next. No live account normalization,
credential-to-webhook match or phone routing has been proved by the synthetic
provider. Strict saved-field comparison conservatively leaves unexpected defaults
unconfirmed. The reviewed Vapi API exposes no demonstrated conditional version
update, so concurrent external Vapi edits are not atomically fenced. The UI warns
against editing during a release, and differences need investigation; do not claim
this is an external-editor lock.

Recovery does not automatically roll back or retry an uncertain provider write.
History is retained up to100 releases; a reviewed archival extension is required at
that limit. Opening this UI requires the deployment configuration to remain usable.
No migration, account creation, number routing or native Vapi draft management is
included. See [the operating contract](../docs/managed-voice-releases.md).

The original leasing goal is still active. Controlled hosted rollout, actual
phone-to-tool-to-dashboard and inbox acceptance, representative permissioned
recordings, held-out95% success, eligible80–90% containment, and measured phone
latency/cost are still unproven. Vast.ai and licensed Black American/Latina female
voice auditions remain planned comparisons, not completed migrations or selections.

## Reciprocal Codex / Fable handoff

Owner to-dos: finish the secure isolated Preview database creation; provide approved
property rules and roughly100 representative permissioned call examples; provide a
bounded voice/hosting trial budget and choose a voice after listening. Keep the
previous production-promotion approval question separate; AT129 was not bypassed.
Do not paste secrets into chat or handoffs.

Next agent: read AGENTS.md, AI_WORKFLOW.md and the canonical task board; fetch this
branch and verify its exact application commit/CI result. Inspect the managed
release admission, provider-mask refusal, property revalidation and uncertainty
recovery independently. Finish any failed exact-source gate, then use an isolated
hosted environment and authorized provider evidence to verify normalization,
authentication and actual end-to-end calls. Do not promote the production demo or
alter its assistant merely because local tests passed. Preserve the user's current
voice/model evaluation direction and all broader leasing acceptance requirements.

Fable and the next Codex session must each leave a reciprocal handoff with accessible
commits/deployments, actual checks and failures, remaining limitations, owner to-dos
and next-agent to-dos. Preserve unrelated uncommitted calendar work in the canonical
`atrium-buildout` checkout. This task's isolated application worktree is
`atrium-managed-voice`; all source changes there belong to AT-156.
