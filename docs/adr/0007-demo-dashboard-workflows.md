# ADR 0007: An apartment workspace for tour preparation

Status: implemented locally; browser and release integration owned by the coordinator.

## Decision and audience

The dashboard should help a commercial building owner or property manager understand
what happened and what to do next. It must be comfortable for an older operator who
does not use complex software every day, while presenting a polished, capable product
to an experienced operator. The demonstration story is a call becoming a useful
prospect record, a suitable apartment and a saved tour, followed by an informed staff
action. Each claimed outcome must correspond to an actual record.

Use an apartment workspace to join the information Atrium already holds. Keep Today
as the current property’s attention queue and Leads as the person record. Avoid
adding another pipeline, rent roll, resident register or a replacement PMS in this
change. These choices do not close the broader leasing, resident, maintenance,
intelligence or integration requirements described in [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Implemented workflow

- **Units** opens the whole property's next seven days of saved tours. An interactive
  apartment explorer opens one apartment's tour brief. The tile arrangement is
  explicitly a catalogue, not a floor plan; floor labels use the supplied floor field.
- Each brief joins canonical calendar bookings to a prospect by exact phone identity.
  It shows recorded budget and move timing, uncertainty in those facts, the latest
  staff note, and links to the person and the calendar. Historical profile bookings
  cannot create a duplicate tour or undo a later calendar change in this view.
- Overlapping unit holds remain visible beside the retained booking. Staff can open
  the existing Unit availability dialog; it keeps the existing authorization,
  revision, scope and retry protections. Viewing a conflict does not move a booking.
- Saved feedback and recurring reasons remain editable through the existing scoped
  feedback workflow. Links from a prospect's tour history return to the apartment.
  Prior apartment references retain saved context when a source catalogue changes.
- Rent and status are snapshot facts. Fictional demo data stays labelled and source
  details remain accessible. Counts cover the displayed period and loaded feedback;
  the latest-500 limit is not presented as lifetime data. Missing rent stays missing.

The seven-day window follows the property's local calendar dates, includes an ongoing
tour, and never labels a scheduled or past booking as verified attendance. Booking
counts become unconfirmed when the calendar has not loaded, has an error or has not
refreshed for more than a minute. Contact and availability shortcuts disappear until
their relevant records are current. Existing server authorization remains authoritative.

## Visual behavior

The navy tour brief, large dates and restrained apartment tiles give the demonstration
a clear focus. The explorer has shallow visual depth and pointer hover movement;
changing apartments has a brief 180 ms transition. Polling does not replay that
transition. Reduced-motion preferences disable selection and hover movement.
No actual building geometry is inferred, and no animated score or invented outcome
is used to impress the viewer. Primary actions and touch controls have a 44 px minimum.

## Calling today and a real Aircall integration

The new **Call in phone app** link opens the device's configured `tel:` handler.
It does not connect an Atrium softphone, invoke an outbound provider API or establish
that a call was placed. Aircall documents that a phone link can open Workspace if it
is installed and configured as the default handler. Its `/v1/users/:id/dial` API
prefills a user's dialer; that response alone is not proof of a completed call.
[Aircall click-to-dial documentation](https://developer.aircall.io/docs/implement-click-to-dial)

An actual in-dashboard calling experience can use Aircall Everywhere SDK **v2**,
which embeds Workspace in an iframe and exposes login and call lifecycle events.
SDK v1 is deprecated. The embedded experience needs the documented microphone and
other iframe permissions, including those of any containing frame.
[Aircall embedding documentation](https://developer.aircall.io/docs/embed)

Aircall recommends OAuth for an integration acting for multiple customers, and API
ID/token authentication for a private internal integration. A future integration
therefore needs an approved customer/partner setup and customer authorization before
Atrium can treat the provider as connected. No provider account, plan or entitlement
is selected by this change.
[Aircall authentication documentation](https://developer.aircall.io/docs/authentication)

The following are Atrium design requirements for that future implementation, rather
than claims that the SDK already provides them:

1. Bind each customer connection, permitted provider user and phone number to the
   correct organization and property. Never choose a property from mutable browser
   selection alone when receiving a provider event.
2. Keep provider secrets server-side. Review OAuth callbacks, disconnect/revocation,
   iframe permissions and Content Security Policy before enabling the embedded UI.
3. Feed verified provider events through the existing durable workflow boundaries,
   with stable event identities, audit and duplicate handling. Distinguish prepared,
   dialing, answered and ended states; confirm outcomes from provider evidence.
4. Demonstrate incoming and outgoing calls, permission refusal, disconnect, wrong
   property selection, browser microphone denial, duplicate callbacks and uncertain
   responses using an authorized account before claiming readiness. Provider costs,
   recording policy, retention and customer consent requirements need the appropriate
   owner decisions before activation.

## Evidence and boundaries

`test/portal/unit-workspace.test.mjs` executes the actual app and unit view source in a
controlled VM. It covers canonical booking joins, concurrent tours, local-date bounds,
buffer overlaps, stale and unloaded data, prior units, missing and demo facts,
escaping, viewer restrictions, property invalidation, action routing and reduced
motion. Existing feedback/form/scope tests remain in
`test/portal/property-scope.test.mjs`. These tests do not claim an actual browser call,
an Aircall connection, native WebAuthn execution or a production deployment.
