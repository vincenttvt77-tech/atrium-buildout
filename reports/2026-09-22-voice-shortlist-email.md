# Permissioned apartment email from a voice call

September 22, 2026. AT-137, branch `codex/at137-voice-email`, base `d2c21d76eb33b1d82bc4b17fbad514043b68b174`. The new backend flow connects a current apartment shortlist to explicit caller permission, durable email submission and same-call delivery verification. This is locally implemented functionality, not a live Vapi or production rollout.

## What changed

The managed voice handler saves only the latest server-produced shortlist. When the property has a compatible reviewed website and separately reviewed voice-email sender, the assistant can prepare the message, read back the caller's saved email address and ask permission. Its new email tool accepts only an action and an opaque offer ID. It cannot choose message HTML, sender, destination, arbitrary links or a consent flag.

The backend requires a newly spoken matching question and explicit affirmative user reply in the authenticated provider artifact. It binds the unchanged earlier conversation prefix, exact recipient/content, call, channel and property configuration. Missing history, refusal, correction, unclear/question-marked replies and model permission assertions do not authorize sending. This establishes recorded permission for public apartment information; it does not verify the caller's identity or ownership of that address.

One scoped transaction saves the permission evidence, immutable action, receipt, outbox and accepted call email record. A worker then attempts that exact action with bounded provider IO. It checks the current call/contact/shortlist, inventory and safety before dispatch. Repeated requests share one accepted email per call; an uncertain send is never replaced automatically. Status checking cannot initiate an email that has not yet dispatched. Provider acceptance, verified delivery, queued work and uncertainty remain distinct in tool results and the durable Work queue.

A repeated search for the same apartment followed by a fresh preparation now replaces an unaccepted permission offer. Keeping the earlier offer would bind the wrong search timestamp/history boundary and repeatedly reject an otherwise valid request; source review found and corrected that before acceptance. Contact capture now describes only that contact update, avoiding a false claim that no earlier email had been sent during the call.

The shared sender validator was extracted without changing staff tour-confirmation behavior. Voice email has its own opt-in property key; staff email setup does not enable it. No database migration, dependency, public-page form or dashboard UI change was needed. Existing responsive public shortlist pages remain the email destination.

## Verification

Final checks with Node 22.23.2:

- `npm run check`: typecheck and fixture validation clean; **1,706 tests passed, 0 failed** (five new focused application cases).
- `node --test --test-concurrency=2 'test/database/*.test.mjs'`: **537 isolated PostgreSQL tests passed, 0 failed**, including 16 new voice-email integration cases.
- `npm run build`: passed; **18 API handlers** imported and refused unconfigured requests in both runtime modes.
- Scoped source/diff and documentation link targets reviewed. No dashboard/public UI source changed, so application browser suites were not rerun. No independent review or cloud CI result claimed.

Tests use synthetic people, addresses and local HTTP providers. Zero real emails, phone calls or paid simulations were performed.

The native suite exercises the real Vapi HTTP handler, scoped PostgreSQL runtime, saved call lifecycle, exact consent admission, workflow worker and email adapter against a local HTTP provider. Cases cover happy-path acceptance/readback, refusal/missing evidence, changed recipient/shortlist, unknown units, foreign property/offer, bad webhook credentials, revoked channel, absent/foreign/expired senders, stale inventory, changed configuration, expired/corrupt saved state, dropped provider acknowledgements, lost webhook responses, concurrent tools, admission rollback, ended/emergency calls, repeated search preparation, status without dispatch and changed contact before first dispatch.

Initial failures were test-fixture/expectation issues: the fixture timezone did not match its property row; a test used an unsupported revoked-state label and attempted to edit an immutable published configuration; TypeScript needed explicit narrowing for the new tool schema; earlier publisher tests still expected seven tools. Corrected the fixtures to use actual inactive-channel and versioned-publication contracts, and changed the expected tool count to eight while preserving credential/routing assertions. Runtime authorization and immutable-configuration checks were not relaxed.

## Live boundary and remaining work

No live assistant, existing Vapi draft, voice/model, provider key/domain, hosted database or production deployment changed. The source has eight tool definitions; the earlier observed published v23 has seven inline tools. Source publication alone does not synchronize those contracts, and this prompt must not be published against an older backend. AT-129's separate pending production approval is not bypassed.

Permission relies on Vapi's speech artifact and strict question/reply matching; actual phone chunking, transcription and address read-back still need a controlled live test. ASR corrections to the earlier history can require a fresh preparation. Five-minute offers/shortlists and one email per call are deliberate limits, not general marketing consent. Unknown acknowledgements and original-authority/configuration changes may require staff investigation. Current-state validation is immediately before IO, not an atomic transaction with an external send or later caller correction.

The initial send attempts provider submission during the tool request. A later same-call status request can verify it. There is no unattended runner, so delivery after the call ends may remain pending in the Work queue. Historical email visibility and event-history reconciliation remain open. Provider domain access, real inbox results, caller-perceived latency, the wider 95% held-out target and production acceptance are not established by these synthetic checks.

## Owner to-dos

Choose and verify a sending domain/identity and an approved test recipient when activation is prepared; provide provider access securely then. Ensure phone credit and approve a bounded comparative voice/hosting test budget. Supply authoritative property/site data and permissioned representative calls. The separate production decision remains pending.

## Codex/Fable to-dos

Review/integrate the published branch; add scoped scheduled reconciliation and message history so delivery does not depend on the caller asking for status. Activate managed storage, reviewed sender/site bindings and exact Vapi tool/prompt together through the agreed release process. Run a permitted real call and verify exact recipient/link, stored permission/action, provider result and actual inbox. Preserve the current draft and baseline until acceptance; keep voice/Vast benchmarks separate. End the next session with a reciprocal handoff containing exact commits/deployments, checks, limits and separate owner/next-agent to-dos, and require the following agent to do likewise.

Implementation and setup: [email delivery guide](../docs/email-delivery.md), [public shortlist guide](../docs/public-shortlist.md). The official Vapi protocol sources are linked in the email guide.
