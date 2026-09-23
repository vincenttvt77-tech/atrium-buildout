# Call recording access and release evidence

September 23, 2026, AT-140. Branch `codex/at140-recording-access`, based on
`06fc4b7a39adca2f7ce77090d09adbb65b432164`. Source implementation and local acceptance
are complete. Integration, independent review and hosted audio acceptance remain.

## Delivered

The Calls panel now opens an in-dashboard audio player through an authenticated
recording endpoint. Current workspace authority and the exact provider call's
assistant ownership are checked before obtaining a fresh signed audio link and
again after provider waits. Wrong property, revoked session, changed bindings and
changed published configuration release no link. The private Vapi key stays on
the server. Historical raw recording URLs are no longer returned in call history.

The player supports native controls, mobile layout, keyboard close/focus return,
explicit refresh after expired access and clear unavailable states. Dashboard
polling preserves playback. Navigation, scope invalidation or closing the dialog
prevents delayed responses from reviving it. No new dependency or database migration.
See [implementation boundaries](../docs/recording-access.md).

This addresses the recording-access migration notice observed in Vapi and its
[documented authenticated download flow](https://docs.vapi.ai/assistants/retrieve-call-artifacts).
It does not enable call recording, change retention, place a call, change the voice,
provision a host or establish better latency.

## Actual checks

Node 22.23.2, local checkout:

| Check | Final result |
| --- | --- |
| `npm run check` | TypeScript and fixture validation clean; **1,737 passed, 0 failed** |
| `node --test --test-concurrency=2 'test/database/*.test.mjs'` | **582 passed, 0 failed**, approximately 220 seconds |
| `npm run build` | **22 API handlers** imported and rejected unconfigured requests in both runtime modes |
| `node test/browser/recordings.mjs` with installed Playwright/Chrome paths | **6 scenario groups passed**; 16 synthetic provider reads, 3 synthetic audio requests; **zero real calls or recordings** |

New coverage includes seven transport/normalization cases, four legacy API cases,
nine native PostgreSQL cases and the browser suite. Existing portal tests now check
the recording button/availability contract rather than stale external links.

Native tests use real scoped HTTP/session/MFA/database boundaries and a loopback
provider. Browser tests use the same authorization fixture and a synthetic 8 kHz WAV.
They cover playback through polling, 320/390/768/1280 widths and repeated resizing,
unavailable audio, expired playback, retry, delayed close, navigation and a wrong
property response. The final mobile screenshot was visually inspected; its 390px
viewport and document width both measured 390px, with the player inside the viewport.
These are local Chromium checks, not physical iPhone/Safari or live-provider evidence.

Earlier failures were corrected before acceptance:

- A database fixture expected 403 for a missing property selection; the existing
  runtime correctly returned 428. The fixture now expects that actual contract.
- The first browser resize assertion inspected a frame before the Calls view's
  debounced responsive repaint. The test now waits for the rendered responsive label
  and dimensions, then paint, and repeats the width changes. No product overflow
  suppression was introduced to hide this result.
- An added legacy-account regression initially expected 404 after changing bindings
  while retaining an old cookie. The existing account fingerprint invalidates that
  session, correctly returning 401. The test now verifies revocation, then creates a
  current test session to separately verify foreign and empty bindings. Final full
  application checks passed. The server authorization was not weakened.

## Fresh cloud/live observations

These observations occurred before publishing AT-140. Do not label them checks of
the new recording endpoint.

- GitHub Quality checks run **35872253183**, job **107219070228**, completed successfully
  for base **06fc4b7**. Logs confirm 1,726 application tests, 573 database tests and
  21-handler build checks. This is the prior website-callback source, not AT-140 CI.
- Vercel preview **9A1gPTydKpKoB8gsk8oggCHxJf9y** was Ready at exactly 06fc4b7. Read-only
  checks reached the website/storage/tool contract, but protected dashboard/call/
  calendar/lead routes returned 503 and call history was not configured. A Ready build
  is not a functional demo preview.
- Production still served **5ef64688ddc687fd24d393f91f4b84b15b77078c**, deployment
  **HfvECEzbsU4SZYodAsUehQW2ZmdK**. Website/storage/history checks and actual existing
  portal sign-in succeeded; Status loaded legacy calendar/history data. The catalog
  remains fictional demo data. No live write, booking, reschedule or phone test ran.
- Comparing today's source tool contract to that older production returned a
  mismatch: seven preflight assertions passed, one failed. This is source/deployment
  drift, not evidence that production's current Vapi assistant and backend disagree.
  That separate pair was not freshly compared in full.
- Vapi displayed Atrium v2 version v23, its existing unsaved draft and **$1.14** credit.
  No draft was published/discarded, no voice changed and no paid run started. The
  initial Logs loading state is not evidence of an empty account call history.

Production promotion remains separately pending under AT-129. Automatic approval
review previously rejected Force Promote because preview authentication was
unavailable. This branch does not bypass that rejection. No live environment,
credential, routing, provider, migration or production change was made here.

## Remaining limits

Signed audio links remain usable until the provider expires them; ending an Atrium
session cannot revoke an already issued external capability. Access is checked when
requesting it. Only mono playback is implemented. Shared legacy login still has its
existing organization-wide authority. Real hosted recording retrieval, physical
mobile devices and provider retention settings require their own verification.

The owner's Vast.ai and licensed Black American/Latina female voice direction remains
in [the leasing goal](../docs/leasing-goal.md) and
[the hosting/audition protocol](../docs/voice-provider-evaluation.md). No audition,
candidate selection, latency improvement or infrastructure switch is claimed.

## Owner and next-agent to-dos / reciprocal handoff

Owner:

1. Resolve the separately pending production promotion decision; coordinate the
   reviewed managed-runtime setup needed by the new feature chain.
2. Fund calling credit before a permitted phone rehearsal; provide a bounded budget
   and secure account access for any paid hosting/voice trial. Choose a voice after
   hearing candidates over the actual phone path.
3. Supply permissioned representative leasing calls and verified property policies.

Codex/Fable:

1. Review this exact source branch, run/inspect its cloud checks, and integrate only
   the recorded task scope. Preserve the original checkout's partial calendar work.
2. Prepare the approved environment release with matching backend/tool definitions;
   verify current login, property isolation and recording playback on the hosted
   build. Do not describe the current preview or older production as this increment.
3. Establish a successful phone-to-tool-to-dashboard baseline. Continue the voice
   audition and component-isolated hosting comparison using real latency and action
   correctness, rather than dashboard estimates or synthetic-test totals.
4. Verify the pending permissioned messaging/callback flows on approved providers,
   then collect held-out pilot evidence. Local regression counts are not a measured
   leasing success rate or containment result.

End the next session with a reciprocal handoff containing exact commits/deployments,
changes, actual checks and limitations, owner to-dos and next-agent to-dos. Require
the following agent to do the same. The overall product goal remains active.
