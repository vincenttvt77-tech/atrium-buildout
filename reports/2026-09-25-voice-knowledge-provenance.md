# Managed voice knowledge provenance — September 25, 2026

Task AT157, Codex root. Branch `codex/at157-voice-knowledge`, base
`5cf23552fdf085b66ebd34dc6d584650bc17d6f0` in the isolated `atrium-managed-voice`
worktree. This fixes an independently reproduced gap in the preceding release work.
No live assistant, draft, knowledge file, phone routing, hosted database or production
deployment was changed. No paid calls, simulations, speech generation or GPU rental.

## Confirmed problem and correction

The managed publisher copied the existing model configuration, including an attached
provider knowledge base, without verifying that attachment's property provenance.
A reused assistant could retain another building's document while receiving a new
property's script and tools. Two synthetic regressions failed before the correction:
one retained the foreign attachment; the other reported it as verified.

Managed publication now replaces that attachment with the selected property's approved
Atrium knowledge tools. The model provider, custom endpoint, generation settings,
voice and transcriber are preserved. Existing provider files are not deleted. The
review explains the knowledge replacement before the user checks and publishes it;
the spoken prompt explicitly uses `answer_question` for property facts and policies.

A policy version is included in the immutable configuration fingerprint. Previously
prepared reviews cannot silently apply this new behavior; staff must review a fresh
proposal. Already dispatched records keep their original verification evidence.
Exact saved-model verification rejects any retained or reintroduced provider knowledge
attachment. Recovery remains read-only and cannot repeat the provider write. The
legacy publisher remains separate and retains its prior attachment behavior.

Vapi's [query-tool guide](https://docs.vapi.ai/knowledge-base/using-query-tool), checked
September25, states that sending a complete model through PATCH replaces the existing
model configuration. The pinned SDK2.0.1 model types expose `knowledgeBase` as optional.
The managed implementation omits it from that replacement and requires saved-state
readback to demonstrate its absence. A synthetic provider cannot establish actual
account behavior; hosted/provider acceptance remains required.

## Fresh read-only provider evidence

The signed-in Vapi dashboard still marks v23, published September12, as current and
shows a separate pre-existing unsaved draft. The fresh v23 export equals the
September22 export: seven inline function tools, selected Vapi Nico voice, Anthropic
model configuration, Soniox transcription, saved credential references and one
provider knowledge-file attachment. No inline authentication header or masked value
was found in the inspected assistant/tool server configuration. This is configuration
inspection, not a successful phone call or proof of credential-to-backend matching.

The browser download event timed out, but the actual export file was created and its
fresh modification time verified. The export does not include assistant id/orgId, so
it cannot substitute for the production SDK's exact provider identity check. Raw
exports, file IDs and credentials remain outside Git. The inspection tab was closed
without editing, restoring or publishing either version.

## Actual checks

- Pre-fix focused regressions: **0/2 passed**, both failures reproduced the bug.
- Final focused voice configuration/release/transport: **22 passed**.
- Actual HTTP, signed MFA and PostgreSQL release cases: **10 passed**.
- Final `npm run check`: **1,831 passed**, type and fixture validation clean.
- Full `npm run test:database`: **736 passed**, zero failures, cancellations or skips.
- `npm run build`: **26 handlers** built and passed isolated import/refusal smoke checks.
- Actual Chromium: **9 scenario groups passed**, including320/390/1280px review,
  explicit knowledge replacement, lost replies, a retained attachment remaining
  unconfirmed, restart recovery, stale provider state and a real15-second UI timeout.
  Zero real provider requests and no browser errors. The320px screenshot was visually
  inspected; the notice and action controls fit the narrow dialog.

The first full application run had1830/1831 passing: the generated dashboard differed
from its source. The first browser run likewise saw the older generated UI. Rebuilding
with `npm run build:ops` corrected the assets; the complete check, build and browser
runs above then passed. No assertion was removed or relaxed. The temporary Node
installation's npm symlink target was missing, so checks initially could not start.
A separate Node22.23.2 runtime was restored from the official checksum-verified
archive. The first extraction attempted an unsupported Python option; the verified
archive was subsequently extracted successfully. No application dependency changed.
All final local process handles are terminal: full native76620 and browser94005 exit0.

Parent sourcebca58bd's exact [cloud run36138780810](https://github.com/vincenttvt77-tech/atrium-buildout/actions/runs/36138780810)
is terminal SUCCESS:1828 application,735 native,26-handler build and16 Chromium groups.
Do not poll those completed parent jobs again. Those results do not cover this new
source increment; its own exact-source cloud acceptance is next after publication.

## Exact-source cloud acceptance — September 25

Published application source `ecbe8d30dc373f38f9fcf8637412971cbaaee689`,
[run 36141221040](https://github.com/vincenttvt77-tech/atrium-buildout/actions/runs/36141221040),
is terminal **SUCCESS**. Decoded verify-job 108091260516 logs confirm 1,831
application tests, 736 native PostgreSQL tests and the 26-handler build/import
checks. Browser job 108091260860 passed 17 groups: eight follow-up and nine voice
release groups, with no real provider calls. Stop polling these completed handles.
This supersedes the publication-pending cloud note above without changing its
historical local failures. Hosted and real-phone acceptance remain separate.

## Limits and next ownership

The original full leasing/SaaS goal remains active. Source tests do not prove live
knowledge removal, external Vapi normalization, webhook authentication, inbound
routing, notification delivery or measured phone latency. Concurrent external Vapi
edits still lack a demonstrated conditional update guarantee. A custom model service
may hold its own data; review its property isolation and retention before a hosting
trial. No change to voice choice or model hosting is claimed here.

Owner to-dos: complete secure isolated Preview provisioning; provide approved property
rules and representative permissioned leasing calls; set a bounded voice/hosting trial
budget and choose a licensed Black American or Latina female voice after listening.
The existing AT129 production-promotion approval boundary remains separate.

Next Codex/Fable: verify this branch's exact published commit and cloud checks; review
knowledge removal and legacy/prepared-review compatibility; then validate actual
provider readback and phone-to-tool-to-dashboard/inbox actions in an isolated hosted
setup. Compare the current successful baseline, a new voice and Vast-hosted model
separately, keeping accuracy, latency, cost and recovery evidence distinct. Finish
held-out evaluation and pilot acceptance without shrinking the original goal.

Leave a reciprocal handoff with accessible commits/deployments, actual checks and
failures, outstanding risks, owner actions and next-agent actions. Preserve unrelated
canonical calendar changes and historical coordination records.
