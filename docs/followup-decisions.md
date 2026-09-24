# Staff follow-up decisions

Follow-ups are staff work intentions. Marking one handled or not needed does not
place a call, send a message, confirm attendance or prove delivery. Permissioned
email and website callbacks have their own workflows and evidence.

Staff can review a task, record its status and reopen it from the completed list.
The review shows the current task and saved staff decisions. Completed tasks stay
available even when their original due date is in the future. The work queue first
shows 20 completed tasks, with an explicit loaded count and a control to show more.
Recent staff decisions sort first, after tasks requiring identity review. Legacy
rows without recorded decisions retain their existing status and due-date ordering.

`GET /api/leads` supplies an opaque `expectedSha256` for each loaded follow-up.
`POST /api/leads` with `action: followup_status` requires its exact ID, requested
status, that fingerprint and a new `requestId`. The server derives actor identity
from the signed-in session. Status, the original acknowledgement and actor/time
history are saved together in one document compare-and-set. PostgreSQL couples
that write to its scoped audit transaction; legacy KV uses its atomic update.

The fingerprint covers the stored record, including provenance, supersession and
earlier decisions. A stale completion or Undo cannot replace a newer staff change
or changed caller context. Repeating the exact saved command returns its original
decision **and the current task**, without restoring the old status. A different
actor or payload cannot reuse that decision's request ID. Missing records are not
recreated. Reminders retired by tour cancellation or rescheduling cannot be reopened.
History retains at most 100 decisions per task; at the limit, new decisions require
administrator review, and existing acknowledgements remain recoverable.

The browser holds one immutable command after an uncertain response or a 15-second
timeout. “Check saved decision” retries it. A definite conflict requires reloading
and reviewing current data. Navigation retires the form; old property/session
responses cannot update another workspace. Closing an uncertain form does not
cancel a possible save; review the saved task/history on return.

All staff mutations on `/api/leads`, including notes, unit feedback and tour-request
review, require same-origin JSON requests. Managed mode additionally retains
current membership, property, configuration and MFA checks. Legacy follow-up writes
require the selected tenant header. Old browser tabs must refresh before sending
the new versioned commands. Provider callbacks do not use this staff endpoint.

This adds no migration or provider. Existing records remain readable. After staff
use decision history, rollback should use a compatible build that preserves both
the history and checked-write protocol; an older unchecked status writer can
overwrite newer decisions. Production rollout and hosted acceptance are separate
from source verification. See [the leasing goal](leasing-goal.md) and
[tour-change outcomes](tour-change-requests.md).
