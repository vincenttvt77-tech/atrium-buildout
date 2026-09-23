# Permissioned website callbacks

Implemented in source for the managed PostgreSQL workspace. Publishing this code does
not enable calling, create a Vapi assistant, install Turnstile, or modify an existing
website’s configuration. The hosted legacy demo cannot use this flow.

A visitor enters a name and +1 phone number and explicitly requests one immediate AI
leasing call. The server verifies the challenge, current property publication and
registered website/voice routes before admitting the request. Admission atomically
saves the exact displayed permission, immutable call intent, opaque browser receipt
and rate budget. The HTTP request then attempts one bounded Vapi call submission.
The target is initiation within approximately 15 seconds, not a promise that a
person answers within that time. Synthetic timings are not production latency.

## Property activation

Publish `property.websiteCallback` in the existing reviewed property configuration:

```json
{
  "enabled": true,
  "organizationId": "your-organization-id",
  "propertyId": "your-property-id",
  "channelId": "your-website-channel",
  "origin": "https://leasing.example.com",
  "providerOrgId": "reviewed-vapi-organization-uuid",
  "assistantId": "reviewed-vapi-assistant-uuid",
  "assistantVersion": "reviewed-version-string",
  "phoneNumberId": "reviewed-vapi-phone-number-uuid",
  "reviewedAt": "2026-09-23T12:00:00Z",
  "reviewExpiresAt": "2026-09-30T12:00:00Z",
  "dailyLimit": 10,
  "hours": [
    { "day": 1, "start": 600, "end": 1080 },
    { "day": 2, "start": 600, "end": 1080 },
    { "day": 3, "start": 600, "end": 1080 },
    { "day": 4, "start": 600, "end": 1080 },
    { "day": 5, "start": 600, "end": 1080 }
  ]
}
```

These identifiers are placeholders, deliberately not usable production credentials.
The review is valid for at most 30 days and must still be current. `reviewedAt` must be on or before publication. Hours use the property’s
validated time zone, day0=Sunday, and minutes after midnight. Intervals include the
start and exclude the end. Split overnight hours across adjacent days. The quota
is a rolling24-hour admission budget, despite the convenient `dailyLimit` name.
Maximum50 admissions per property, one per phone per24 hours, three per canonical
client network per hour. Queued requests consume quota even if no call is confirmed;
this prevents uncertain outcomes from becoming a redial loophole.

Register an active `website-callback` channel with that exact external `channelId`,
organization/property and `read,operate` capabilities. Register the reviewed Vapi
assistant through the existing `vapi` channel path in the same property. The website
channel’s SQL visibility is not widened: a separate server-side authorization lookup
validates the published assistant route and matching current configuration before
and after provider waits. A known public channel ID is not a general API credential.

One-time deployment configuration needs the existing `VAPI_API_KEY` plus
`CALLBACK_TURNSTILE_SITE_KEY` and `CALLBACK_TURNSTILE_SECRET`. Configure Turnstile for
the exact approved website hostname. The server verifies `hostname`,
`action=atrium-callback`, `cdata=channelId`, timestamp and success with Cloudflare.
Tokens and secrets are not saved with the request. This challenge mitigates abuse;
it does **not** verify ownership of the telephone number. Review destination and
spend limits, recording/disclosure requirements and abuse monitoring before exposure.
These are service settings, not environment files required for ordinary user logins.

Confirm the pinned assistant version’s tool URLs, webhook authentication, property
rules, caller handling and provider credit with a permissioned live test before
activation. `configured` in this feature means a server key and reviewed binding
exist; it does not prove credit, provider availability or real phone success. The
per-call override changes only the first greeting/mode and maximum duration300s.
It discloses AI, the website request and recording, then asks whether it is a good
time. The saved inbound assistant is not edited or republished by this flow.

## Website integration

Serve the widget assets from Atrium’s HTTPS backend and add the reviewed channel:

```html
<link rel="stylesheet" href="https://YOUR-ATRIUM-HOST/callback-widget.css">
<div data-atrium-callback data-widget-id="your-website-channel"></div>
<script src="https://YOUR-ATRIUM-HOST/callback-widget.js" defer></script>
```

Replace the host and channel with actual reviewed values. The script derives its
API origin from its own URL. The existing Larkin page has an empty widget ID, so
this change introduces no unconfigured call form into the live demo. Activate its
ID only after the preceding checks. CSP must allow Atrium’s script/style/connect
origin and Cloudflare’s documented Turnstile resources. The public API uses exact
CORS origins and JSON POSTs, omits cookies, and never accepts caller-chosen assistant,
phone resource, provider URL, tenant IDs or message text. Cloudflare is verified
server-side, not trusted because the checkbox appeared in the browser.

Outside calling hours, the form offers the published contact number rather than
saving a request that could unexpectedly ring later. A request expires for first
dispatch within two minutes and before the next closed interval. Vapi receives
`earliestAt` three seconds ahead of submission and `latestAt` at that deadline;
readback must match the authorized scheduling window. Provider enforcement and
actual start latency still require a live acceptance test. Atrium never retries it as a next-day call. This
increment supports +1 numbering syntax, not every international calling destination.
The syntactic check does not establish a number’s location or ownership.

## Outcomes and recovery

Vapi initiation uses a saved assistant ID **and version**. The current official SDK
lists `assistantVersion` and `assistantOverrides`; its `CreateCallDto` does not list
top-level `metadata`. Correlation therefore uses the documented call `name`, saved
call UUID and exact account/assistant/version/phone/customer/greeting readback.
No provider idempotency guarantee is assumed. Dispatch is durably marked before
network I/O; a timeout, missing ID or uncertain acknowledgement cannot trigger a
second POST. Reads are bounded, fixed-origin and refuse redirects or oversized bodies.

The visitor’s receipt survives page reloads in session storage without a stored
name or telephone number. Status requires that unpredictable receipt token and the
same approved website. A lost response retains the receipt; the form checks the
existing request instead of generating a replacement. Completed/uncertain requests
remain visible for24 hours in that browser session. A failed server after admission
can leave a saved request with no call: staff can inspect it and contact the visitor
through their normal process, but this increment does not install a background
dialer or automatic first-dispatch recovery.

**Work queue → All work / Finished** includes the saved contact and initiation
result. `operate` staff can check the exact existing call; viewers cannot invoke
that control. It never initiates a call. Status may be saved, checking, scheduled, queued,
ringing, in-progress, forwarding, ended, cancelled or needs-review. Every observation is dated.
“Ended” does not prove a human conversation; “in-progress” does not prove a booking.
Initiation’s workflow completion is distinct from the leasing outcome. The existing
authenticated voice webhook retains conversation/lead activity in Calls and Leads;
real callback phone-to-tool-to-dashboard acceptance remains a deployment gate.

The work-queue recovery controls remain separate configure-authorized operations.
Requeueing uncertain work resumes bounded verification; it does not redial. Changes
to publication or routing can hold old requests for human review. A provider
outage keeps the last dated observation, not an invented current status. The browser
polls briefly and then offers an explicit check; no unbounded background polling or
production schedule is installed.

## Evidence and next-owner responsibilities

See the scoped [implementation report](../reports/2026-09-23-website-callbacks.md).
Native tests use real disposable PostgreSQL and loopback HTTP implementations of
Vapi and Cloudflare. Browser acceptance uses actual Chromium plus that backend,
with synthetic website transport and challenge UI; it does not prove live DNS,
TLS/CORS/CSP, Cloudflare bot resistance, Vapi credit, audio, latency or phone delivery.

Owner: verify property calling rules, approve reviewed callback configuration and
provider spend limits, fund calling credit, and provide a permitted recipient for
live acceptance. Keep voice auditions separate from this backend release.
Next agent: review the source, run the documented deployment gates after approved
managed-runtime activation, verify one real request through call/lead/calendar and
record actual initiation latency and failure handling. Leave a reciprocal handoff
with owner and next-agent to-dos and exact local/sandbox/production evidence.

Sources checked September23,2026: [Vapi outbound calls](https://docs.vapi.ai/calls/outbound-calling),
[official CreateCallDto](https://github.com/VapiAI/server-sdk-typescript/blob/main/src/api/resources/calls/client/requests/CreateCallDto.ts),
[official call response](https://github.com/VapiAI/server-sdk-typescript/blob/main/src/api/types/Call.ts),
[assistant overrides](https://github.com/VapiAI/server-sdk-typescript/blob/main/src/api/types/AssistantOverrides.ts),
[Turnstile server verification](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

Queued-call scheduling uses the [official SchedulePlan contract](https://github.com/VapiAI/server-sdk-typescript/blob/main/src/api/types/SchedulePlan.ts). Its deadline is sent to the provider; local checks alone cannot guarantee external enforcement.
