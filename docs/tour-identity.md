# Reservation identity in the staff dashboard

A reservation is identified by its saved `externalId`, not its time, apartment,
prospect name or phone number. Those fields can legitimately be shared. Calendar,
Today and Leads use the same identity resolver in `ops/src/app.js`.

## Joining records

- A calendar reference must match exactly one saved reservation. Duplicate or
  invalid identifiers are ambiguous, not a reason to choose the first result.
- A confirmed lead booking with an explicit identifier joins only that identifier.
  A conflicting original call identity prevents the join.
- An older lead booking without an identifier may join through its original
  `callId` only when exactly one calendar reservation has that `interactionId`.
  A conflicting explicit identifier never falls back to the call.
- Exactly one confirmed lead reference may claim that reservation. Competing
  claims do not expose a guessed contact or name suggestion.
- Opaque reservation identifiers are never split to manufacture call identities.
  Anonymous prospect links retain the original call selector.

Indexes are built from the current scoped snapshot and reused within view
calculations. They are not a global cache and do not survive a property switch.
Ambiguity is retained in the indexes rather than overwritten by insertion order.
The HTTP authorization and server mutation checks remain authoritative.

## Staff behavior

Today uses the complete saved calendar even when the visible grid shows another
week. A removed lead booking cannot borrow another reservation's presence. A saved
reservation without a unique lead retains its own saved contact fields on Today;
Calendar continues to show contact details from a uniquely linked lead only.
When the calendar is unavailable, historical profile projections remain labeled
by the existing unavailable-calendar presentation; they are not matched by guess.

Tour links carry `booking=<externalId>`. The calendar follows that reservation's
actual date, including after rescheduling. An unavailable or ambiguous identity
shows a message without opening a different tour. Older slot-only links open a
tour only if exactly one tour occupies that time; shared times require selection.
A profile without usable reservation identity links to the day without selecting
a possibly unrelated slot.

Calendar items use stable reservation keys. Reordering simultaneous tours does
not change an open item's identity. A changed contact, reservation or linkage
closes stale details even when the grid itself has not changed. Missing/ambiguous
calendar records do not expose reschedule or confirmation controls. A unique
calendar reservation can still be managed without a linked CRM profile; its
unlinked state is explicit. Lead tour badges distinguish a profile projection
from a uniquely matched saved reservation.

## Verification and boundaries

`test/portal/tour-identity.test.mjs` covers shared-unit/same-name contacts,
conflicting and missing identities, legacy call joins, deleted reservations,
anonymous links, stale details, reordering, duplicate claims and escaped links.
`test/browser/tour-identity.mjs` runs actual dashboard/API handlers and a disposable
PostgreSQL database in Chromium at 1280, 390 and 320 pixels. It uses a synthetic
signed MFA session and disables external services. Set `ATRIUM_PLAYWRIGHT_MODULE`
and `ATRIUM_CHROME_EXECUTABLE` if those are not available through normal defaults;
`ATRIUM_BROWSER_ARTIFACTS` optionally saves local screenshots.

This work does not repair ambiguous historical records, send notifications,
change booking capacity rules, or verify a deployed phone call. Staff contact correction and earlier-email review are described below. Local
browser acceptance is not hosted portal or production acceptance.


## Follow-up identity and preserved staff work

Follow-ups for a saved reservation use its `externalId` and revision, including
initial revision zero. Different reservations at the same time/apartment for one
caller therefore have separate confirmation, reminder, attendance-check and
email-collection work. Reservations without an external identifier retain the
older physical identity behavior; inventing an identifier would misstate evidence.

Previously persisted initial v2 task IDs are recognized through their original
physical key, original call and reservation evidence. A unique match gains the
current source identity **in place**: its stored ID, status, due time, channel,
reason and creation history remain unchanged. An older source without a reservation
ID can be upgraded only with an unambiguous original-call/physical match. Multiple
possible owners retain visible review metadata; the updater neither guesses nor
creates one new task for every candidate. This is opportunistic reconciliation on
call projection/replay, not a bulk migration or a deletion of historical work.

Rescheduling preserves retired records at both the current and former initial
v2 keys, so a delayed older projection encounters retained skipped work rather
than recreating a scheduled reminder. A physical key already owned by a different
explicit reservation is preserved. Pending reschedule visibility respects an
explicit source identifier; older sources additionally require a unique matching
original call and physical interval before being hidden from the active queue.

The dashboard gives a tour the **Call to confirm** shortcut only when a scheduled
task uniquely matches that prospect's reservation and revision. Review-held or
superseded tasks cannot supply the shortcut. Task descriptions use the exact
source booking, including its actual day, rather than another tour sharing the
date. Older ambiguous tasks remain generic and retain their review warning.
An unrelated callback or another confirmed tour cannot hide a failed booking's
staff-review item merely because the caller or start time matches.

All follow-ups remain staff intentions with `executable: false`. These changes
place no calls, send no messages and do not record attendance. Explicit backend
authorization remains unchanged. Regression coverage includes concurrent real
PostgreSQL projection, property boundaries, transactional rollback and replay,
legacy compatibility, and real desktop/mobile Today/Leads rendering.


## Contact changes preserve reservation identity

The managed voice contact correction uses the exact confirmed original-call
reservation, not a phone/name/slot join. Calendar and call contact fields commit
together. Contact edits retain the scheduling revision, so they do not fabricate a
reschedule or derive new follow-up identities. After call completion the existing
lead projection receives the corrected details. Stale or ambiguous reservation
claims retain the volunteered contact for staff, with a truthful refusal to claim
the saved tour was updated. The [confirmation contract](email-delivery.md#contact-corrections-after-booking-at-146)
separates a corrected address from permission to send, and preserves any earlier
email's original recipient and delivery evidence.

## Staff corrections for a saved tour (AT-149)

Calendar → a saved tour → **Edit tour contact** lets current property operators
correct its name/email and record a reason. Clearing the email explicitly removes
it from that reservation. Calendar and Today display the saved reservation's
contact; an older lead profile cannot replace it. Original caller identity, call
records, lead linkage, apartment, time, occupancy and scheduling revision remain
unchanged. Contact editing does not send anything or grant messaging permission.

The PostgreSQL service locks the property calendar, checks the exact reservation
and displayed snapshot, and commits the contact, reason/history, command receipt
and mutation audit together. A separate `contactRevision` and
`contactReviewedByStaff` marker prevent subsequent AI contact corrections from
overwriting the staff decision. The original call can still retain later
volunteered details for staff to review. A different edit from a stale form is
refused. Retrying the same command returns its original receipt plus the current
contact, even if a later staff correction has superseded it; a removed tour returns
the receipt with no current reservation. A command ID cannot authorize a changed
payload or another operator's command.

History is scoped to the property and reservation, checked for consecutive
revisions and matching contact transitions, and paged in groups of 20. The bounded
1,000-change history requires administrator review if exhausted; malformed history
cannot authorize another correction. Past tours, ambiguous IDs, missing exact
times, unresolved booking/reschedule projection or emergency holds are unavailable
for editing. A normal requested tour-change hold does not prevent staff from
correcting contact details; it still does not change the requested schedule.

The form protects incomplete writes: an uncertain reply offers **Check saved
change**, retries the same command and freezes its submitted fields. A known
conflict requires reloading the current reservation. Route changes, revoked
sessions and property-scope failures close/retire the form; delayed results cannot
reopen it. Keyboard controls and 320/390/1280-pixel layouts use the shared accessible
modal and property-bound API client.

Storage uses additive optional calendar metadata and versioned records in the
existing scoped document store; this increment requires no new SQL migration.
Existing reservations without staff metadata begin at contact revision zero.
Retain the metadata and history on rescheduling and rollback. Do not downgrade an
active managed workspace's voice contact writer below this protection while
continuing to promise staff edits cannot be overwritten; older writers do not
understand the new marker. The hosted legacy dashboard does not expose this form.

Regression evidence lives in `test/database/tour-contacts.test.mjs`, the existing
voice/confirmation/workflow HTTP suites, `test/portal/tour-identity.test.mjs`, and
`test/browser/tour-confirmations.mjs`. These use synthetic callers and isolated
PostgreSQL; they do not establish production or actual-phone acceptance.
