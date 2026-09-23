# Staff tour cancellation

Managed PostgreSQL workspaces expose **Calendar → saved tour → Cancel tour**.
The staff member reviews the reservation, checks that it is the intended tour,
and records a reason. Cancellation frees the saved tour's staff/apartment capacity
and retains its exact contact, interval, apartment, original interaction, staff
actor and reason. It does not add a building/unit blackout or delete call history.

**Cancellation does not notify the prospect.** The form says no cancellation
message was sent. Staff must contact the prospect separately. A previously sent
or in-flight confirmation cannot be recalled. A queued confirmation's dispatch
check refuses the removed reservation; cancellation does not invent delivery,
recall or a replacement notification. Work queue history retains the earlier action.

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
feature does not add caller self-service cancellation, a connected PMS adapter,
a cancellation notification provider or permission to send a message.

Evidence: [implementation report](../reports/2026-09-23-tour-cancellation.md),
`test/database/tour-cancellations.test.mjs`, the signed voice/confirmation suite,
and `test/browser/tour-cancellations.mjs`. All are synthetic local evidence, separate
from hosted managed-property and actual phone acceptance.
