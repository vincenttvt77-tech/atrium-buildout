# Durable email submission and delivery evidence

The email adapter runs through Atrium's existing property-authorized workflow repository and worker. The managed PostgreSQL calendar includes a staff **Email confirmation** flow for an exact saved tour. The voice handler also implements permissioned apartment-shortlist and saved-tour confirmation emails. These are **not enabled for customer delivery** by source publication. Reviewed property senders, a secure provider key and managed runtime activation are required; voice also needs tool/prompt publication and channel acceptance. The source includes a bounded verification-only runner; no schedule or live sending domain is installed by these changes. SMS remains separate work.

## Permissioned voice shortlist email

After a successful availability lookup and saved caller email, the new `email_shortlist` function supports `prepare`, `send` and `status`. Only an authenticated Vapi channel with current property authority can invoke it. It is disabled in legacy mode or without both a compatible `publicShortlistWebsite` and a reviewed `voiceShortlistEmail` sender. Configure the latter with the exact same six-field sender shape shown below for `tourConfirmationEmail`, but under its own property key. Enabling staff tour email does **not** enable voice email.

Preparation saves the latest server-produced shortlist (at most five available units), exact message/recipient, current property version, a five-minute offer and a conversation-history boundary. It returns an opaque offer ID and an email-address read-back question. The model supplies no URL, HTML, sender, recipient or consent boolean to this tool. A new preparation replaces an unaccepted offer, including after repeating the same search. A new search without results clears the eligible shortlist.

To send, the caller must have heard that exact question and then clearly agreed. The backend reads `message.artifact.messages` from the authenticated webhook, not from function arguments. It checks the unchanged history prefix, a newly spoken matching question and the latest explicit affirmative user reply. Refusals, corrections, question-marked/unclear replies, missing or filtered history and model-generated permission claims fail closed. The persisted evidence is a digest of that question/reply and history, tied to the exact content/recipient; raw full transcripts are not copied into this workflow. Vapi speech recognition and conversation artifacts remain trusted observations, **not verification of caller identity or ownership of an email account**. Only public apartment information is sent. Exact read-back/chunking behavior still needs actual phone acceptance; changed or unavailable artifacts require staff follow-up rather than guessing consent.

Permission, action, receipt, outbox and the call's single accepted email record commit in one scoped transaction. It checks the active admitted tool, current call, configuration, latest shortlist, destination and safety hold. Then a bounded worker attempts this action outside the transaction. Immediately before the first provider write it checks the current call/contact/shortlist, inventory and safety again. No operation can atomically cover a later external send and a later caller correction. One email action per call is allowed; retries recover that same action and cannot silently create a replacement.

`send` returns queued, accepted, unconfirmed, review-needed or delivered evidence. `status` can verify an already dispatched email; it cannot initiate a queued first send. `prepare` after an accepted request returns its existing status without processing or replacing it. Verification uses the existing exact provider readback and can continue after the five-minute permission expires. An unknown submission is never blindly resent. Sender review and original channel/configuration authority still gate recovery.

The initial send attempts submission during the tool request, and a later same-call status request can verify it. The post-call reconciliation endpoint below and staff Work queue control can check existing dispatches after hangup. Until a reviewed scheduler is activated, unattended delivery checks do not run. A provider acknowledgement is never reported as delivery. No automatic marketing, SMS, tour confirmation, call transfer or website-triggered callback is added by this tool.

The source tool contract now has nine function tools, including the separate tour confirmation capability below, and its fingerprint differs from the earlier published assistant. Source changes are **not** Vapi publication. Keep the existing assistant/draft unchanged until the managed backend, reviewed property settings, provider access and exact tool/prompt release have passed a controlled real-channel test. Do not publish these instructions onto an older backend.

Protocol sources checked September 22, 2026: Vapi's [tool-call server message](https://raw.githubusercontent.com/VapiAI/server-sdk-typescript/main/src/api/types/ServerMessageToolCalls.ts) provides a live artifact; its [artifact schema](https://raw.githubusercontent.com/VapiAI/server-sdk-typescript/main/src/api/types/Artifact.ts) exposes spoken message history. Native [user](https://raw.githubusercontent.com/VapiAI/server-sdk-typescript/main/src/api/types/UserMessage.ts) and [bot](https://raw.githubusercontent.com/VapiAI/server-sdk-typescript/main/src/api/types/BotMessage.ts) message contracts are used for the permission comparison. No network lookup occurs inside the permission decision.

## Permissioned voice tour confirmation

After a successful booking read-back, `email_tour_confirmation` supports `prepare`,
`send` and `status`. The backend selects the current call's confirmed reservation;
the model supplies no booking ID, recipient, message, property or permission flag.
The saved calendar reservation must belong to this call and match its selected time,
unit and saved email. Missing or corrected email details after booking require staff
review; do not create another reservation to change contact details. Booking remains
possible without an email. An unconfirmed, cancelled, past, blocked or review-held
tour cannot receive a confirmation through this command.

Preparation binds the exact rendered confirmation, recipient, booking revision,
property version, five-minute expiry and conversation-history boundary. The caller
must hear the returned date/time/address question and clearly agree in a new
question/reply pair, using the same authenticated artifact checks as shortlist email.
This is evidence of a spoken request, not caller identity or email-account ownership.
Only the public tour information saved in this call is eligible; it cannot retrieve
an arbitrary previous caller's booking.

Voice requires the ordinary reviewed `tourConfirmationEmail` sender plus this
separate published opt-in, with an exact property match and review at most 30 days
in the future. Enabling staff email alone does not enable voice sending:

```json
{
  "voiceTourConfirmation": {
    "enabled": true,
    "organizationId": "organization-example",
    "propertyId": "property-example",
    "reviewExpiresAt": "2026-09-29T12:00:00Z"
  }
}
```

These are synthetic IDs/dates, not deployment configuration. No new credentials or
migration are required beyond the existing managed email setup. The opt-in is not a
substitute for domain verification, tool/prompt publication or a real phone test.

Voice and staff admission serialize under the same property calendar lock and share
one confirmation record for the exact booking/content/configuration revision. Consent,
receipt, action, outbox and that record commit atomically. Existing staff records
remain compatible; new voice records identify their original channel authority.
The Calendar confirmation dialog reads/processes that same action, and the Work queue
and post-call reconciler can inspect its existing provider dispatch.

Only the newly accepted voice request attempts first dispatch. Replayed sends,
status checks and new preparation cannot start a saved-but-unstarted request or create
a replacement. Staff may explicitly process the same queued confirmation. The call,
tour, sender and permission are checked again before the bounded provider write.
These checks cannot atomically cover a later caller change and an external send.

Provider acceptance remains different from delivery. Lost acknowledgements remain
unconfirmed; matching provider readback is required for a delivered claim. After
hangup, staff or an activated reconciliation worker can verify an already dispatched
email; a delayed voice tool cannot grant new permission. Changed tour content needs
a new reviewed confirmation/permission rather than repurposing the previous action.
The new tool does not reschedule/cancel, send SMS, enable marketing or prove faster
voice responses. [AT-141 evidence and remaining work](../reports/2026-09-23-voice-tour-confirmation.md).

## Staff tour confirmations

Open a saved tour in Calendar and choose **Email confirmation**. Staff with `operate` access can review the saved recipient, property, apartment and local tour time. A missing sender/provider configuration shows a preview with sending disabled. A tour without an email or exact start/end time, a past/cancelled tour, a pending booking/reschedule review, an emergency hold or an overlapping building/unit hold cannot produce an actionable confirmation. Stored preparation/cleanup intervals are included when checking holds.

When sending is configured, the operator must attest that the prospect agreed to receive this exact confirmation at the displayed address. **Save permission and send** records permission and the durable workflow atomically, then requests processing of that one action. Another operator or a double click shares the same saved confirmation. A changed tour requires a new preview and permission. The server derives recipient, subject, body, sender and action identity; the browser cannot choose arbitrary email content or destinations.

Provider acceptance displays **Delivery is not yet verified**. **Check delivery** reconciles the same email with provider evidence. Reopening the dialog retains the saved result. A lost browser response requires reloading the saved confirmation before proceeding; it does not create a new send. The Work queue retains the workflow and review-needed states. There is no background runner: staff must return to check delivery, and uncertain submissions with no saved provider ID may require administrator investigation.

`GET /api/tour-confirmations?externalId=…` provides the scoped preview. Same-origin JSON `POST` supports strict `queue` and `process` commands. Persisted staff authentication, current `operate` permission, property/configuration headers and final scope revalidation apply. Legacy mode returns 404; this feature does not change the hosted shared-passcode demo. Calendar admission takes the same property lock as booking mutation and commits permission, receipt, action and outbox together. Manual processing claims only the selected action, leaving unrelated queued work untouched.

Immediately before provider submission, Atrium reloads the tour and refuses known changes or holds. This is a point-in-time check, not an atomic transaction with an external email provider; a later reschedule can still follow a valid send. No network request runs under the calendar lock. Permission expires one hour after staff admission. The checkbox records the authenticated operator's assertion, not independent proof of the prospect's agreement.

The dialog previews the current future reservation. Older versions and confirmations for past/cancelled tours remain workflow history rather than an email history tab. Existing saved email addresses are required; editing the recipient is outside this flow. A configuration-version change, expired sender review or revoked original operator can prevent processing; administrators must investigate rather than fabricate a fresh receipt or resend.

## Property setup (not activated)

Staff cancellation emails use **Calendar → Cancellations → saved cancellation →
Review cancellation email**. They require their own `property.tourCancellationEmail`
binding, with the exact six-field shape below under that key. Enabling
`tourConfirmationEmail` or `voiceShortlistEmail` does not enable cancellation email.
The strict staff API binds one cancellation, saved recipient, immutable copy and
fresh operator-attested permission to one durable action. It omits the internal
reason and never reserves a replacement tour. See [cancellation email](tour-cancellation.md#cancellation-email)
for duplicate prevention, uncertain-result recovery and current limits.

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

The receipt structure is **not independent proof that a person consented**. The staff tour handler persists an authenticated operator's permission attestation. The voice shortlist and tour confirmation handlers independently check the authenticated question/reply history described above. Both bind exact content and scope. Never accept arbitrary HTML, sender identities, model-generated consent evidence or browser-supplied property ownership. The adapter checks immutable intent and receipt binding; current booking/shortlist validation belongs to the command/connector wrapper.

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

Voice HTTP/database tests also exercise exact permission, corrections, stale/changed source, tenant/channel boundaries, concurrent tools, atomic rollback, lost provider/browser acknowledgements, queued status without dispatch and closed/emergency calls. These are synthetic-provider results, not real Vapi speech or inbox evidence.

Next activate a reviewed scoped schedule in an approved environment, add authenticated delivery-event history and link email actions directly to their originating call/tour. The Work queue now exposes bounded delivery status and staff checks. Enable integrations only on an approved test property with a verified sender and secure provider key; send only to an owner-approved test recipient and check the real inbox plus stored evidence. Hosted PostgreSQL activation and the separate pending production release are prerequisites for customer rollout, not implied by passing local tests.


## Post-call delivery checks (AT-138; not activated)

`GET /api/email-reconciliation?runnerId=<registered-worker>` is a scheduler-facing entry point. It verifies the exact `Authorization: Bearer <CRON_SECRET>` before constructing the runtime or looking up any property. Atrium requires a non-whitespace ASCII secret of 32–256 characters. Configure it once in the deployment secret store, not in a staff login or URL. The runner ID is not a credential: it selects an active `channel_bindings` record whose provider is `email-reconciler`, with `read` and `operate` capabilities and an exact organization/property. No user-supplied tenant, recipient, provider reference, message body or connector override is accepted.

The selected property must separately publish this reviewed opt-in alongside its purpose-specific sender:

```json
{
  "emailReconciliation": {
    "enabled": true,
    "organizationId": "organization-example",
    "propertyId": "property-example",
    "runnerId": "reviewed-property-worker",
    "reviewExpiresAt": "2026-09-29T12:00:00Z"
  }
}
```

This is an illustrative configuration, not a provisioned account or schedule. The review deadline must be in the future and within 30 days. Publication must precede admitting the emails to be checked: a later configuration version holds older work for review. This increment reuses the existing registered-channel and workflow schema; it adds no database migration or portfolio-wide database privilege. A reviewed provisioning workflow and portfolio scheduling remain separate work.

Each invocation selects at most five oldest due `leasing_email`/`resend_email_v1` actions with a possible prior dispatch. It claims each exact action under a database row lock. First sends, future retries, active leases, held work, completed actions and other connectors stay untouched. Expired leases may resume verification. Each provider read has a two-second bound inside a 15-second lease; database work adds time. Backoff is 30–60 seconds initially, then grows to a one-hour ceiling, with the existing per-generation attempt bound. Overlapping invocations rely on durable claim fences; missing acknowledgements never permit a new send. Original actor authority and the original configuration are checked before and after provider IO. A sender whose review has expired performs no provider lookup and consumes bounded verification attempts, without blocking eligible later emails.

`POST /api/email-reconciliation` is separate staff access. It requires a signed-in operator, same-origin JSON, frozen property/configuration headers and exactly `{actionId, expectedRevision}`. It can inspect/verify one possibly dispatched email and cannot start a queued first send or clear a review hold. The expected revision is checked again under the claim lock. The **Work queue → All work / In progress → Check email delivery** control uses this route. Read-only users see status but cannot check; administrators retain separately audited requeue controls. Unknown responses require reloading saved state. No browser response contains recipients, HTML, provider references or credentials.

The UI distinguishes not sent, provider accepted, submission unconfirmed, delivery verified and review needed. “Delivered” requires exact readback evidence; it never means a human read the message. This is action history in the Work queue, not yet a contact-level correspondence timeline. A returned `inspected` count is the number of candidates examined, not proof of that many network requests or completed deliveries; a concurrent invocation may already own the lease.

Before enabling an unattended schedule, verify managed runtime, exact sender/domain access, provider credential, registered runner, current property publication, schedule cadence, endpoint duration, observability and one permissioned real inbox result. No cron entry has been added to `vercel.json`. Do not enable a schedule against the legacy production runtime or use this work to bypass the pending production release approval.

Vercel sends `CRON_SECRET` as a bearer header. Its schedule delivery can be missed or duplicated, concurrent runs can overlap, and failed invocations are not automatically retried. Durable queue state and subsequent invocations handle recovery here; health/lag alerting still needs operational wiring. [Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs) (checked September 23, 2026).

Vercel currently lists daily, imprecise execution on Hobby and minute-level scheduling on Pro/Enterprise, with function usage charges/limits applying. Do not promise prompt post-call checks on the free daily schedule; select a funded cadence or separately reviewed scheduler during activation. [Vercel cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) (checked September 23, 2026).


## Contact corrections after booking (AT-146)

For a managed PostgreSQL voice call, `capture_contact` can add or correct the name
and email on the future confirmed reservation created by that call. It commits
the calendar contact and call contact in one authorized property transaction.
It preserves the reservation ID, scheduling revision, time, unit, occupancy and
original caller identity. A volunteered callback number remains separate evidence;
it does not replace the caller or calendar identity. No contact update sends a
message or recalls/redirects one already submitted.

The update requires exact original-call and reservation evidence, admitted work,
unchanged prior contacts and matching saved times/unit. A concurrent human correction,
reschedule, duplicate ID, review/safety hold, closed call or wrong tenant/channel
cannot be overwritten. An already admitted correction can finish while the call is
ending; its corrected details then project into the lead. A failed atomic save
cannot leave only one of the calendar/call updated. Same-tool replay cannot undo
a newer correction. Legacy KV calls retain contact capture only; this synchronized
write depends on PostgreSQL transactions.

After a correction, prepare a new email offer and ask its exact permission question
again. Old permission cannot authorize the new recipient/content. One reservation
scheduling revision remains one confirmation purpose, even if its recipient, name,
property configuration or message content changes. Staff and voice admission share
an indexed history under the calendar lock. An earlier queued, dispatched, unknown,
delivered or review-held confirmation blocks an automatic replacement. The staff
preview explains this and removes the new-send permission control. Voice can still
check the original offer; its response explicitly names the original saved email
recipient. Changes to contact details never retarget its immutable workflow input.

A configuration-authorized operator can cancel an undispatched action through the
existing Work queue. After such a cancellation, changed details may receive a fresh
permissioned confirmation. Possibly dispatched actions cannot use this cancellation
path. An explicit resend after dispatch, with its own reviewed authority and recovery
contract, is future work; do not bypass the hold by inventing another reservation.
A genuinely changed scheduling revision may have its own confirmation. Legacy email
records without a known scheduling revision conservatively require review before
a different confirmation; they are not relabeled or silently deleted. The per-tour
index is written atomically with the record, receipt and action. Exact-reservation, property-scoped database discovery also checks older records
that have no index entry, including delayed writes from an older release; unrelated
history is not loaded one document at a time.

This is original-call contact correction, not caller identity verification or a
staff contact editor. A returning caller's request to alter an older tour remains
staff review. These changes add no schema migration or live voice publication.
Local HTTP/PostgreSQL and browser tests use synthetic callers/providers; real
phone and inbox acceptance remains required during controlled activation.

## Reviewing an earlier tour email after a contact correction (AT-149)

The staff confirmation dialog now shows the **original recipient**, recorded
status and a **Review saved email** link when a confirmation already exists for
the same reservation revision with different details. That link opens exactly
that property-scoped action in the Work queue, even when it is finished or outside
the first page. Missing, malformed, foreign or mismatched action IDs show a
failure without selecting another action. Selecting an ordinary filter returns
to the regular queue. Current authorization, revision-checked recovery and
verification-only delivery controls still apply.

If the current tour email was cleared, the earlier action remains reviewable
without constructing a sendable draft. The immutable earlier message keeps its
original recipient, content, permission and delivery evidence. A staff contact
edit neither redirects it nor authorizes a replacement. A queued action that has
not possibly dispatched can be cancelled by an authorized configuration manager;
only a fresh review of the corrected confirmation and explicit prospect
permission can authorize the new message. Existing uncertain/sent actions retain
the duplicate-send guard. Resending after a possibly dispatched message remains a
separate authority flow, not a button introduced by this increment.

The new exact GET query is `/api/workflows?id=<action-id>` and accepts no list
filters or cursors alongside it. It returns the same safe operator projection as
the queue; raw message HTML, provider credentials and execution inputs remain
server-side. No connector runs from this lookup.
