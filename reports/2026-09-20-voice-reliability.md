# Atrium work report and reciprocal handoff — September 20, 2026

Coordinator: Codex root. Branch: `codex/atrium-quality-pass`. Starting commit: `9b935ab`.

## Delivered in this slice

- Bookings distinguish a proven pre-write failure from an uncertain write. Lost calendar acknowledgements recover by exact reservation readback. Ambiguous provider errors cannot trigger blind replacement writes or false confirmation.
- Definitive booking failures preserve lead/contact data and create non-executing staff callback work. Uncertain bookings retain a durable, property-scoped review visible in Today and Calls; callback capture remains available while the booking is unresolved, including during calendar read outages. Replays retry failed review persistence without booking again.
- Caller identity and requested callback evidence are separate. Hidden-number callers stay distinct in storage and dashboard selection, with call-specific links, task filtering and disabled unsupported identity edits.
- Heating-policy questions, resolved history and old-building history no longer cause inappropriate safety holds. Ongoing, unresolved or recurring heat loss stays guarded. Existing safety holds and stronger emergency rules remain protected.
- Hosted/named-account webhook verification precedes assistant routing, including missing-secret requests.
- Independent review added regressions for lost dispatch-marker replies, failed review projection, out-of-order contact completion, stale booking snapshots, and multiple booking tools in one batch.
- The full database run exposed prior maintenance/consent integration issues. Specific permission/configuration errors now survive the consent graph read. Expiry tests retain strict refusal and verify a fresh current read. Two consent lock-race fixtures now use independent database clients and reach their rollback/counter assertions.

## Verification

Final local results on September 20:

| Check | Actual result |
| --- | --- |
| `npm run check` (Node 22.23.2) | Typecheck/data validation clean; **1,499 tests passed**, zero failures or skips. |
| `npm run test:database` | **497 PostgreSQL tests passed**, zero failures or skips, using isolated disposable local databases. |
| `npm run build` | Generated dashboard/site and **17 API handlers** built; unconfigured-request smoke checks passed in both runtime modes. |
| `test/browser/voice-recovery.mjs` | **9 real Chromium checks passed** at 320, 390 and 1280px, with zero page/console errors or unexpected requests. Synthetic intercepted fixtures only. |
| `git diff --check` | Clean. |

Browser checks cover readable review cards, exact anonymous caller selection, callback actions, keyboard navigation/focus and horizontal overflow. Visual inspection caught and fixed a desktop review-card column error. Today callback links now open the requested number and preserve the exact anonymous prospect. Generated-artifact parity caught one stale bundle after a final link edit; regeneration and the final complete run above passed. Focused results overlap these totals and must not be added together.

The first application run found three older tests relying on callback-as-identity; they were updated to assert separate identity/provenance while preserving isolation assertions. The first full native run passed 490/497: five maintenance inbox failures and two broken consent test connections. These were investigated and fixed; isolated reruns passed 57 maintenance tests and 7 consent races. An initial sandbox-only native attempt could not bind loopback (EPERM); approved disposable-database runs proceeded normally.

## Release checkpoint

Implementation commit `7e7397d374b8a70fd8f1231d333e2927f3edd409` is published on `codex/atrium-quality-pass`; a remote read verified the exact hash. GitHub quality run `35533565420` / job `106138459250` completed successfully with **1,499 application tests, 497 PostgreSQL tests and the 17-handler build**. Vercel preview `66qAdHBnhKAKYVyR3RPEqJG5WAm3` is Ready from this commit (42 seconds). Production deployment [`ArUo86trL8rixC6e9tF42rs8Ux8w`](https://vercel.com/vincenttvt77-9161s-projects/ghost-building/ArUo86trL8rixC6e9tF42rs8Ux8w) rebuilt the same commit with production settings and reached **Ready in 50 seconds**, with `ghost-building.vercel.app` assigned. Verified at 19:57 UTC: the existing demo login works, the refreshed [production dashboard](https://ghost-building.vercel.app/api/dashboard) loads, and Status reports callers, calendar and call history loaded. This remains the legacy shared-login/KV runtime; managed named-account/resident activation is separate. At session start an authenticated Git fetch verified local and remote both at `9b935ab`; the previously reported GitHub publishing blocker was no longer present.

The public production health endpoint responded successfully with durable KV and configured call history. It reported backend schema fingerprint `fea94b5f3600f6764a1b803b05fc86757e91c85e9cf7a86b98abf0ca6f606c6d`. The Vercel deployment page separately verified the deployed revision above. Health and dashboard checks do not prove assistant synchronization or phone delivery. The connector lacked access to the project team; the existing signed-in browser provided deployment status without changing credentials.

No hosted migrations, credential changes, Vapi assistant edits, paid simulations, phone calls or outbound messages were performed by this slice. Tool schemas were not changed. The managed resident/maintenance features still require a separately verified hosted rollout; the repository currently contains 14 additive migrations.

## Next work for Codex / Fable

1. Verify the saved live assistant/backend fingerprint and actual phone behavior before claiming voice acceptance. Source publication, cloud checks and the production revision are verified above; phone connectivity and audio quality remain untested in this slice.
2. Add guarded reconciliation and resolution of uncertain booking reviews against actual reservation evidence. Do not close a review or repeat a write merely because someone clicked a button. Review lists also need bounded pagination before portfolio scale.
3. Verify hosted database/migration/runtime state before activating managed resident/maintenance features. Finish verified fulfillment, notifications and recovery using the existing authorization/outbox boundaries.
4. Build a provider-independent resident messaging workflow with consent, tenant routing, durable receipts, retry deduplication, attachments and human takeover before enabling Linq or Apple messaging.
5. Continue the meeting priorities: amenity scheduling, owner outcomes dashboard, PMS connector, prompt web-lead response, follow-ups, guided building onboarding, release safety checks, historical imports and security testing. These are open work, not delivered features.

## Next work for Evan / Luke

- Obtain Linq's written pricing, reseller terms, per-property number/account model and failure-recovery details; choose whether to pilot its phone-number API or Apple Messages for Business offering.
- Test the real Larkin line for 19A facts, requested tour timing, callback details and a reschedule request. Record the call ID for review.
- Select the first actual property/PMS when known and supply its approved operating rules. No PMS has been selected yet.

## Handoff rule

Fable: read AGENTS.md, AI_WORKFLOW.md and docs/agent-tasks.md from GitHub before taking work. Coordinate ownership before overlapping edits. Review the published diff and tests, and leave a reciprocal handoff at the end of your session with commits, exact checks, live versus local state, remaining limitations, owner actions and next Codex tasks. Codex must do the same on return. Preserve existing untracked coordination history; never publish secrets or caller data.


Release notes are committed separately after the implementation so this report can name the tested/deployed source commit. A later documentation-only HEAD does not mean production adopted different application code. Error-log aggregation, monitoring configuration and physical-device passkeys were not verified in this release; no claim of zero production errors is made.


## Post-release finding: truthful historical call summaries

A read-only live dashboard check exposed another confirmed defect: historical `unauthorized` results could be described as approved answers, successful lookups or zero offered slots. AT119 adds common failure classification before summary/step inference, explicit failed-step review, neutral missing-result/no-tool wording, and approved-source claims only when matching structured approval evidence exists. A real confirmed booking remains visible alongside a failed unrelated step. No caller records are altered. Nine new independent synthetic regressions cover these cases. Final local follow-up: **1,508 application tests passed**, clean types/data, successful 17-handler build and **9 real Chromium checks** at 320/390/1280. Backend and SQL are unchanged from the 497-test PostgreSQL acceptance. The follow-up publication/deployment checkpoint will identify this source separately from the first release above.
