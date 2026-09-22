# Durable email submission and delivery evidence

The email adapter now runs through Atrium's existing property-authorized workflow repository and worker. It is a tested integration component, **not an enabled customer email feature**. No staff/voice command, automatic runner, credentials, verified sending domain or live provider registry is installed by this change. SMS remains separate work.

## Observable states

| Observation | Meaning |
| --- | --- |
| No provider | A detached in-memory preview only. Nothing queued or sent. |
| Durable workflow receipt | Atrium accepted an immutable intent. The provider has not necessarily received it. |
| Provider acknowledgement with UUID | Provider accepted the message; the worker saves this ID and waits for a separate verification claim. |
| Matching readback with `last_event: delivered` | The provider reports delivery for the exact saved message. This does not establish that a person read it or that it appeared in their primary inbox. |
| Unknown/malformed acknowledgement or failed readback | Unconfirmed; bounded verification proceeds to staff review, never an automatic new send. |
| Mismatched message, bounce or expired permission | Staff review. No successful delivery claim. |

`SendResult.sent` and `.delivered` are always false at submission. `accepted` refers only to provider acceptance. `NoopTransport.outbox` is a historical name for a process-local preview array, not the durable PostgreSQL outbox. `sendConfirmation` remains a legacy rendering/preview helper; its real transport refuses direct submission without a durable identity. There are no production callers of this helper in the current source.

## Admission and property boundaries

`emailWorkflowAction` validates a single-recipient message plus a receipt reference binding purpose, recipient, exact content digest, recording time and expiry. It returns a new action for `PostgresWorkflowRepository.accept`; it does not enqueue anything itself. The existing repository supplies tenant-scoped operation hashing, deduplication, original authority/configuration checks, leases and durable records.

The receipt structure is **not independent proof that a person consented**. The future command handler must obtain and persist permission from the authenticated call/staff context, link the real receipt, validate the relevant confirmed booking or current shortlist, render approved content, and then accept the action. Never accept arbitrary HTML, sender identity, consent assertions or property IDs directly from the model/browser. This adapter checks the immutable intent and receipt binding; it does not independently reload a consent registry or reservation.

`createResendEmailConnector` binds one organization/property and exact sender/reply address. An action from another scope or with different content/sender is rejected before network IO. Construct the registry server-side for the claimed property. Keep credentials outside persisted intent/input. Permission must be current at dispatch, recorded no later than action creation, and cover an interval of at most 24 hours. Subsequent delivery observation may continue after permission expires; it does not authorize a new dispatch.

## Provider contract and recovery

The existing REST adapter uses only `https://api.resend.com/emails` and UUID-qualified retrieval paths, refuses redirects, propagates cancellation, limits response bytes and redacts exception/provider bodies. It supplies the immutable scoped key in an idempotency header and includes operation/content tags. It requires a real UUID acknowledgement; a malformed successful response never becomes a fabricated message ID.

Resend documents a 24-hour idempotency window. Atrium refuses dispatch at or beyond 23 hours from the original action creation time. The connector advertises `idempotentWrites: false` to the generic worker because a time-limited provider guarantee cannot justify unbounded retries. Ambiguous submissions, crashes before saving acknowledgement and explicit operator replay remain verification-only. If the provider ID was lost, the adapter cannot resolve the email automatically and needs staff investigation. There is no “send again” recovery shortcut.

For accepted requests, the optional worker contract `verificationRequiresReference` saves the provider UUID before a later verification claim. Existing connectors keep their previous behavior. An expired/lost lease or changed origin/configuration prevents the requested settlement. Known permanent pre-effect rejections retain their actionable reason without a futile lookup.

Delivery readback must match UUID, sender, single recipient, subject, HTML, reply address, no CC/BCC, and both unique correlation tags. `sent`, delayed, opened, clicked and unknown events do not establish a delivery event in this version. A fast later tracking event can therefore require review even if actual delivery occurred. Provider event-history/webhook reconciliation is a follow-up; no inference of a human read is made. Readback errors and 404 are never proof that a previous send had no effect. Failed or unverified delivery remains visible in the Work queue when these intents are admitted into an enabled workspace.

Official sources checked September 22, 2026: [send API](https://resend.com/docs/api-reference/emails/send-email), [retrieve API](https://resend.com/docs/api-reference/emails/retrieve-email), [idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys). Real account permissions, exact provider normalization and mail-server delivery still require a controlled live acceptance test.

## Verification and remaining delivery work

Unit tests cover malformed success responses, provider error redaction, input/control validation, cancellation, response bounds, fixed URLs, consent/content/scope mismatch, expiry, status interpretation and the worker acknowledgement boundary. Native PostgreSQL tests run the actual adapter against a synthetic local HTTP provider. They exercise persisted acceptance/restart, duplicate receipts, dropped acknowledgements, operator replay, process failure before acknowledgement commit, wrong content/recipient, bounce, missing/pending records, expired permission and revocation during readback. No real emails or paid simulations are used.

Next implement trusted command admission and permission capture, approved confirmation/shortlist rendering, the scoped runner and sender binding, delivery-event reconciliation, and staff-visible status tied to the actual lead/tour. Then enable the reviewed integration on a test property with a verified sender and secure provider key; send only to an owner-approved test recipient and check the real inbox plus stored evidence. Hosted PostgreSQL activation and the separate pending production release are prerequisites for customer rollout, not implied by passing these local tests.
