# September 23 — hosted preview diagnosis and isolated setup

Coordinator/author: Codex root. Source base:
`1c408a47b66d9530c610d310b548fb6a05b1f888`; implementation branch:
`codex/at142-isolated-preview`. This report distinguishes observed hosted state
from the locally verified setup change. It is not production or phone acceptance.

## Hosted findings

The Vercel deployment `BRE1R6Et8gksSL4iGjVN3Ao2EBA9` was Ready at the exact base
commit, built in 57 seconds. Its actual dashboard displayed “Sign-in is
unavailable.” Read-only network preflight verified website HTTP 200, persistent
storage and the matching source tool contract; dashboard/call/calendar/lead
access checks returned HTTP 503. Global call history was not configured.

The initial shell preflight could not reach any endpoint in its restricted
network context. It was not interpreted as an application failure. The authorized
network retry produced the concrete HTTP results above; the browser independently
showed the sign-in failure.

Vercel's settings showed `OPS_DASHBOARD_PASSCODE` and the Vapi settings scoped to
Production. The existing KV connection variables were scoped to All Environments,
and `LEAD_WEBHOOK_URL` to Production and Preview. No values were revealed or
copied. Simply adding a preview password would therefore leave the branch linked
to live resources. No preview write or cross-environment data access was attempted;
this is configuration evidence of a risk, not a claim of observed data corruption.

The signed-in Supabase dashboard showed Atrium Demo on Free with one project.
The separate “Atrium Preview” creation form was prepared in that organization,
North Virginia, with Data API disabled. No password was entered, no project was
created and no billing/subscription setting changed. The owner was asked to
complete the secure password/create step. The Supabase connector currently lists
only the other organization, so it cannot be treated as the complete inventory.
The Vercel connector likewise returned no accessible teams; the signed-in
dashboard supplied the project evidence.

## Implementation

The hosted setup CLI now accepts explicit `purpose: "preview"` with an empty
binding list. It seeds the same dated fictional Larkin property and persisted
owner with normal grants, passkeys and database restrictions, without requiring
a Vapi assistant connection. The private output still contains the five runtime
settings; it truthfully reports that no voice bindings were verified.

Preview purpose is part of the immutable bootstrap manifest. The helper refuses
provider bindings, a switch to demo purpose, and unexpected subsequently added
channels. It preserves those records when refusing. Reruns preserve passwords,
passkeys and operational records. Existing demo defaults/manifests remain
unchanged. No migration file or runtime authorization rule was changed. The
temporary content-validator actor is never persisted or usable by a channel.

This safeguard governs provisioning; it does not replace administrator controls,
environment isolation or deployment review. The new [preview procedure](../docs/hosted-preview.md)
specifies a separate database, stable branch origin, branch-scoped configuration,
removal of inherited production capabilities and actual hosted acceptance.

## Verification

- Focused private configuration checks: **7 passed**.
- Existing hosted bootstrap plus new native preview tests: **15 passed**.
- `npm run check`: **1,741 passed**, typecheck and data validation passed.
- Complete isolated PostgreSQL suite: **612 passed**, including the six new
  preview cases; completed in 195 seconds.
- `npm run build`: **22 API handlers** imported and refused unconfigured requests
  in both runtime modes.
- `git diff --check`: passed. Documentation links and setup instructions reviewed.

The six new native cases cover invalid purpose/bindings before IO, interrupted
seed rollback/resumption, actual local HTTP login and software-authenticator
passkey proof, foreign-property refusal, restricted runtime roles, idempotent
reruns preserving state, refusal to convert purpose and detection of unexpected
channel activation. The HTTP test renders the real compiled dashboard after
authentication. No visual components changed, so no new visual/browser suite was
run. A software authenticator does not prove a physical device enrollment.

Evidence logs are private local files under `/private/tmp/at142-*`. No real
provider calls, emails, recordings or hosted database mutations occurred.
Independent review, current cloud CI and hosted preview acceptance remain separate.

## Owner to-dos

1. Complete the prepared free “Atrium Preview” project form, save its strong
   database password privately and reply “created.” Do not send the password in
   chat. Secure setup and Vercel secret entry remain one-time administrator work.
2. Complete your own first preview passkey enrollment when the hosted portal is
   ready. Confirm the presentation's intended workflows before calling it ready.
3. Provide permissioned representative call examples, choose a voice after an
   audition, and set a bounded voice/hosting trial budget. These remain separate
   from the preview database work.

## Codex/Fable next actions and reciprocal handoff

1. Inspect the current task board and exact published revision. Preserve dirty
   calendar work in the original checkout. This branch includes the previously
   published recording and voice-confirmation source; deployment is separate.
2. After project creation, verify the actual project/connection endpoint and
   isolated private inputs. Provision through the reviewed preview path, verify
   restricted roles/TLS/current migrations, and record actual hosted results.
3. Prepare a concrete Vercel configuration diff: the chosen stable Preview branch
   gets its own five settings; production KV and lead-webhook inheritance must be
   removed from previews without changing Production. Follow required secret
   entry handoff. Rebuild Preview, then test actual sign-in, desktop/mobile flows,
   persistence and isolation. Do not claim the prepared form is a working preview.
4. Keep AT-129's production-promotion decision separate. Automatic review rejected
   Force Promote earlier; its explicit owner approval remains pending. No other
   branch, API or deployment path should bypass that rejection.
5. Next voice milestone remains a fresh successful phone-to-tool-to-dashboard
   baseline, followed by controlled voice/model comparisons. No new voice, Vast
   instance, assistant publication or measured latency improvement is delivered
   by this turn.

End the next session with a reciprocal handoff containing exact source/deployment
IDs, real check outcomes, limitations, owner actions and next-agent work. The full
leasing goal remains active and unproven; source and synthetic tests do not
establish the held-out 95% routine-success target or live pilot readiness.
