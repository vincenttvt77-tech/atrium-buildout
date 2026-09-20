# Atrium work report and reciprocal handoff — September 20, 2026

Coordinator: Codex root, with three parallel implementation/review agents. Repository: `vincenttvt77-tech/atrium-buildout`; branch: `codex/atrium-quality-pass`. Starting commit: `9b935ab`. Final tested and deployed application source: **`5ef64688ddc687fd24d393f91f4b84b15b77078c`**.

## Delivered

- **Booking recovery:** distinguish proven pre-write failures from writes that may have committed. Recover lost acknowledgements through exact reservation readback; never blindly repeat an uncertain booking or falsely confirm it.
- **Staff review:** uncertain bookings retain independent, durable, property-scoped review cards in Today and Calls. Attempted tour/contact details survive finished-call projection failure. Callers can still leave contact details during uncertainty, including calendar read outages. Webhook replays repair failed review persistence without booking again.
- **Caller versus callback:** requested callback numbers carry evidence without replacing provider caller identity. Anonymous callers remain separate, with exact dashboard links and task filtering. Today and Leads offer manual calling-app links to the requested number; they do not automatically place or log calls.
- **Safety context:** hypothetical heating questions and resolved history avoid inappropriate holds; ongoing, unresolved or recurring loss of heat remains guarded. Recorded safety holds and stronger emergency rules remain protected.
- **Authentication:** hosted/named-account webhook verification occurs before assistant routing, including missing-secret requests.
- **Truthful call history:** authorization/system errors no longer become approved answers, successful lookups or zero offered tour times. Missing results do not imply a dropped call. Approved-source claims require matching structured evidence; confirmed bookings remain visible alongside unrelated failures.
- **Maintenance regressions:** preserve specific permission/configuration refusals from consent reads; retain strict expiry rejection and verify fresh reads. Repair independent lock-holder clients and exact timestamp generation in synthetic consent fixtures without weakening application validation.
- **Mobile/desktop:** corrected the review-card desktop layout and checked recovery cards, anonymous selection, callback actions, keyboard/focus behavior and horizontal overflow at 320, 390 and 1280px.

## Verification

| Check | Actual final result |
| --- | --- |
| `npm run check`, Node 22 | **1,509 passed**, zero failures/skips; typecheck and data validation clean. |
| `npm run test:database` | **497 PostgreSQL tests passed**, zero failures/skips; isolated disposable databases. |
| `npm run build` | **17 API handlers** and generated site/dashboard built; unconfigured-request smoke checks passed in both runtime modes. |
| Real Chromium | **9 checks passed** at 320/390/1280px; zero page/console errors or unexpected requests. Synthetic intercepted fixtures only. |
| Diff checks | Clean; only owned source, generated artifacts, tests and current records published. Pre-existing untracked coordination history preserved. |

[GitHub quality run 35535348420](https://github.com/vincenttvt77-tech/atrium-buildout/actions/runs/35535348420), job `106143267085`, completed successfully on `5ef6468`. Its logs independently confirm all 1,509 application tests, 497 database tests and the 17-handler build. The nine browser checks cover recovery and anonymous-callback flows; rendered-card regressions and read-only live checks cover the final wording correction. Focused test counts overlap these totals and must not be added together.

## Release

Source changes and this report are published on GitHub. Implementation commits are `7e7397d` (core reliability), `23ee750` (truthful summaries), `5325ce9` (deterministic consent fixture) and `5ef6468` (distinct system-error review guidance). Release documentation follows separately so it can name the exact tested/deployed source. A later documentation-only branch HEAD does not imply a later application deployment.

Final production deployment: [`HfvECEzbsU4SZYodAsUehQW2ZmdK`](https://vercel.com/vincenttvt77-9161s-projects/ghost-building/HfvECEzbsU4SZYodAsUehQW2ZmdK), built from `5ef6468` using production settings, Ready in 45 seconds and assigned to `ghost-building.vercel.app`. The final preview `3iT57BaBtvTg6zK3LUMeVWN5CzXf` was Ready in 42 seconds. Read-only live verification after release confirmed the historical authorization-failure call now shows “A system step needs review,” no failed-booking claim, and all four failed tool steps accurately marked unconfirmed. Health returned healthy durable KV with call history. Existing demo login and callers/calendar/history loading were also verified during this release sequence. [Open the live dashboard](https://ghost-building.vercel.app/api/dashboard).

The runtime remains **legacy shared-login and durable KV**. Managed named accounts, resident/maintenance features and the repository's 14 additive migrations require separately verified hosted activation. The earlier `7e7397d` production release was verified before this follow-up.

Backend tool-schema fingerprint remains `fea94b5f3600f6764a1b803b05fc86757e91c85e9cf7a86b98abf0ca6f606c6d`. No Vapi assistant/tool edits, new phone calls, paid simulations, hosted migrations, credential changes or outbound messages were performed. Saved assistant synchronization, phone/audio quality, physical passkeys and centralized production error monitoring were not verified. Linq is not connected.

## Failures found and corrected

- Three older application tests assumed a callback number replaced caller identity. Their fixtures/assertions now preserve separate identity/evidence and the original isolation guarantees.
- The first full database run passed 490/497. Five prior maintenance inbox issues and two broken lock-client fixtures were fixed; final local/cloud suites pass. An initial sandbox-only database attempt could not bind loopback; permitted isolated reruns succeeded.
- Independent review exposed stale snapshots, lost dispatch-marker replies, review projection failures, out-of-order contact completion, duplicate tool batches and anonymous cross-caller association. Added regressions pass.
- Browser inspection found a review body rendered in the icon column. The corrected layout is checked for readable width. Artifact-parity checks caught a stale generated bundle after a final source edit; regeneration passes.
- A live historical failed-call summary falsely claimed an approved answer. The follow-up fixes that inference without altering saved caller data. Final inspection also caught generic system errors incorrectly using failed-booking review guidance; the final correction and rendered regressions distinguish those outcomes and preserve confirmed bookings.
- Cloud run `35534427528` failed one unchanged resident-consent fixture, so the follow-up was held. A deterministic incrementing-clock test reproduced its unequal UTC/local timestamps. The fixture now reuses exact instants, and the regression still rejects one-millisecond mismatches. The subsequent complete cloud run passed. No production validation fence or release check was bypassed.

## Next work for Codex / Fable

1. Verify the saved live assistant/backend fingerprint and real phone behavior; dashboard health does not establish voice acceptance.
2. Add authoritative reconciliation and guarded resolution of uncertain booking reviews, plus bounded pagination. Existing cards do not resolve themselves or send notifications.
3. Verify hosted schema/runtime before managed account/resident activation. Complete authorized fulfillment, dispatch, notification and readback through the existing authority/outbox foundations.
4. Build provider-independent messaging with property routing, consent, durable receipts, deduplicated retries, attachments and human takeover before enabling Linq or Apple messaging.
5. Continue amenity scheduling, owner outcomes, PMS connectors, web-lead response, onboarding, imports and operational/security testing. These remain open product work.

## Next work for Evan / Luke

- Test the real Larkin line for 19A facts, tour timing, requested callback and rescheduling; retain the call ID for verification.
- Obtain Linq pricing/reseller terms, per-property number/account design and failure handling; choose which product to pilot.
- Identify the first actual property/PMS and approved operating rules when known. No PMS has been selected yet.

## Reciprocal handoff

Fable: read AGENTS.md, AI_WORKFLOW.md and docs/agent-tasks.md from GitHub before taking work. Coordinate overlapping paths and review the exact published commits. End your session with a reciprocal handoff containing changed commits, checks/failures, local/remote/deployed/runtime state, ownership, limitations, owner actions and next Codex tasks. If local paths are unavailable, commit the handoff into the coordinated repository branch. Codex must leave the same handoff on return. Never publish secrets, real caller data or private contracts.
