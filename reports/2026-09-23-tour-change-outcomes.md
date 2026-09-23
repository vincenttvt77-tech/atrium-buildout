# Tour-change follow-through — September 23, 2026

AT153, Codex root. Branch `codex/at153-tour-change-outcomes`, base
`9fcbf4f82ebbbbe565cc89d3967daca8082fd85d`. This report describes application source
for managed workspaces. It does not describe a production rollout or voice change.

## Delivered behavior

A reviewed caller request now stays in Today, Calls and the Leads work queue until
staff record an outcome. Staff can link an exact completed reschedule or cancellation,
or explicitly close the request without changing a tour and explain why. Identity
and reservation association require staff verification. No association is guessed
from a phone number, name or shared tour time.

Only current saved changes after the latest caller details qualify. Pending lead
reconciliation and ambiguous calendar identity prevent completion. Search exposes
when more than 100 results exist instead of silently claiming complete coverage.
The selected request revision, published property context and exact calendar evidence
are rechecked when saving. Outcome, audit and replay receipt commit together.

New caller evidence reopens the request and retains previous decisions. A delayed
event retains its instructions without moving the review boundary backwards. Exact
redelivery preserves the outcome. Recovering a lost saved reply returns the historical
decision and the current open request, rather than closing newer instructions.

The dashboard freezes uncertain commands and offers recovery after a 15-second
timeout. It distinguishes a saved outcome from changing a booking or sending a
message. Current contact/notification workflows stay separate. Today request cards
now use the full card width; the inherited icon-column layout previously squeezed
their text into a narrow, excessively tall strip.

## Verification

- `npm run check`: 1,806 application tests, type checking and fixture validation passed; includes
  six new domain regressions and updated meaningful portal behavior assertions.
- `npm run test:database`: 717 real local PostgreSQL/HTTP cases, including 15 new
  outcome cases; the final rerun passed with the last timestamp compatibility correction.
- `npm run build`: 26 API handlers imported and safely refused unconfigured requests;
  authored dashboard assets regenerated.
- `test/browser/tour-change-resolutions.mjs`: nine real Chrome acceptance groups
  passed at 320, 390 and 1280 pixels, using real local HTTP/PG and signed synthetic MFA.
  Includes keyboard attestation, reviewed attention, actual cancellation and reschedule,
  no-change closure, history, identical-command lost-reply recovery, newer caller
  instructions, stale source, a real 15-second timeout and retired route responses.
  Both desktop and narrow screenshots were inspected. No external providers ran.
- Source/diff and document links reviewed by Codex root. Independent review is not
  claimed. This task adds no database migration or runtime dependency.

Initial failures and corrections are retained honestly: native fixtures used the
wrong audit column, an invalid membership status, omitted the required property
timezone and expected 500 instead of the established 503 on a database failure.
A calendar-only fixture correctly left reschedule reconciliation pending; the final
fixture projects a real synthetic original call before rescheduling. An existing
review test caught an initial rejection of delayed new caller evidence; the final
implementation retains it. Two old portal assertions counted reviewed requests as
closed; updated to the new managed-workspace contract. Screenshot inspection caught
the Today column defect even though a simple overflow assertion passed; the browser
now also asserts readable text width and card height.

One local permission review timed out before a test process started. The explicitly
permitted one-time retry succeeded. A focused passing native run had a single slow
case; the later complete suite finished normally. No latency claim is derived from
those local timings. Parent AT152 GitHub run35918455573/job107375972632 completed
SUCCESS in all steps; that terminal run needs no further polling.

## Limits and next actions

Staff must still make the actual calendar change before associating its outcome.
This is not caller self-service identity verification, automatic matching, SMS or
automatic contact. Legacy workspaces retain review-only behavior. At most 100 decisions
are retained per request; further action requires administrator review, with no silent
history loss. Older requests without separate caller-evidence time use a conservative
boundary. The UI shows the latest decision; all decisions remain in the scoped record.
After using this feature, a managed-workspace rollback must use a build that understands
resolved request records; old review-only builds do not recognize the new status.

Hosted acceptance, approved provider configuration and a successful real phone and
inbox baseline remain open. The earlier workflow read-policy migration remains
unapplied to hosted databases. No production promotion, Vapi edit/publication, selected
voice, paid audition, GPU rental or AT129 approval workaround occurred. The full
leasing goal remains active. See [the workflow contract](../docs/tour-change-requests.md)
and [voice audition kit](../docs/voice-audition-kit.md).

**Owner to-dos:** complete the secure isolated Preview setup; supply approved property
facts and permissioned representative calls; choose a preferred licensed female voice
after listening and define a bounded voice/hosting trial budget. Keep credentials in
the provider's secure setup.

**Next Codex/Fable to-dos:** verify this exact branch's cloud checks; independently
review outcome/source/receipt boundaries and the timestamp compatibility behavior;
complete managed Preview and permissioned real phone/inbox acceptance when inputs
arrive. Continue remaining permissioned follow-ups and contextual handoffs. Establish
the current phone baseline, audition licensed Black American/Latina female voices,
and compare Vast inference separately before changing both components together.
Preserve unrelated canonical calendar work and the existing production approval boundary.

**Reciprocal handoff required:** end the next session with accessible commits,
deployments, actual checks and failures, local versus hosted evidence, unfinished
ownership, owner to-dos and next-agent to-dos. Tell the following agent to provide the
same handoff. Publish it with the code so GitHub-only reviewers can read it.
