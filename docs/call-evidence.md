# Call records and their sources

The dashboard combines connected call history, retained lead summaries and saved
tool events. These are useful operational records, but they are not interchangeable
evidence of completed telephone conversations. Today and Calls use the same source
labels from `callEvidence` in [app.js](../ops/src/app.js).

| Label | What is available |
| --- | --- |
| Transcript | A matching loaded provider record with transcript text. |
| Call history | A matching loaded provider record without transcript text. |
| Saved summary | Retained lead notes without a matching loaded provider record. |
| Saved tool activity | Backend events without a matching loaded provider record or retained summary. |
| Demo record | The workspace explicitly runs in sample-data mode. |
| Source unverified | None of the supported sources is available for this record. |

A provider record is not itself proof that a production telephone call succeeded:
web calls, test calls, incomplete conversations and failed actions need separate
review. Missing history also does not prove a record is synthetic. Older records,
provider failures and limited history pages can all leave summaries without a
matching loaded record. Never infer test status from names, IDs or transcript words.

Today reports **Call records**, with separate counts from loaded history and saved
notes in its existing reporting window. A full recent-history page adds a plus
sign to the known deduplicated union: twenty history entries and two additional
summaries produce `22+`, not `20+`. This is a lower bound on loaded records, not a
complete call-volume or conversion-rate metric. Empty/disconnected views say no
records are loaded; they do not assert that nobody called.

Summary-only stories are introduced as saved records/notes. Explicit sample mode
labels its stories as demo data. When matching history arrives later, the source
label updates without creating a duplicate, including outside Today's reporting
window. Audio and transcript controls still require the corresponding loaded data.

These presentation rules do not remove history, suppress safety reports, alter
follow-ups, certify backend outcomes or change authorization. Review staff work
even when its source is a retained summary or tool event. Successful booking,
notification and voice acceptance require their own evidence.

## Verification

[Portal regressions](../test/portal/call-evidence.test.mjs) cover mixed sources,
deduplication, disconnected history, safety events, explicit demo mode, lower-bound
counts and late history arrival. [Chromium checks](../test/browser/call-evidence.mjs)
exercise the generated dashboard at 320, 390 and 1280 pixels with intercepted
synthetic responses. They cover keyboard navigation, source labels, empty states,
audio absence and horizontal overflow. Neither suite is a real phone or hosted
authentication test. See the [implementation report](../reports/2026-09-25-call-evidence.md).
