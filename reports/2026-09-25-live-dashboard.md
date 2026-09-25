# Live dashboard read-through — September 25, 2026

AT-159, Codex root. Inspected the actual production browser at
`https://ghost-building.vercel.app/api/dashboard` around 14:17–14:25 UTC.
Documentation base `6e761bb600648a7ba3c637819670f456b6148a93`, branch
`codex/at159-live-readthrough`. This is authenticated browser evidence for the
currently hosted legacy workspace, not acceptance of the newer managed runtime.
No application code or production deployment changed.

## Observed results

| Check | Actual result |
| --- | --- |
| Owner-provided production demo credential | Sign-in succeeded and Today loaded. The credential is not reproduced here. |
| Current calendar | September 20–26 loaded with available times and existing holds. The UI showed two simultaneous tours, 30-minute tours, one tour per apartment and no advance limit. Settings were read, not changed. |
| Navigation beyond two weeks | Go to date → December 15, 2026 loaded December 13–19 in Eastern Time, selected the requested day, and showed future start times. This verifies this date, not every possible date or a new booking. |
| Lower-list apartment selection | Opened 33A, then neighboring 32C. The detail heading changed correctly each time. The unit-list scroll offset stayed at 3018.5 pixels between those selections instead of returning to the top. This is one browser/reproduction sequence, not proof against every input race. |
| Known-unit details | Selecting 19A displayed Three Bedroom / 3 bed / 1,332 sq ft. The surrounding workspace identified a fictional demo catalogue with sample facts, not live availability. This does not prove the phone assistant can retrieve those facts. |
| Connection status | Status reported callers, calendar and call history loaded, with saving enabled. It explicitly described the inventory as fictional and disconnected from a PMS. These are observed status indicators, not independent write/delivery tests. |
| Sign-out | Sign-out returned the form. A fresh navigation to the protected Units URL also required login. This checks this browser's access after sign-out, not replay resistance of a copied legacy cookie or managed session revocation. |

Two sign-out attempts using accessibility node IDs failed because those nodes were
no longer present. The stable, visible Sign out button locator succeeded. These
automation lookup failures are not evidence that the application's sign-out failed.

No tour, block, contact, follow-up, configuration or caller record was edited or
deleted. No message, phone call, paid simulation, voice change or GPU rental ran.
No raw caller names, contact details or transcripts are published in this report.

## Remaining concerns and acceptance limits

Today displayed two history records with synthetic-release identifiers as ordinary
Hidden number entries, without an individual test badge. Their underlying provider
provenance was not verified in this read-through. Do not cite those records as
proof of real phone success. Next investigation should establish their origin and
make test provenance explicit without classifying arbitrary calls from names or
silently deleting history.

This audit did not pin the hosted Git revision, test actual recordings, place a
booking, reschedule/cancel, exercise concurrent writes, verify notification delivery,
test tenant switching or run a physical mobile device. The newer PostgreSQL account,
passkey and managed assistant release flows were not present in this legacy session.
Earlier synthetic CI results are separate evidence and were not rerun for this report.

The correct Supabase Free organization was inspected in a separate read-only tab.
It still listed only the original paused demo project; no isolated Atrium Preview
project existed. The pending private creation form was not opened, read or changed.
A paused Supabase project does not establish a production outage: the production
dashboard demonstrably loaded its existing workspace in this audit.

## Owner and next-agent actions

Owner: finish the private Atrium Preview project creation already prepared; provide
bounded voice trial funding, approved pilot property rules and permissioned call
samples. Choose the voice after comparable listening samples. Keep credentials
out of chat and public reports.

Codex/Fable: activate the [isolated managed preview](../docs/hosted-preview.md) once
the resource/private configuration is available. Verify real login/passkeys and
property boundaries, then synthetic booking/rescheduling/cancellation and recovery
on that host. A subsequent separate voice/email sandbox needs its own provider
configuration and funded end-to-end acceptance. Resolve the [uncertain voice import](2026-09-25-voice-candidates.md)
by saved-state evidence before resubmission, and investigate the test-history labels.
Do not repeat this read-through as a substitute for those missing release gates.

Preserve the AT-129 production approval boundary and unrelated canonical calendar
edits. The full leasing goal remains active. End the next session with a reciprocal
handoff: accessible commits/deployments, actual checks, limitations, owner to-dos
and next-agent to-dos.
