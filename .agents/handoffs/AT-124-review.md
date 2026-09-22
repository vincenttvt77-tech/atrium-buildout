# AT-124 independent review — investor demo stability

Reviewed 2026-09-21T02:24:27.085362+00:00. Coordination branch `codex/atrium-quality-pass`, checkout HEAD `1fde58426baf902c9032fc7b453151ef08721b80`; deployed application source independently read using `git show 5ef64688ddc687fd24d393f91f4b84b15b77078c:<path>`. Root paused feature implementation mid-review for investor demo stability. No partial booking-resolution implementation is approved by this review.

## Confirmed actionable finding

**P2 — Status can report a healthy workspace while saved booking reviews are unavailable.** At deployed `ops/src/app.js:2594–2596`, `statusSummary` considers safety and call-history errors but omits `bookingReviewsError`. Its render model/support detail omit that field as well. The manual-refresh freshness predicate at `ops/src/app.js:2774–2777` also omits it. A HTTP200 calls payload with a review subfeed failure and successful calls/calendar/leads loads therefore produces the green heading “Workspace data is available.” and may show successful-refresh copy. The overall dashboard chrome and Today already account for this error, so the inconsistency is localized to Status. Independent synthetic execution of the actual committed source/harness reproduced exactly that green heading and `is-ok` class. Recommended fix: include review error in summary precedence, render signature, support detail, and the refresh-success predicate; add regressions for error onset, clearing and partial-refresh results. This is not evidence that the production review feed is currently failing.

## Demo operating constraints, not new defects

- `src/ops/session.ts:26,72–88` gives the shared demo cookie an eight-hour lifetime. `api/dashboard.ts:305–311` renews a valid cookie on a full dashboard GET/HEAD. `ops/src/app.js:637–645` handles API401 by retiring/reloading the page. Polling the data APIs does not renew the session. An overnight tab can expire near the demo; re-open/sign in shortly before the presentation rather than weakening expiry.
- `api/health.ts:36–45` probes KV and reports whether a Vapi API key is present. It does not test assistant routing, credential equality, audio, balance, phone availability or tool response correctness. A healthy response is storage evidence only.
- `src/ops/vapi-calls.ts:125–128` bounds actual Vapi history reads to eight seconds and defaults to the most recent20 calls. Failed upstream reads are represented separately; fresh call acceptance still requires a real end-to-end test.
- Bundled source contains120 knowledge articles; none have a review deadline at or before September21,2026 08:00EDT. Fictional demo inventory is explicitly marked and quoteable as sample data by `src/inventory/source.ts`; a September1 catalogue date alone does not disable demo quotes.
- Legacy production does not expose the PostgreSQL-only Service and Work queue sections. This follows existing runtime gating, not a new regression.

## Checks and actual results

- `/private/tmp/node-v22.23.2-darwin-arm64/bin/node --test src/ops/test/session.test.ts src/ops/test/vapi-calls.test.ts src/vapi/test/sync.test.ts src/vapi/test/voice-config.test.ts src/inventory/test/source.test.ts api/test/dashboard-auth.test.ts api/test/vapi-auth.test.ts test/portal/status-readiness.test.mjs` —117 passed,0 failed. Relevant sources matched deployed5ef when checked; log `/private/tmp/atrium-demo-independent-check.log`.
- Independent VM execution loaded `ops/src/app.js` and the portal harness from `git show 5ef6468`, set a synthetic `bookingReviewsError` with otherwise-ready resources, and confirmed heading `Workspace data is available.` and class `is-ok`.
- Earlier safe focused lifecycle, booking review and actual-KV adapter baseline —34 passed,0 failed. This is baseline evidence, not acceptance of new resolution work.
- Read-only extraction of `data/knowledge.json` from5ef found120 articles and zero expired at the demo cutoff.

## Paused booking-resolution design review

Before the priority change, root received these requirements: a missing calendar read must not prove absence without an atomic same-calendar late-write/replay fence; persist the exact original external key and interval before dispatch; tie resolution to the expected review/source revision; retain a durable resolution tombstone; converge lifecycle and finished-call projection rather than deleting a review; never clear safety/tour-change holds; staff projection must use stored channel provenance plus current staff property authority; handle delayed webhook completion, lost mutation responses and partial KV projection idempotently. Concurrent staff reschedule requires explicit KV coordination so it cannot cause stale confirmed lead times. AT-122 partially authored files remain local, untested and unreleased. These are design requirements, not a completed implementation audit.

## Remaining evidence / next owner

Root owns live dashboard/auth/source and Vapi verification. This reviewer made no live requests, paid calls, source edits, commits, provider changes or deployment. Current saved assistant/backend fingerprint and webhook credential match, actual inbound audio/tool behavior, Vapi account balance and overnight uptime were not verified here. Do not include partial resolution source in a demo release. Resume the independent feature review only after root explicitly reopens the task.
