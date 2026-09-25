# Atrium pilot acceptance audit — September 24, 2026

**Atrium is not yet verified as pilot-ready.** The current source contains substantial
leasing and staff workflows, but production still reports the legacy KV runtime.
Hosted managed accounts, current voice integration and actual notification delivery
have not been accepted. More source features alone do not close those gaps.

AT155, Codex root. Reviewed source `2dbd05b15c0804bc7f42d58b2504c423675dfd02`, including
the committed AT154 implementation. Canonical unrelated calendar edits were observed
and preserved; they are excluded from this published-source audit. This is not an
independent code review or an assertion that all defects have been found.
The [full leasing goal](../docs/leasing-goal.md) remains unchanged and active.

### September 25 source update

The managed assistant publication gap described in this historical audit has since
been implemented and verified in source. The [managed release contract](../docs/managed-voice-releases.md)
now covers property-bound review, current authorization, single dispatch and
saved-provider verification. Subsequent fixes address unverified inherited
knowledge and concurrent publication recovery. Exact application commit
`94ac317f0a8b3cbf18a5250de0caa3983d10461e` passed 1,842 application tests, 738
PostgreSQL tests, 26 browser scenario groups and the 26-handler build in cloud
run 36152686990. See the [accepted evidence and handoff](2026-09-25-voice-publish-race.md).

This supersedes the source-level publisher-unavailable statement and its proposed
implementation task below. Hosted account/channel acceptance, real notification
delivery, measured voice trials and the representative pilot evaluation remain
pending. The separate test database was still absent on September 25 at 15:21 UTC.
The prepared Free-project form now awaits specific approval for a fresh private
credential and project submission. Production promotion remains a separate gate.
Next agents should perform the remaining hosted acceptance when configured, not
reimplement the completed managed publisher. End with a reciprocal handoff and
separate owner/agent to-dos.

## Fresh runtime evidence

The read-only preflight ran against `https://ghost-building.vercel.app` at
20:57 UTC. It returned **exit 1**: seven assertions passed and one failed.
Public HTML, persistent storage, configured history-key presence, the sign-in form
and three unauthenticated API refusals passed. The deployed voice-tool contract
did not match the reviewed source. See the
[redacted preflight](evidence/2026-09-24-pilot/public-preflight.json).

A separate bounded public health read at20:58 UTC confirmed HTTP200, `store: kv`,
`durable: true`, and history-key configuration. The deployed schema fingerprint is
`fea94b5f3600f6764a1b803b05fc86757e91c85e9cf7a86b98abf0ca6f606c6d`;
the reviewed source fingerprint is
`2be3375c859707b38c6c8b8232931dae4eb33fc7e6eb58e2481ab594edad4769`.
[Exact comparison and limits](evidence/2026-09-24-pilot/health-comparison.json).
This proves a source/deployment contract difference, **not** that the currently
saved assistant mismatches its currently deployed backend. That separate pair
must be inspected together. No authenticated data, call or write was tested.

The previously inspected hosted Preview lacked authentication/runtime setup.
The last September23 resource inspection found no isolated Preview project in the
owner's selected organization. Those are dated observations, not a fresh provider
inventory in this audit. The pending secure setup in
[hosted Preview](../docs/hosted-preview.md) remains the next activation prerequisite.

## Goal-by-goal acceptance map

“Source evidence” below describes inspected contracts and relevant tests. It does
not mean a passing test proves a live customer outcome. Historical task reports
remain dated evidence; the current exact CI status is recorded separately below.

| Required outcome | Source evidence inspected | Missing acceptance / next action |
| --- | --- | --- |
| **1. Accurate inbound questions and qualification** | `src/knowledge/{retrieve,answer,guard}.ts`, `src/inventory/{source,match}.ts`, `src/vapi/prompt.ts`; known-unit, policy and shortlist regressions. | Approved pilot-building facts and a real phone test with the currently published assistant. Confirm unavailable facts produce an honest answer and useful staff handoff. |
| **1. Book tours** | `api/vapi.ts` and calendar readback/recovery; capacity, unit-block and booking-recovery tests. Confirmation requires saved backend evidence. | Phone → authenticated tool → persisted reservation → correct staff calendar in the actual hosted property, including lost replies and duplicate requests. |
| **1. Reschedule and cancel** | Staff calendar flows plus `test/database/tour-cancellations.test.mjs`, `tour-change-resolutions.test.mjs`; current voice schema records a pending `tour_change` request. | Returning callers cannot autonomously change a reservation. Staff must verify the caller/reservation, apply the actual change and record the outcome. Verify this whole handoff with real staff before counting a completed task. |
| **1. Confirmations and follow-ups** | Permissioned shortlist/tour/cancellation email workflows and shared delivery evidence; [email contract](../docs/email-delivery.md). AT154 staff status history is a manual work record. | Reviewed sender, permission, secure provider configuration, real inbox delivery and post-call verification. No activated automatic reminder campaign or SMS flow is established; marking handled is not delivery. Saved-but-unstarted requests still need explicit staff processing. |
| **1. Contextual staff handoff** | Prompt stops leasing questions for human requests; contact, caller words, escalation and pending tour-change records are retained in Calls/Leads. | No tool in the current nine-tool schema performs a live transfer. Staff ownership/response procedure and end-to-end delivery/acknowledgment of the handoff need acceptance. Do not market a saved request as a connected human. |
| **1. Existing website integration and ~15-second callback initiation** | Embeddable [callback widget](../docs/website-callbacks.md), exact-origin challenge, current voice binding, atomic receipt/budget, bounded one-call submission, no-redial recovery. | Activate an approved website/channel, challenge keys, pinned assistant/number and calling budget. Test actual deployed CORS/CSP, abuse controls, permitted recipient, start timing and resulting call/lead/calendar. Synthetic timings do not prove the target. |
| **1. Broader resident/PMS roadmap** | Resident/maintenance foundations are retained and described in `ARCHITECTURE.md`. No PMS was selected by the owner. | Keep broader fulfillment phased after leasing reliability. Select adapters from actual pilot PMS requirements; do not promise a connected PMS or full resident operation. |
| **2. ~100 representative permissioned calls** | [Voice evaluation](../docs/voice-evaluation.md) defines deidentification, labels, frozen cohorts and reviewer evidence. The supplied failure transcript is one regression example. | No reviewed representative corpus or permission/source manifest has been supplied for acceptance. Obtain permission, protect original mappings, categorize intents/outcomes and separate development from held-out calls. Human-assisted discovery remains available. |
| **3. Authoritative facts and freshness** | Structured inventory, source dates, quote guards, approved knowledge and property publication. | Approve real customer data and update responsibilities. A fictional demo catalogue is not current customer inventory; a healthy store does not establish source freshness. Verify changes without live conversational scraping. |
| **3. Capacity, unit blackouts, time zones and booking rules** | `src/calendar/test/{slots-settings,booking-settings,unit-blocks,timezone,reschedule}.test.ts`; native scoped calendar actions. | Hosted competing bookings: three-person capacity, different units concurrently, blocked unit versus other units, DST/local dates, notice/buffer policies and bookings beyond two weeks. Measure contention under the pilot's actual expected load. |
| **3. Durable actions, retries and partial outcomes** | Workflow receipts/outbox/fenced leases; booking reconciliation; email readback; callback no-redial; AT154 exact decision recovery and atomic audit. | Managed migrations/roles on the real host, recovery after a deployed restart, actual provider ambiguity and an operational owner for unresolved work. Preserve uncertainty rather than presenting a false success. |
| **4. Voice latency and provider comparison** | Offline component/configuration fingerprints, matched outcome/latency/cost evaluator and [four-way audition plan](../docs/voice-audition-kit.md). | Fresh successful phone baseline; P50/P95 across actual audio, endpointing, transcription, model, tool, speech and network; sample counts and measurement boundaries. Set numerical latency/cost budgets from that baseline. No measured Vast improvement exists. |
| **4. Voice quality, choice and safety** | AI disclosure and concise response rules; audition script covers unit numbers, money, dates, corrections and failure recovery. | Verify licensed candidate IDs/access, owner listening choice, real interruptions/long calls and pronunciation. Black American/Latina female voices remain audition preferences, not a selected voice or an inferred actor identity. Bilingual support needs separate acceptance. |
| **4. Accuracy, concurrency and cost per successful outcome** | Evaluator includes failed and unreviewed cases and missing measurements; matched comparison exposes regressions. | Matched real trials with a bounded budget. Count failed-call, telephony, speech and idle-hosting cost consistently; stress simultaneous callers and provider degradation. Fast text generation alone is not success. |
| **5. Known-unit inquiries and broader search** | Direct unit lookup, progressive constraints, bounded shortlist and permissioned email link; `availability-shortlist`, public-shortlist and voice-shortlist tests. | Real phone scenarios for 19A, corrections, no matches, broad searches, five-match coverage and remembered preferences. Verify the actual personalized link and inbox; no SMS claim. |
| **6. Polished desktop/mobile dashboard** | Navy/white portal, calls/leads, calendars, unit feedback, unit blocks, manual changes, follow-ups and exception recovery. Existing real-browser suites; current AT154 Chromium widths320/390/1280. | Hosted sign-in and all main flows on representative devices, including actual mobile Safari/touch and property switching. Desktop Chromium at narrow widths is useful but not physical-device proof or user acceptance. |
| **6. Honest demo state** | Manual decisions, provider acceptance/delivery and pending/confirmed actions have distinct states. Read-only preflight rejects mismatched contracts. | Use the actual accepted deployment in the demo. Label fictional inventory and offline demonstrations. Never present a branch preview with unavailable login, synthetic calls or fixture emails as live delivery. |
| **6. SaaS architecture and maintainability** | Persisted roles/sessions/property grants, scoped PostgreSQL adapters, audits, migrations, domain/HTTP separation and modular provider ports. | Hosted tenant onboarding, upgrade/rollback rehearsal, backup/restore, incident ownership and useful cross-service diagnostics under real load. CI totals do not certify portfolio scale or operations. |

## Explicit acceptance targets

| Gate from the goal | Evidence required | Current conclusion |
| --- | --- | --- |
| >=95% end-to-end success on a defined representative held-out routine-leasing evaluation | Reviewed case manifest, permission/selection evidence, frozen split/configuration, real call outcomes and persisted action/delivery evidence; report denominator and every failure. | **Not established.** No accepted real held-out cohort. Synthetic tests are not the denominator. |
| 80–90% eligible routine-inquiry containment | Predeclared eligibility, all eligible cases retained, proper escalations distinguished from autonomous success. | **Not established.** Do not suppress a needed escalation to increase the rate. |
| All defined critical isolation, authorization, duplicate-action, false-confirmation and data-loss checks pass | Exact-source tests plus hosted role/property/race/revocation/failure evidence for enabled flows. | Significant synthetic coverage exists; current full CI passed but hosted acceptance is missing. One public401 response is not tenant-isolation proof. |
| Phone → tool → dashboard; notification delivery | One correlated accepted release and actual permissioned test records through every enabled step. | **Not established for current source.** Production is still KV and has the earlier contract. |
| Degraded services and concurrency | Interrupted/lost responses, worker restart, provider rejection, capacity races, no duplicate effects and visible unresolved state. | Local/cloud synthetic cases exist; real deployed/provider/load acceptance remains. |
| Latency and cost budgets | Current successful baseline, recorded methodology/sample size, pre-agreed limits and matched candidates. | **Not established.** Budget and real baseline are pending. |
| Daily EOD and reciprocal handoffs | Accessible commit/report, actual checks/deployments, limitations, owner and next-agent to-dos. | Reports are maintained and published with source. Every next agent must leave a return handoff. This does not substitute for the customer gates above. |

## Release sequence and a confirmed product gap

The managed PostgreSQL path in `api/vapi-sync.ts` deliberately returns409
`property_assistant_publish_unavailable`; its current publisher builds the bundled
Larkin assistant and cannot safely publish an arbitrary customer's configuration.
This is confirmed incomplete product behavior, not a failing protection to remove.
A managed account alone therefore does not make the Status publish button functional.

The next source work should close that release path: prepare a property-specific,
versioned assistant configuration from approved data; show the exact intended
prompt/tool/origin changes; preserve separately chosen voice/model settings; bind
publishing to current authorized property/channel state; verify the deployed backend
contract and saved provider result; retain uncertain outcomes and rollback evidence.
First build and test a reviewable plan without live publication. Do not adapt the
legacy bundled publisher by simply deleting its409 guard. Actual provider publication
still needs the separate reviewed release and current credentials/authorization.

Priorities, in dependency order:

1. Exact-source CI is now complete. Independently review the critical changes and
   preserve the recorded source/hosted distinction; stop polling the terminal run.
2. Complete the isolated managed Preview, restrict inherited external credentials,
   apply reviewed migrations, verify saved accounts/passkeys and tenant boundaries.
3. Complete/review the managed voice release path and establish an isolated test
   assistant/channel. Align backend and saved tools before using that channel.
4. Configure a reviewed test email sender and one permitted recipient. Verify the
   website request, conversation, booking, staff handoff and email as a single story.
5. Assemble the representative corpus; obtain a successful current audio baseline,
   audition licensed voices, and compare Vast hosting and voice changes separately.
6. Run a controlled customer pilot and evaluate the full targets; only then expand
   broader resident/maintenance fulfillment and customer-specific PMS adapters.

No automatic production promotion follows from any source check. AT129's prior
approval-review rejection remains a separate unresolved boundary. A Preview setup
must not become a workaround for that rejection.

## Current checks and evidence limits

Exact application source: `2dbd05b15c0804bc7f42d58b2504c423675dfd02`.
[GitHub run36057572927](https://github.com/vincenttvt77-tech/atrium-buildout/actions/runs/36057572927)
is terminal SUCCESS. Decoded verify-job logs confirm **1,814 application tests,726
native PostgreSQL tests and the26-handler build**, with zero failures, cancellations
or skips. Browser job107828288977 is terminal SUCCESS, with
all8 groups including real15-second recovery, lost acknowledgements, stale Undo,
changed source and retired navigation. No real providers ran. Screenshots were saved
as artifact10832898348 with seven-day retention. Verification job107828289292 is
terminal SUCCESS. Stop polling this completed run. The exact results and boundaries
are saved in [cloud acceptance](evidence/2026-09-24-pilot/cloud-acceptance.json).
The local interrupted runs and fixture corrections are preserved in
[the AT154 report](2026-09-24-followup-decisions.md), not relabelled as passes.

This audit ran only public GETs and source/document inspection. It did not log in,
read private caller records, change live services, run paid calls, rent a GPU or
change an assistant. It makes no future-uptime guarantee. The report's source/path
references and evidence JSON are checked; no unrelated application suite is rerun
for documentation alone.

## Owner and next-agent handoff

**Owner:** finish the already-prepared secure Preview credential/create step; supply
approved property rules and permissioned representative calls; provide a bounded
voice/hosting test budget and pick a voice after listening. Approve production
promotion separately only when the concrete release is ready. Never put credentials
in these public reports.

**Codex/Fable:** cloud verification is complete; retain its exact evidence and local
failure history. Review this map against the source and independently inspect
critical boundaries. Continue the managed voice release preparation; then perform
hosted account/channel/inbox acceptance when owner inputs arrive. Avoid another
cosmetic feature detour while release gates remain open. Preserve existing unrelated
calendar changes. End with accessible commits/deployments, actual results and limits,
owner to-dos and next-agent to-dos, and require the following agent to do the same.
