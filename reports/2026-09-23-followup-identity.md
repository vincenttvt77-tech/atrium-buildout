# September 23 — reservation-bound follow-ups

Coordinator: Codex root. Task AT-145. Branch `codex/at145-followup-identity`;
base `0f90fa2df1275bc8264142a19efb5b7090dce283`. The full leasing goal remains active.

## Confirmed problems and changes

Five focused regressions failed against the base implementation:

1. Two saved reservations for one caller at the same time/apartment shared their
   initial follow-up IDs. Completing the first confirmation could leave the second
   reservation without its own scheduled work.
2. A pending reschedule hid another reservation's reminder because its original
   time matched, despite a conflicting explicit reservation ID.
3. Today's confirmation shortcut appeared on another tour for the same phone.
4. A task description borrowed the apartment/time from a conflicting reservation.
5. A different confirmed tour at the same time hid a failed booking's review item.

Saved follow-ups now use reservation identity and revision from the first booking.
The [documented reconciliation](../docs/tour-identity.md#follow-up-identity-and-preserved-staff-work)
upgrades unambiguous prior v2 source identities without rewriting task IDs or staff
status, deadline, channel or reason. Ambiguous older work remains visible for review;
it does not fan out into multiple newly scheduled tasks. Interrupted upgrades can
be retried. Reschedules retain retirement records at the former initial keys and
preserve keys already belonging to another explicit reservation.

Today, Leads and the shared task descriptions require matching original-call,
reservation and revision evidence. Review-held tasks lose tour-specific confirmation
shortcuts. An unrelated callback does not hide another call's failed booking.
The mobile review warning remains readable and the same actions work by keyboard.
No external call or message is triggered by these changes.

## Verification

- `npm run check`: **1,794 tests passed**; typecheck and fixture validation passed.
  **13 new application regressions** cover the defects and compatibility cases.
- Focused native PostgreSQL tests: **3 passed**, using multiple actual database
  connections for simultaneous submissions/replays. Property and organization
  isolation, stable task counts, retained staff decisions, rollback of documents
  and audit history, and successful replay were verified.
- Complete native PostgreSQL suite: **615 passed** in the final run.
- `npm run build`: site/dashboard generation passed; **22 API handlers** imported
  and rejected unconfigured requests in both runtime modes.
- Real Chromium, actual HTTP handlers, persisted PostgreSQL records and signed
  synthetic MFA: **passed at 1280, 390 and 320 pixels**. One caller's two tours stay
  distinct; only the exact task grants a confirmation shortcut; a real refresh
  removes it when review becomes necessary; keyboard navigation opens the correct
  lead with the review warning; no horizontal overflow. Narrow-phone screenshot
  visually inspected. **Zero staff mutations or real provider calls.**
- Diff and scope review performed by Codex. No independent reviewer participated.

The first new database setup incorrectly tried to publish configuration for an
unconfigured fourth fixture property; all three new cases failed in setup before
running. That fixture was corrected and its three tests passed. The first full
application run had one existing test asserting date-based legacy guessing and
omitting original-call identity; the test now uses the actual source contract and
requires ambiguous legacy tasks to stay generic. Neither failure is counted as a
successful run. Local evidence is under `/private/tmp/at145-*`.

The prior exact GitHub run **35890043681**, job **107279915715**, completed
**success** for base `0f90fa2`, including install/application/database/build.
Stop polling that terminal run. This branch's own cloud result is separate.

## Release limits

This is source implementation and local acceptance. No live migration, provider,
voice, model, GPU, sender or production setting changed. Follow-ups remain
non-executable staff intentions; no attendance, delivery or call was inferred.
Historical rows without enough identity evidence remain under review. The change
is not a bulk cleanup of all stored records or a complete cancellation workflow.
Post-booking email/contact correction is still unfinished.

Hosted Preview still needs its separate configuration and resource isolation.
Previously observed inherited live KV/lead-webhook capabilities must be removed
from Preview before enabling its login. A successful build does not prove an
operational hosted portal. AT-129 Force Promote remains separately pending after
its earlier automatic-review rejection; source publication is not a workaround.
No current phone baseline or measured voice latency improvement is established.

## Owner to-dos

1. Finish the already prepared free Atrium Preview project form, save its password
   privately and confirm creation. No completion reply has been received.
2. Provide representative permissioned leasing samples and verified property rules.
3. Set a bounded budget for paid voice/audio/hosting trials and select a licensed
   Black American or Latina female voice after auditions. Vast.ai hosting and voice
   choice remain separate comparisons; neither is switched live.

## Codex / Fable next steps

1. Review the exact published revision and its own cloud quality run; preserve the
   canonical checkout's unrelated dirty calendar work.
2. Finish the post-booking contact-correction flow, including changed email after
   a booking, confirmation permission, uncertain outcomes and duplicate protection.
3. Continue the isolated hosted Preview setup after secure owner input, then verify
   actual desktop/mobile sign-in, persistence and property isolation.
4. Establish a fresh successful phone-to-tool-to-dashboard baseline. Freeze held-out
   cases and compare the licensed voice and hosting alternatives independently;
   report actual audio latency, workflow success and cost with sample sizes.
5. End the next session with a reciprocal Codex/Fable handoff containing accessible
   commits/deployments, actual checks and limitations, owner to-dos and agent to-dos.
