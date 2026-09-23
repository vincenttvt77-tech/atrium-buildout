# Caller tour-change requests and staff outcomes

The managed dashboard keeps pending **and reviewed** caller change requests in
Today, Calls and the Leads work queue. Review acknowledges the request; an outcome
records what staff actually handled. Legacy workspaces retain their existing review
behavior and do not expose the managed resolution endpoint.

Staff first verify the caller and reservation. Use Calendar to make a reschedule
or cancellation, then choose **Record outcome** on the request. The form offers
only current, completed saved changes made after the latest caller evidence.
Search by name or unit, review the selected change, explain the decision, and
attest to the association. A phone-number match never performs this association.
The source candidate contains a reservation identity, operation, time, exact digest
and saved tour interval. Pending reconciliation, ambiguous identity and changed
evidence cannot support a decision.

**Close without a tour change** requires a reason and explicit staff review. It
does not claim a booking, reschedule, cancellation, phone contact or notification.
For example, staff can record that the caller chose to keep the existing tour.
Email delivery stays in its own reviewed workflow.

`GET /api/tour-change-resolutions?id=…&search=…` returns the latest request, a
configuration-bound request digest and up to 100 matching candidates. `more: true`
requires narrowing the search; the initial list is not a full-property count.
Only signed-in staff with current property `operate` permission can access it.
All reads/writes use the dashboard's organization, property and configuration
headers; the server independently establishes and rechecks that authority.

The same-origin JSON POST binds the exact request revision/digest, chosen source
digest, staff actor, reason, attestation and unique command ID. Calendar and request
locks serialize source changes and caller updates. The outcome, request revision,
immutable command receipt and mutation audits commit together. This endpoint never
changes the calendar or contacts a provider. There is no new database migration.

The browser freezes an uncertain save and retries the identical command. The server
returns its recorded outcome instead of adding another. A later caller update
reopens the request but retains all previous decisions; recovering an earlier saved
reply returns the current open request alongside its historical outcome. It cannot
close that newer request. New evidence keeps a separate `lastRequestedAt` boundary;
staff review does not replace it. Older records without that field conservatively
use `lastUpdatedAt`. Delayed caller evidence is retained without moving that boundary
backwards. Exact provider redelivery does not reopen a handled request.

The request retains at most 100 decisions. An exhausted or corrupt record needs
administrator review; no silent history truncation occurs. The UI displays the most
recent decision and whether newer evidence reopened the request. Full decisions
remain in the scoped request record for operational inspection.

Verification includes domain and portal tests, real local PostgreSQL/HTTP tests,
and `test/browser/tour-change-resolutions.mjs` against Chrome at 320, 390 and 1280
pixels. These use synthetic callers and disable external providers. This is source
acceptance, not hosted activation, a real phone call or measured voice improvement.
See [tour identity](tour-identity.md), [cancellation](tour-cancellation.md) and
[the current leasing goal](leasing-goal.md).
