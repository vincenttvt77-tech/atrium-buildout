# ADR 0015: Verify an existing email after the call ends

Status: proposed architecture, implemented and locally tested on the AT-138 feature branch; integration and live activation pending. Decision owner: Atrium maintainer.

A caller should not need to stay on the phone while an email provider records delivery. Provider acceptance is distinct from delivery. A worker must also survive missing acknowledgements, concurrent invocations and permission changes without sending a duplicate.

Use the existing property-scoped durable outbox and fenced worker. Add an atomic verification-only claim constraint and prohibit that mode from producing a dispatch retry. The email reconciliation connector exposes only retrieval; its dispatch method refuses. Even an authoritative absence does not authorize another send. Preserve the original actor, configuration, content and consent bindings. Closing a call alone does not revoke permission to observe an already submitted message.

Resolve an authenticated scheduler through a registered `email-reconciler` property channel plus a separate expiring published opt-in. Authenticate its deployment secret before runtime/tenant lookup. Never grant a global database credential or trust organization/property IDs in a scheduler payload. Each invocation processes at most five due email candidates in one property; future portfolio orchestration must retain these boundaries. Reuse existing schema and authorization rather than create an additional queue or transient identity system.

Give staff with `operate` permission a same-origin, version-bound check for one email. Keep administrator recovery separate, and retain the distinction between queue state, acceptance and delivery in the UI. Expose only a curated projection, omitting message bodies and provider identities. Unknown browser results require saved-state recovery. Mobile labels wrap within the same work-queue design.

Tradeoffs: this is pull-based readback, not complete provider event history. A provider's latest tracking event can obscure an earlier delivery event. A lost provider ID cannot be recovered automatically. Revoked original authority or changed configuration holds work rather than guessing continued permission. The worker does not dispatch first sends, repair recipient addresses, re-consent users, send marketing or reset verification limits. A global cron secret is a deployment trust boundary; runner IDs alone grant nothing. Scaling beyond bounded per-property scheduling requires reviewed orchestration, lag metrics and provisioning, not removing tenant checks.

No cron entry, hosted migration, domain/key, live assistant change or production promotion is part of this decision. Activation and real phone-to-inbox evidence remain explicit release work. See [delivery contract and setup](../email-delivery.md) for configuration, limits, provider evidence and scheduling references.
