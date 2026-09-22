# Durable email submission and delivery evidence

The email adapter runs through Atrium's existing property-authorized workflow repository and worker. The managed PostgreSQL calendar now includes a staff **Email confirmation** flow for an exact saved tour. It is implemented and locally tested, **not enabled for customer delivery**. A reviewed property sender and securely configured provider key are required. No automatic runner, voice permission flow or live sending domain is installed by this change. SMS remains separate work.

## Staff tour confirmations

Open a saved tour in Calendar and choose **Email confirmation**. Staff with `operate` access can review the saved recipient, property, apartment and local tour time. A missing sender/provider configuration shows a preview with sending disabled. A tour without an email or exact start/end time, a past/cancelled tour, a pending booking/reschedule review, an emergency hold or an overlapping building/unit hold cannot produce an actionable confirmation. Stored preparation/cleanup intervals are included when checking holds.

When sending is configured, the operator must attest that the prospect agreed to receive this exact confirmation at the displayed address. **Save permission and send** records permission and the durable workflow atomically, then requests processing of that one action. Another operator or a double click shares the same saved confirmation. A changed tour requires a new preview and permission. The server derives recipient, subject, body, sender and action identity; the browser cannot choose arbitrary email content or destinations.

Provider acceptance displays **Delivery is not yet verified**. **Check delivery** reconciles the same email with provider evidence. Reopening the dialog retains the saved result. A lost browser response requires reloading the saved confirmation before proceeding; it does not create a new send. The Work queue retains the workflow and review-needed states. There is no background runner: staff must return to check delivery, and uncertain submissions with no saved provider ID may require administrator investigation.

`GET /api/tour-confirmations?externalId=…` provides the scoped preview. Same-origin JSON `POST` supports strict `queue` and `process` commands. Persisted staff authentication, current `operate` permission, property/configuration headers and final scope revalidation apply. Legacy mode returns 404; this feature does not change the hosted shared-passcode demo. Calendar admission takes the same property lock as booking mutation and commits permission, receipt, action and outbox together. Manual processing claims only the selected action, leaving unrelated queued work untouched.

Immediately before provider submission, Atrium reloads the tour and refuses known changes or holds. This is a point-in-time check, not an atomic transaction with an external email provider; a later reschedule can still follow a valid send. No network request runs under the calendar lock. Permission expires one hour after staff admission. The checkbox records the authenticated operator's assertion, not independent proof of the prospect's agreement.

The dialog previews the current future reservation. Older versions and confirmations for past/cancelled tours remain workflow history rather than an email history tab. Existing saved email addresses are required; editing the recipient is outside this flow. A configuration-version change, expired sender review or revoked original operator can prevent processing; administrators must investigate rather than fabricate a fresh receipt or resend.

## Property setup (not activated)

A configuration publisher must review and publish this optional property field with the exact organization/property and authorized sender. No UI for editing this field or automatic domain verification is included. Provider account/domain access must be verified separately; store `RESEND_API_KEY` only in the deployment secret store. This is deployment setup, never a login requirement.

```json
{
  "tourConfirmationEmail": {
    "provider": "resend",
    "organizationId": "organization-example",
    "propertyId": "property-example",
    "from": "Leasing <leasing@example.test>",
    "replyTo": "leasing@example.test",
    "reviewExpiresAt": "2026-09-29T12:00:00Z"
  }
}
```

This is a synthetic example, not a usable sending identity. The review must be future-dated and no more than 30 days away. Invalid, missing, expired or foreign bindings disable sending. Do not copy example dates into a deployment without a fresh review. Binding freshness currently gates both staff dispatch and verification; renew/review configuration before attempting recovery after expiry.

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

The receipt structure is **not independent proof that a person consented**. The staff tour handler now persists an authenticated operator's permission attestation with the exact reservation/message digest and links it to the workflow. Any future voice/shortlist command must separately obtain and persist permission from its authenticated interaction, validate current source data and render approved content. Never accept arbitrary HTML, sender identities, model-generated consent evidence or browser-supplied property ownership. The adapter checks immutable intent and receipt binding; reservation revalidation belongs to the command/connector wrapper.

`createResendEmailConnector` binds one organization/property and exact sender/reply address. An action from another scope or with different content/sender is rejected before network IO. Construct the registry server-side for the claimed property. Keep credentials outside persisted intent/input. Permission must be current at dispatch, recorded no later than action creation, and cover an interval of at most 24 hours. Subsequent delivery observation may continue after permission expires; it does not authorize a new dispatch.

## Provider contract and recovery

The existing REST adapter uses only `https://api.resend.com/emails` and UUID-qualified retrieval paths, refuses redirects, propagates cancellation, limits response bytes and redacts exception/provider bodies. It supplies the immutable scoped key in an idempotency header and includes operation/content tags. It requires a real UUID acknowledgement; a malformed successful response never becomes a fabricated message ID.

Resend documents a 24-hour idempotency window. Atrium refuses dispatch at or beyond 23 hours from the original action creation time. The connector advertises `idempotentWrites: false` to the generic worker because a time-limited provider guarantee cannot justify unbounded retries. Ambiguous submissions, crashes before saving acknowledgement and explicit operator replay remain verification-only. If the provider ID was lost, the adapter cannot resolve the email automatically and needs staff investigation. There is no “send again” recovery shortcut.

For accepted requests, the optional worker contract `verificationRequiresReference` saves the provider UUID before a later verification claim. Existing connectors keep their previous behavior. An expired/lost lease or changed origin/configuration prevents the requested settlement. Known permanent pre-effect rejections retain their actionable reason without a futile lookup.

Delivery readback must match UUID, sender, single recipient, subject, HTML, reply address, no CC/BCC, and both unique correlation tags. `sent`, delayed, opened, clicked and unknown events do not establish a delivery event in this version. A fast later tracking event can therefore require review even if actual delivery occurred. Provider event-history/webhook reconciliation is a follow-up; no inference of a human read is made. Readback errors and 404 are never proof that a previous send had no effect. Failed or unverified delivery remains visible in the Work queue when these intents are admitted into an enabled workspace.

Official sources checked September 22, 2026: [send API](https://resend.com/docs/api-reference/emails/send-email), [retrieve API](https://resend.com/docs/api-reference/emails/retrieve-email), [idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys). Real account permissions, exact provider normalization and mail-server delivery still require a controlled live acceptance test.

## Verification and remaining delivery work

Unit tests cover malformed success responses, provider error redaction, input/control validation, cancellation, response bounds, fixed URLs, consent/content/scope mismatch, expiry, status interpretation and the worker acknowledgement boundary. Native PostgreSQL tests run the actual adapter against a synthetic local HTTP provider. They exercise persisted acceptance/restart, duplicate receipts, dropped acknowledgements, operator replay, process failure before acknowledgement commit, wrong content/recipient, bounce, missing/pending records, expired permission and revocation during readback. No real emails or paid simulations are used.

The staff flow adds real local HTTP/database tests for authorization, property isolation, stale reservations, transactional rollback, simultaneous operators, targeted/concurrent processing and lost acknowledgements. Chromium checks exercise phone/desktop layouts, keyboard operation, preview-only readiness, delivered readback, dropped browser responses and stale forms. Tests use synthetic recipients and providers; no real email is sent.

Next implement permissioned voice/shortlist admission, a reviewed scoped runner, delivery-event reconciliation and historical email visibility. Enable the staff integration only on an approved test property with a verified sender and secure provider key; send only to an owner-approved test recipient and check the real inbox plus stored evidence. Hosted PostgreSQL activation and the separate pending production release are prerequisites for customer rollout, not implied by passing local tests.
