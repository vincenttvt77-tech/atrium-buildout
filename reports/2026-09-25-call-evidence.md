# Call evidence correction — September 25, 2026

AT-160, Codex root. Branch `codex/at160-call-evidence`, based on
`a0e4f527c3f5f5473773c7f294ec97cc3a9ce73f`. This is a dashboard presentation fix
with synthetic and local database acceptance, not a production deployment or a
successful phone test.

## Confirmed problem and correction

Today counted the union of provider history, retained summaries and backend events
as “Calls received,” although some entries had no matching loaded provider history.
Its rows omitted the source information already partly present on Calls. An empty
disconnected workspace could say “no calls yet,” and a full provider page always
displayed `20+` even when additional saved records established a larger lower bound.

The live follow-up inspection clarified the previous read-through: Calls already
labelled the two investigated entries **Saved summary**; Today omitted that source
label. Their actual origin remains unverified. Direct API navigation was blocked
by the browser client; no credential extraction or alternate access was attempted.
The supported Calls UI was inspected, then the session was signed out and the
owned tab closed. No caller details are reproduced here.

The implementation now:

- Uses consistent labels for transcript, call history, saved summary, saved tool
  activity and explicitly marked demo data on Today, Calls and their detail view.
- Counts **Call records**, separates loaded history from saved notes, and preserves
  deduplication and all operational records. Twenty history entries plus two extra
  summaries show `22+`.
- Qualifies summary-only narratives as saved notes and removes the unsupported
  claim that every such entry represents someone calling.
- Describes disconnected/empty history honestly, without claiming zero calls or
  promising that every record arrives within a minute.
- Refreshes provenance labels when matching history arrives later, without losing
  staff tasks or safety events. It does not guess test identity from names or IDs.

Implementation is in `ops/src/app.js` and `ops/src/calls.js`; generated dashboard
assets were rebuilt. The existing browser CI job now includes the new regression.
There are no backend, database schema, dependency or provider configuration changes.

## Actual checks

| Check | Result |
| --- | --- |
| Initial focused failure reproduction | Six new evidence/count regressions failed before the fix. |
| Focused portal coverage after implementation | 38 tests passed, including seven new source/evidence cases. One earlier broad run exposed an outdated metric-label expectation; its label assertion was updated while retaining the nested-link check. |
| Final `npm run check` | 1,838 tests passed in 99 suites; 0 failures, cancellations or skips. Typecheck and fixture validation passed. |
| `npm run test:database` | 736 tests passed; 0 failures, cancellations or skips. Run completed before the final display-wording adjustment, which changes no database behavior. |
| Final `npm run build` | Passed; all 26 API bundles imported and refused unconfigured requests in both runtime modes. |
| Final generated-dashboard Chromium run | Nine groups passed across 320/390/1280 widths; no page errors, unexpected same-origin requests or horizontal overflow. Keyboard navigation to retained-summary detail worked; absent audio was not invented; explicit demo labels remained visible. |
| Visual inspection | Final narrow Today, narrow summary detail and desktop summary detail inspected. Source labels and qualified narrative are readable. Six screenshots retained locally. |

Final application/build/browser logs are under `/private/tmp/atrium-at160-final-*`;
native log is `/private/tmp/atrium-at160-database.log`. These temporary files are
local evidence, not accessible through GitHub. The committed tests reproduce the
checks. Browser fixtures intercept network requests and contain synthetic data;
they do not establish provider access, real telephony, authentication or physical
mobile-device behavior. Exact-commit cloud checks are separate from these results.

## Owner and next-agent actions

Owner: finish the already prepared private isolated Preview setup; provide a bounded
voice trial budget, approved property facts and permissioned representative calls.
Choose the preferred voice after comparable listening samples. Keep credentials
out of reports and Git.

Codex/Fable: verify the published commit and its cloud checks, then carry this fix
into isolated hosted acceptance. Test actual account/property boundaries and
booking/reschedule/cancellation/recovery there. Do not promote around the existing
AT-129 release gate. Production remains separate from this branch.

The voice direction remains a measured Vast.ai comparison and licensed Black
American/Latina female candidates. Exact Zoe/Leoni/Vega catalog matches are in the
[candidate report](2026-09-25-voice-candidates.md); Leoni's one import attempt is
still unconfirmed. Resolve saved access/rights, audition the identical scripts and
establish a successful current phone baseline before comparing voice and hosting
changes independently. No paid call, generated audio, GPU rental, live assistant
change or latency improvement is claimed here.

At the end of the next session, leave a reciprocal handoff with accessible commits,
actual deployments and test results, limitations, owner to-dos and next-agent
to-dos. The full leasing platform goal remains active.
