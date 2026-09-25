# Managed property phone assistant releases

The PostgreSQL dashboard adds **Status → Review phone assistant** for current
configuration managers. Review the proposed greeting, complete leasing prompt,
nine tool definitions, webhook destination and timing changes, then explicitly
publish that review. The selected voice, transcriber, model, generation settings
and custom model endpoint are preserved. This is not voice auditioning or
a model-hosting migration. No real provider was changed during implementation.

The configuration comes from the selected property's validated, immutable published
snapshot. Name and address are required. Building-local dates use that snapshot's
validated timezone; they no longer assume New York. Mutable availability, rents,
policies and booking decisions remain behind authorized property tools. No bundled
Larkin fallback is used. This flow updates an existing, uniquely bound assistant;
it does not create assistants, buy numbers, change routing or discard editor drafts.

Managed publication replaces earlier provider knowledge attachments with the selected
property's approved Atrium tools. An existing `model.knowledgeBase` file or custom
knowledge server has no verified property provenance in this release workflow, so
it is omitted from the complete replacement model. Original provider files are not
deleted. The review explains this change before publication, and the prompt names
`answer_question` for property knowledge. A retained or reintroduced attachment
makes saved-state verification fail. A pre-existing prepared review requires a fresh
review for this policy; already dispatched releases retain their original evidence.
The legacy publisher remains separate and preserves its existing knowledge setting.

Vapi documents that a model PATCH replaces the full model object in its
[query-tool guide](https://docs.vapi.ai/knowledge-base/using-query-tool), checked
September 25, 2026. Synthetic provider tests exercise this contract; actual account
readback must still establish it before hosted acceptance. This does not authorize
knowledge held inside a separately managed custom model service; that service needs
its own property-data and retention review before a hosting trial.

## One-time deployment prerequisites

Use managed PostgreSQL runtime and exactly one active Vapi assistant binding for the
selected property. The deployment operator configures the private Vapi API key,
`VAPI_ORGANIZATION_ID`, `VAPI_SERVER_BASE_URL`, `VAPI_WEBHOOK_SECRET` and matching
vault credential ID `VAPI_WEBHOOK_CREDENTIAL_ID` privately. These are deployment
settings, not per-user login files. The provider account ID must match the assistant
returned by Vapi. Browser input cannot select an arbitrary assistant or endpoint.

The server URL is a configured HTTPS origin, not a request Host header. Preview
deployments cannot use this flow to update a live assistant. The destination's
durable health and exact current tool-contract fingerprint must pass at preparation
and again before publication. These checks do not establish that a vault secret
matches the backend, that a number routes to this assistant, or that a real phone
call succeeds. Those are separate hosted and phone acceptance steps.

The SDK adapter is pinned to `@vapi-ai/server-sdk` 2.0.1. It accesses only
`https://api.vapi.ai/assistant/{bound-id}`, disables automatic retries and redirects,
and bounds individual replies to ten seconds and 512 KiB. Errors are redacted;
provider payloads, headers and keys are not copied into operational history or UI.

## Reviewed release and uncertainty

Each review has an immutable ID, author, property/configuration/channel identity,
15-minute lifetime and canonical fingerprints of the proposed write and current
provider snapshot. Only fingerprints of raw provider settings are saved. Reusing
the same preparation ID returns its original review without extending its lifetime.
Changed property data, code, connection, provider settings or expiry require a new
review before publication. The database adapter checks current configure permission,
session, published version and the exact binding around the atomic journal update,
using the existing restricted application role and audit transaction.

Publication atomically records its dispatch identity and actor **before** invoking
Vapi. Concurrent identical requests cannot send a second provider update. There is
at most one possibly dispatched release per property assistant. A successful HTTP
write response alone is insufficient: a separate read must match every reviewed
written field and the retained voice/transcriber before the release is verified.
The stored verification is dated evidence, not perpetual synchronization or phone
acceptance. Later provider changes can invalidate it.

A duplicate publish may have loaded its review before another copy dispatched it.
If its delayed preflight then reports provider drift or an outage, Atrium rechecks
current authority and the exact review's durable journal. A dispatched or cancelled
receipt takes precedence over that stale preflight error; it is returned without
another provider write. If the review is still prepared, the original error remains
a refusal. Unconfirmed receipts stay unconfirmed, and revoked access cannot use
this recovery path. See the [concurrency correction](../reports/2026-09-25-voice-publish-race.md).

If a write or reply is lost, the dashboard checks the existing journal and offers
**Check provider result**. Recovery makes only a provider read, never another PATCH.
A mismatched or unavailable result remains unconfirmed and blocks replacement
releases. A review can be cancelled only before possible dispatch. Provider errors,
timeouts, missing acknowledgements and missing documents never imply that a write
did not occur. No automated rollback is attempted. Administrator investigation is
required when readback cannot resolve the result; do not delete its journal to
unlock publishing.

The journal retains up to 100 releases without silently pruning evidence. Reaching
that limit requires a reviewed archival extension; automatic archival is not part
of this increment. Current configuration prerequisites are also required to open
this release UI; loss of provider setup needs operator repair rather than inventing
a replacement connection. Changing a binding/configuration after dispatch does not
undo the already admitted provider operation.

## Provider concurrency boundary

Vapi's current public SDK exposes assistant updates as PATCH plus saved-state GET.
Its reviewed update DTO did not expose a conditional version/If-Match argument.
The implementation rejects changes observed since review and checks saved results,
but **cannot guarantee atomicity against someone simultaneously editing Vapi
outside Atrium**. Avoid external edits while applying a release. Unexpected
provider defaults or changed fields produce an unconfirmed result, not a false
success. Provider reconciliation and any future conditional-update support must be
verified with the account before hosted activation.

Sources checked September 24, 2026:
[Vapi update client](https://github.com/VapiAI/server-sdk-typescript/blob/main/src/api/resources/assistants/client/Client.ts),
[update DTO](https://github.com/VapiAI/server-sdk-typescript/blob/main/src/api/resources/assistants/client/requests/UpdateAssistantDto.ts),
[versioning guide](https://docs.vapi.ai/assistants/versioning/versioning-assistants).
The versioning guide describes the dashboard draft/publish lifecycle. This backend
uses the saved-assistant API; it does not claim to manage a browser editor draft.

## Verification and next work

Domain/transport tests cover single dispatch, lost replies, corruption, expiry,
source/binding drift, exact account identity, cancellation, provider error redaction
and bounded streams. Native tests use actual HTTP, signed MFA and restricted
PostgreSQL connections with a synthetic loopback provider. Chromium checks run at
320, 390 and 1280 pixels, including lost dashboard replies and reopening unresolved
work. See the dated source report for actual runs and any remaining failures.

Before a real release: accept exact-source CI and browser evidence, finish the
isolated hosted account rollout, verify provider normalization/authentication and
inbound routing, then exercise actual phone-to-tool-to-dashboard actions. A source
commit or successful mock PATCH is not evidence of a live assistant change.
AT129 production approval, paid voice trials and Vast.ai provisioning remain
separate. Preserve the original leasing goal and reciprocal Codex/Fable handoff.
