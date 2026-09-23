# September 23 — correct reservation identity across staff views

Author/coordinator: Codex root. Task AT-144, branch `codex/at144-tour-identity`,
base `7ea0dd2671585c70d17743c0bd08de50555dd1e1`.

## Delivered

Four focused reproductions confirmed that the dashboard could associate a tour
with another prospect by time, apartment or name, suggest that other prospect's
name, or treat a removed lead tour as present because another reservation shared
its slot. The [reservation identity fix](../docs/tour-identity.md) replaces those
joins in Calendar, Today and Leads with unique saved reservation identity and a
strict original-call fallback for older projections.

Simultaneous tours keep distinct contacts and stable row identities. Tour links
open the exact reservation, follow its actual date after a move, and refuse missing
or ambiguous matches. Slot-only links no longer choose the first simultaneous
tour. Anonymous links select the original caller record. Missing identities open
the day without choosing a guessed reservation. Conflicting lead claims cannot
produce a saved-calendar badge or borrowed name/contact.

An open tour survives an irrelevant reorder but closes when its contact or
identity evidence changes, even if the grid markup stays the same. Missing or
ambiguous saved reservations have a clear explanation and no reschedule/email
controls. Unique saved reservations without a lead remain manageable, visibly
unlinked. No underlying records were rewritten. Per-calculation lookup maps avoid
repeated scans for every prospect-reservation pairing and retain ambiguity.

## Actual checks

- `npm run check`: **1,781 tests passed**, typecheck and fixture validation passed.
  This includes **18 new identity regressions**.
- Full native PostgreSQL suite: **612 passed** in 213 seconds. The databases and
  provider responses are synthetic and disposable.
- `npm run build`: site/dashboard generation passed; **22 API handlers** imported
  and rejected unconfigured requests in both runtime modes.
- Real Chromium with real HTTP handlers, persisted PostgreSQL rows and signed
  synthetic MFA: **passed at 1280, 390 and 320 pixels**. Keyboard selection,
  contact identity, direct and wrong-date reservation links, ambiguous time links,
  two separate anonymous prospects and no horizontal overflow were checked.
  Desktop refresh checks cover reordered rows, contact-only changes, duplicate
  IDs and removed-reservation links. **Zero calendar mutations or real provider
  calls** occurred. The narrow-phone screenshot was visually inspected.
- Source scope and `git diff --check`: clean. No independent reviewer participated.

The first reproduction harness needed the required building-name bootstrap field
before it could exercise the four confirmed defects. The first full check failed
only because generated dashboard artifacts had not yet been rebuilt; the final
check used the regenerated artifacts. Intermediate browser harness runs corrected
selectors for the anonymous panel, the two mobile Close controls and multiple
existing toasts; those incomplete runs are not counted as passes.

The preceding source's exact cloud workflow `35886437059`, job `107267651722`,
finished **success**: installation, application, database and build checks passed.
That is evidence for base `7ea0dd2`; this branch's cloud result is separate and
must be checked after publication. Local logs/screenshots are under
`/private/tmp/at144-*` and contain synthetic data only.

## Limits and remaining work

This is a dashboard reliability fix, not a deployment or a voice change.
No live assistant, voice, model, GPU, database migration, sender or production
setting changed. Historical ambiguous records remain unlinked; this deliberately
requires real identity evidence before joining them. Existing phone-based
confirmation-task badges and source matching in follow-up descriptions deserve a
separate focused review. Post-booking email correction remains unimplemented.
The full leasing platform goal remains active.

No current successful phone-to-tool-to-dashboard baseline or measured latency
reduction is established here. Hosted Preview remains a separate configuration
step: the prior inspection found missing login setup and inherited live KV/lead
webhook settings. A build marked Ready does not establish a working isolated
portal. AT-129 promotion remains separately pending after the prior automatic
approval rejection; publishing this source is not a workaround.

## Owner to-dos

1. Finish the already prepared free **Atrium Preview** project form, entering and
   saving its password privately, then confirm creation. No completion reply has
   been received; elapsed time is not authorization or completion.
2. Provide a bounded budget for paid voice/audio/hosting trials, permissioned
   representative leasing recordings and verified property rules.
3. Choose a licensed Black American or Latina female voice after actual auditions.
   The proposed voice and Vast.ai model-hosting changes remain separate decisions.

## Codex / Fable next actions

1. Review this exact published revision and its own cloud check. Preserve the
   canonical checkout's unrelated dirty calendar work.
2. Continue isolated hosted Preview setup once secure project creation is complete;
   remove inherited live capabilities for Preview while preserving Production,
   then verify actual desktop/mobile sign-in, persistence and isolation.
3. Review follow-up reservation association and complete the post-booking contact
   correction flow with meaningful failure and retry coverage.
4. Establish the current real phone baseline, verify candidate voice IDs/licensing,
   then measure voice and model-hosting alternatives separately against the same
   held-out cases. Use the matched offline comparator without presenting synthetic
   checks as phone evidence or spending without bounded authorization.
5. End the next session with a reciprocal Codex/Fable handoff: accessible commits,
   actual deployments/checks, limitations, owner actions and next-agent actions.
