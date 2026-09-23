# Website callback implementation and handoff — September 23, 2026

AT-139 adds the website-to-leasing call flow in source. A visitor can explicitly
request one AI callback, recover its receipt after a lost response, and inspect a
dated status. Staff can see the request/contact and check the same call in the
property’s Work queue. The implementation uses Vapi’s documented call interface;
no live assistant, voice, phone number or hosting configuration was changed.

Branch: `codex/at139-website-callback`, based on
`91415f29b23cdcfa4f86c16fb29cb64b93d0442f` (AT-138).
The commit containing this report is the implementation handoff. Root’s original
uncommitted calendar work and other agents’ coordination files were preserved.
The full leasing product goal remains active.

## What changed

- Embeddable navy/white callback form with an unchecked explicit AI/recording
  permission, property calling hours, server-verified Turnstile challenge and
  mobile/keyboard support. Session storage keeps only an opaque receipt, not the
  visitor’s name/phone. Reloading or losing an HTTP acknowledgement does not redial.
- Exact published property/site/origin and registered channel bindings, a reviewed
  Vapi assistant version and phone resource, and bounded property/network/phone
  request limits. The website channel does not receive broader SQL privileges.
- Atomic permission/receipt/budget/action persistence; durable dispatch-before-I/O;
  one provider POST; bounded exact call readback. Provider idempotency is not assumed.
  Uncertain submissions and mismatched responses never cause an automatic redial.
- A short provider scheduling window, capped at two minutes and before property
  closure, plus a five-minute call duration limit. The initiation target is about
  15 seconds when ready; live latency and provider deadline enforcement are unverified.
- Staff-only name/phone projection and a verification-only call control, with frozen
  property scope, permission and revision checks. Scheduled, queued, ringing,
  in-progress, forwarding and ended are separate from booking/conversation outcomes.
- Setup/activation guidance in [website-callbacks.md](../docs/website-callbacks.md).
  The Larkin website’s widget ID remains empty until reviewed activation. Legacy
  mode refuses the callback endpoints. No production schedule or background dialer
  was installed, and no live calls or paid simulations were run.

## Validation

Final local results with Node22:

| Check | Actual result |
| --- | --- |
| `npm run check` | 1,726 tests passed; typecheck and property-data validation passed. |
| `node --test --test-concurrency=2 'test/database/*.test.mjs'` | 573 tests passed, zero failed, about199 seconds, real disposable PostgreSQL. |
| `npm run build` | Website/dashboard generated;21 API handlers imported and refused incomplete setup in both runtime modes. |
| `node test/browser/website-callbacks.mjs` | Six Chromium scenario groups passed at320/390/768/1280; two synthetic call submissions, zero real calls. |
| `git diff --check` | Passed. |

The callback-specific coverage includes nine domain/transport cases, seventeen
native HTTP/database cases and two additional portal cases. Root inspected the
form and callback screenshots. The final browser run followed a selector-only
correction: the same ringing sentence correctly appeared in both list and detail,
so the assertion now targets the selected-action panel. No application change was
needed for that test fix. Independent review, cloud CI and live acceptance have not
been performed for this branch.

Meaningful cases cover concurrent identical requests, repeated phone numbers,
network budgets, missing/forged permission, incorrect challenge hostname, foreign
origins/properties, route revocation during readback, changed publication, closed
hours/DST, transaction rollback, dropped provider and browser responses, bounded
payloads, stale revisions, viewer restrictions and no duplicate provider writes.
The actual local Vapi webhook accepts the synthetic outgoing assistant’s contact
tool and retains the finished lead in the authorized property. That is local
protocol evidence, not a real phone/audio test.

The browser harness uses actual Chromium, HTTP handlers and disposable PostgreSQL,
with a synthetic website origin/proxy and challenge script. It does not test real
DNS/TLS/CORS deployment, Cloudflare bot protection, provider credit or telephony.
The calling service and challenge service are loopback fixtures; all names,
numbers, organization IDs and secrets in tests are synthetic.

Early checks exposed and corrected a fixture’s attempted mutation of immutable
channel identity, incorrect test column names, and an application assumption that
a website channel could list voice bindings. The final implementation resolves
and validates the published voice channel through the existing authenticator.
A portal assertion also needed updating when the Work queue’s capability copy
expanded beyond email. Review additionally added the provider deadline and a
bounded 1 MiB call read limit for responses containing conversation artifacts.
Initial failed/unconfigured/intermediate checks are not represented as passes.

## Remaining work and owner to-dos

1. Approve/complete the managed-runtime release and property activation separately.
   AT-129’s production promotion approval remains pending; this branch is not a
   workaround. Historical production/credit observations were not reverified here.
2. Confirm property calling hours, exact website origin, reviewed assistant version,
   outbound number, disclosure/recording terms, destination restrictions and spend
   limits. Configure the provider/challenge credentials securely once.
3. Fund Vapi credit and provide a permitted live recipient. Verify the exact pinned
   version’s webhook/tool compatibility and scheduled-start deadline before enabling
   the public widget. A CAPTCHA is not phone-number ownership verification.
4. Choose the replacement voice by audition and set a bounded Vast.ai experiment
   budget if desired. Hosting/voice evaluation remains independent; this change
   neither selects a voice nor claims a latency improvement.
5. Provide permissioned representative leasing calls and verified property data for
   the broader held-out pilot evaluation.

## Next agent / Fable handoff

Review this branch, its callback guide, the HTTP/domain code and failure tests.
Distinguish source acceptance, synthetic protocol acceptance and live acceptance.
The feature deliberately has no unattended first-dispatch recovery: if a process
fails after saving permission but before provider dispatch, the request remains
visible for staff review. It cannot become an unexpected later call. Call-state
checks do not dial. Changed/expired authority holds earlier work for review.

After approved managed activation, verify one permissioned real website request
through ringing, conversation, tools, lead/calendar results and any confirmation.
Measure actual website-to-call-start timing and provider refusal/outage behavior.
Only then claim live readiness. Continue the held-out voice/latency evaluation,
controlled pilot onboarding and the remaining broader product requirements.

End your next session with a reciprocal handoff: exact branch/commit/deployment,
changes, checks and failures, open risks, owner to-dos and next-agent to-dos. Preserve
any uncommitted work belonging to other agents.
