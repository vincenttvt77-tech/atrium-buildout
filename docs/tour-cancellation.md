# Staff tour cancellation

Managed PostgreSQL workspaces expose **Calendar → saved tour → Cancel tour**.
The staff member reviews the reservation, checks that it is the intended tour,
and records a reason. Cancellation frees the saved tour's staff/apartment capacity
and retains its exact contact, interval, apartment, original interaction, staff
actor and reason. It does not add a building/unit blackout or delete call history.

**Cancelling does not automatically notify the prospect.** After cancellation,
staff can choose **Review cancellation email** to review the exact saved address
and message, attest the prospect's permission, and submit it through the separate
email workflow. Without a reviewed cancellation sender and connected provider,
the form explains that sending is unavailable. Staff can contact the prospect
separately. A previously sent or in-flight confirmation cannot be recalled. A
queued confirmation's dispatch check refuses the removed reservation. Work queue
history retains the earlier action; a cancellation never invents delivery or recall.

The Calendar's **Cancellations** button lists up to 100 recent cancellations from
the loaded calendar. Opening one performs an exact, current, authorized lookup.
The corresponding lead retains a Cancelled tour entry and a link to its history.
The complete archive and exact-ID API remain persisted; this list is not an export
or a paginated all-time archive browser.

## Authority and persistence

`GET /api/tour-cancellations?externalId=…` returns the exact active or archived
reservation. `POST` accepts only action, externalId, expectedSha256, requestId,
reason and verified. Staff operate permission, registered session/current property
scope, current configuration, same-origin JSON and an exact booking snapshot are
required. Call/channel principals cannot use this staff service. The whole booking
snapshot catches intervening contact changes as well as schedule changes.

Calendar mutation, immutable cancellation receipt, archive, scoped cancellation
index, profile/follow-up projection and audit share a PostgreSQL transaction.
A failure rolls all of them back. Retrying the identical command returns the
original decision. A reused ID with different contents/operator is refused. The
browser freezes a submitted command after an uncertain reply and offers **Check
saved cancellation**. It never invents another command to retry an ambiguous save.

Past/started tours, pending booking/reschedule reviews, ambiguous identities,
missing verified intervals and reservations without an original-call association
require staff review before cancellation. Older reservations can use one matching
profile booking to recover that original call. Hidden caller numbers stay bound
to their separate original call. A new call may book released capacity normally;
the cancelled reservation ID and its original interaction cannot recreate it.

## Late results and follow-ups

Lock order is calendar, then the exact profile document (including a missing row),
then cancellation index and affected follow-up records. The profile lock uses the
same advisory key as every document writer. Managed finished-call projection holds
that lock until its follow-up writes commit and rereads cancellation decisions
after acquiring it. Therefore either transaction order produces a cancelled lead
booking without revived reminders, even when the lead first appears afterward.

Only matching confirmation, reminder, post-tour and collect-email work is retired.
Already done/skipped status and unrelated callbacks/reservations stay intact;
matching historical work gains cancellation metadata so it cannot be reopened as
an active reminder. Ambiguous older work keeps explicit staff-review metadata.
Reschedule replay cannot restore a cancelled status. Historic call summaries remain
a record of what happened during that call, while the lead's current tour status
shows the later cancellation.

The calendar create/read paths retain cancellation fences. Voice booking and
confirmation tools check current cancellation, and their cached replies are checked
again before response. A previous successful booking result cannot be replayed as
current confirmation after staff cancellation. Emergency guidance and already
unconfirmed booking-recovery responses retain their existing behavior.

No SQL migration is introduced: optional `cancelledBookings` metadata and versioned
scoped documents use the existing transitional stores. Do not downgrade an active
workspace below these cancellation-aware writers while continuing to accept old
call events. Existing property document/calendar size bounds apply; large-history
pagination/indexed repository work remains part of the platform roadmap. This
feature does not add caller self-service cancellation or a connected PMS adapter.
Cancelling itself supplies no permission to send a message. The archive's
`notification: not_sent` records that cancellation sent nothing automatically;
it is not the status of a later separately reviewed email. The email's persisted
workflow carries its own permission and delivery evidence.

## Cancellation email

The managed staff email form uses `GET /api/tour-cancellation-emails?externalId=…`
to review an exact archived cancellation. It refuses an active/archived conflict,
an unknown cancellation, missing saved address or ambiguous archive. Outgoing copy
contains the saved contact name, property, scheduled time in the property's zone,
and unit when present. The internal cancellation reason and phone number are never
included. The message says no replacement tour was reserved.

Only `queue` with the server draft digest and explicit permission attestation, or
`process` with the existing email ID, is accepted. The client cannot choose another
recipient, sender, content or property. Staff/current property access, configuration,
same-origin JSON and exact source review apply. Permission expires after one hour
for the initial send. Review does not send anything; the primary button clearly
says **Save permission and send**.

The property calendar lock serializes admission. A scoped cancellation purpose
index, immutable message record, permission receipt, action and outbox commit
together. Concurrent operators and retries after lost acknowledgements reuse one
email for that cancellation. A changed draft after admission shows the earlier
recipient and an exact Work queue link, and refuses a silent second email.
The current UI does not offer editing an archived recipient or a second send;
resolve the existing action/contact the prospect separately.

Before dispatch the service rechecks the cancellation, reviewed sender, current
authority and frozen content. A provider acceptance only shows **Delivery is not
yet verified**. A later exact readback can establish provider-reported delivery,
not a human read. The Work queue and an explicitly activated reconciliation worker
can verify a possibly sent email; neither starts a first send. Missing provider
acknowledgements remain verification-only and eventually require staff review.
The browser offers reload/recovery after lost replies or a 15-second wait; late
replies cannot automatically progress a retired dialog.

Publish `property.tourCancellationEmail` with the separate reviewed sender shape
in [email delivery](email-delivery.md#property-setup-not-activated). A tour
confirmation sender does not enable cancellations. No migration is needed for this
email slice. Publishing source does not configure a live sender, schedule a worker,
activate a managed workspace or send a real email.

Evidence: [cancellation email report](../reports/2026-09-23-cancellation-email.md),
`src/email/test/tour-cancellation.test.ts`, `test/database/tour-cancellation-emails.test.mjs`
and `test/browser/tour-cancellation-emails.mjs`. Synthetic evidence is separate from
hosted runtime, provider account, inbox and actual phone acceptance.

Evidence: [implementation report](../reports/2026-09-23-tour-cancellation.md),
`test/database/tour-cancellations.test.mjs`, the signed voice/confirmation suite,
and `test/browser/tour-cancellations.mjs`. All are synthetic local evidence, separate
from hosted managed-property and actual phone acceptance.
