# AT-117 independent integration review

Reviewed 2026-09-20 19:33:50 UTC in the shared application checkout at
`/Users/evanmavashev/Documents/ChatGPT/Atrium/atrium-buildout`.
Branch: `codex/atrium-quality-pass`; HEAD: `9b935ab`; implementation remains uncommitted.

## Scope and independence

I implemented the assigned booking/calendar certainty boundary, then independently
reviewed root's webhook integration, staff booking-review projection, lifecycle
contact allowance, and callback identity propagation. I did not modify those
implementation files. The coordinator separately assigned
`api/test/vapi-review-replay.test.ts` for independent failure/race regressions.

## Findings and disposition

All actionable findings sent during integration are now corrected in the reviewed
working tree:

- A lost dispatch-marker response now completes a known negative calendar outcome
  instead of trying to block an intent already marked dispatched.
- Failed staff-review projection remains retryable across original booking and
  cached contact replays; projection recovery does not rebook or confirm.
- Safe contact capture works after uncertainty both within the same tool batch
  and in a later request. A review-store outage does not discard saved contacts.
- Callback evidence is merged by capture time both during ordinary call save and
  the before-booking snapshot, preserving newer concurrent corrections.
- Unchanged snapshot name/email fields no longer overwrite current contact
  corrections. The email case was reproduced as a failing independent regression
  before root's fix.
- Booking restoration uses a per-tool snapshot so a second booking attempt does
  not erase the first confirmed tour from the same batch.
- Existing same-key unit/interval changes raise a staff tour-change request rather
  than offering another tour while a reservation already exists.
- Root additionally retains a confirmed booking when a subsequent tool fails
  before staging a new booking request.

No remaining confirmed blocker was found in these scoped paths. Tenant/property
reads and writes continue through the authenticated scoped stores; the helper does
not accept a model-supplied property override.

## Actual verification

Using Node 22.23.2:

```sh
PATH=/private/tmp/node-v22.23.2-darwin-arm64/bin:$PATH node --test --test-reporter=spec api/test/vapi-review-replay.test.ts api/test/vapi-booking-recovery.test.ts api/test/vapi-lifecycle.test.ts api/test/call-identity.test.ts src/calls/test/lifecycle.test.ts 'src/booking/test/*.test.ts' 'src/calendar/test/*.test.ts'
```

Result: **143 passed, 0 failed, 0 skipped, 9 suites**. Output:
`/private/tmp/atrium-at117-focused.log`.

The five new independent handler tests cover persistent projection failure,
cached-contact replay, two-booking batches, out-of-order contact completion, and
stale dispatch snapshots. The root-authored lost-marker-response regression was
included. `npm run typecheck` passed after concurrent helper files were present;
`git diff --check` passed on the final reviewed state.

## Limits and next owner

These checks are local, synthetic and offline. They do not establish live Vapi
behavior, hosted KV/SQL fault tolerance, a deployed release, or complete automated
resolution of uncertain bookings. Uncertain bookings intentionally retain review
state rather than receiving an invented confirmation. Root owns remaining full
application, native database, build, UI acceptance and publication checks.

No commits, provider changes, paid calls or deployments were made by this agent.
