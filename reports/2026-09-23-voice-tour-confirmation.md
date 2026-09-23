# Voice tour confirmation integration

September 23, 2026, AT-141. Branch `codex/at141-voice-tour-confirmation`, based on
`c0d003dea0613e38854fd950c67e1e522f16ba79`. This connects a missing leasing step:
the voice assistant previously could book a tour and email an apartment shortlist,
while tour confirmation email was available only through the staff calendar.

## Implemented behavior

After a confirmed booking with a matching saved email, the voice tool can prepare
the exact tour confirmation, ask a dated recipient permission question, and submit
only after a fresh clear reply in the authenticated conversation history. Neither
the model nor caller supplies a booking ID, sender, HTML or consent boolean to this
tool. The backend derives them from the current property, call and saved reservation.

Preparation binds the tour revision, content, recipient, property configuration,
five-minute deadline and conversation-history boundary. Held, changed, uncertain,
past, removed or foreign-call reservations cannot send. Explicit property opt-in and
the existing reviewed sender/provider are required. Booking itself sends no email.

Voice and staff share one durable confirmation record under the same property lock.
Consent, receipt, action, outbox and record are admitted atomically, including when
staff and voice act concurrently. The staff Calendar confirmation view reads that
same action. A lost request or provider response cannot create a replacement email.
Saved but unstarted voice requests remain queued for explicit staff processing;
voice status/retries cannot silently initiate them. This is an intentional recovery
boundary, not a claim of unattended first-send recovery.

The provider submission is bounded. Current call/tour/sender/permission state is
checked again before the external write. Provider acceptance is reported separately
from delivery, which needs exact message/recipient/provider readback. Staff can
verify an existing dispatch after the call ends; the existing verification worker
also supports the tour-confirmation purpose when separately activated.

The source adds a ninth function tool and updates the booking response and prompt.
Existing voice/model settings are untouched. No new dependency, schema migration,
sender, credential, live call, email, GPU rental or production change is included.
[Configuration and behavior contract](../docs/email-delivery.md#permissioned-voice-tour-confirmation).

## Verification

Node 22.23.2:

- `npm run check`: typecheck and fixture validation passed; **1,739 tests passed**.
- `node --test --test-concurrency=2 'test/database/*.test.mjs'`: **606 passed** in
  approximately 196 seconds, including **24 new voice-confirmation cases**. These use
  actual local webhook/staff HTTP handlers, disposable PostgreSQL, native sessions
  and synthetic email-provider HTTP. No real messages or paid calls.
- `npm run build`: **22 API handlers** imported and refused unconfigured requests
  in both runtime modes.
- `node test/browser/tour-confirmations.mjs` with local Playwright/Chrome paths:
  **12 scenario groups passed** at 320/390/1280 pixels. Real local staff HTTP,
  permission controls, missing-provider state, delivery checks, stale forms and
  dropped queue/process replies were exercised. Five synthetic submissions,
  zero real emails. The mobile screenshot was visually inspected. No physical
  phone/Safari result is claimed.
- Earlier focused 23-case and full 605-case native runs also passed. The final run
  above includes the strengthened unit-block fixture and additional other-unit case.

The new native checks cover real booking→preparation→permission→submission→delivery
and staff readback, refusals/unclear or unrelated agreement, missing artifacts,
model-injected permission, fresh preparation/replay, wrong property/call, missing
or changed recipient, booking revision/time changes, unit holds, removed/uncertain
tours, missing provider/opt-in, staff/voice concurrency, lost webhook responses,
unknown provider acknowledgements, wrong-recipient readback, revoked channel,
optional email, expired offers, call completion, atomic rollback, saved-but-unstarted
recovery and a tour change between dispatch admission and provider IO.

Source review replaced a generic blocking fixture with the actual unit-block command
and added the different-apartment case so a passing test proves the intended scope.
The initial application run had one stale assertion expecting eight tools in the
publisher's description. It was updated to nine while retaining credential,
preservation and readback assertions. The final application run passed. This change
does not claim a newly published assistant or a working hosted preview.

## Limits and release boundary

Only a confirmed tour saved in this call with the matching saved email is eligible.
A missing/corrected address after booking requires staff review; the bot must not
rebook to repair contact details. Returning callers' reschedule/cancel requests still
use the existing staff-review flow. No SMS or marketing permission is added.

Authenticated speech artifacts provide permission evidence, not identity or email
ownership. Real phone transcription/chunking, pronunciation and permission-question
behavior remain untested for this increment. A later caller correction cannot be
atomically coordinated with an already in-flight external email. Provider delivery
does not establish a human read or primary-inbox placement.

Source publication requires a coordinated managed-backend, sender/voice opt-in and
exact tool/prompt release before activation. The older hosted legacy demo does not
gain this feature from a branch push. AT-129 production promotion remains separately
pending after automatic approval review rejected the preview with unavailable login
routes; this work does not bypass that rejection.

The preceding recording branch c0d003d has a successful GitHub Vercel status linking
deployment `99VJHPuF3PgY4W6ShbcVYrzsLiuC`. That status alone does not verify its login,
audio playback or application CI. No fresh production health/phone test was performed
in AT-141. Use the preceding report for dated observations, not assumed current state.

## Owner and next-agent to-dos / reciprocal handoff

Owner:

1. Resolve the pending production release decision and the managed-runtime setup.
2. Approve a real sending identity/domain and a permitted test recipient when the
   concrete activation is ready; put credentials directly in the deployment store.
3. Fund a permitted phone rehearsal and bounded voice/hosting comparison. Choose a
   licensed Black American or Latina female voice after listening; provide permissioned
   leasing calls and verified property policies for the held-out evaluation.

Codex/Fable:

1. Review this exact branch, its shared staff/voice admission and error recovery,
   then inspect cloud checks. Preserve the original checkout's partial calendar work.
2. Coordinate an approved backend/assistant release; publish nine matching tool
   definitions only to the compatible environment. Verify real phone→booking→email
   delivery→staff calendar outcomes, failure handling and timing before claiming live.
3. Improve late email correction and returning-caller tour changes through explicit,
   verified authority. Do not evade those boundaries with a duplicate reservation.
4. Continue measured hosting/voice comparison and permissioned pilot discovery. A
   larger local test count is not evidence of 95% live call success, containment or
   lower speech latency.

End the next session with a reciprocal handoff: exact commits/deployments, changes,
actual checks/failures and limits, owner to-dos and next-agent to-dos. Require the
following agent to do the same. The full product goal remains active.
