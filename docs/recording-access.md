# Scoped call recording playback

AT-140, September 23, 2026. The Calls detail panel opens saved audio in an accessible
dialog. This reads an existing recording; it does not place a call or enable recording.

## Why fresh access is required

Vapi documents authenticated artifact downloads through a call-specific endpoint
which returns a short-lived signed URL. Direct bucket links may be private or expired.
The server therefore obtains a new capability when staff deliberately open or refresh
the player. It never follows the download redirect or forwards its private key to the
browser. [Vapi artifact download contract](https://docs.vapi.ai/assistants/retrieve-call-artifacts).

## Authorization and transport

`GET /api/recordings?callId=<saved Vapi UUID>` accepts no other query fields. The
ordinary dashboard session and frozen property headers apply. In PostgreSQL mode,
current `read` permission, session verification, published configuration and active
assistant bindings are resolved through the existing runtime. In legacy named-account
mode, the exact tenant header and configured assistant allowlist apply. An unbound
property/account receives no organization-wide access. The older shared-passcode
mode retains organization-wide call access; it is not tenant isolation.

The server reads the exact call from Vapi and verifies its ID and assistant ownership,
then requests `/call/{id}/mono-recording` with redirects disabled. Authorization and
binding/configuration state are checked again after both provider waits. Known
revocations or configuration changes prevent the URL from being returned. Responses
are private and not cacheable, and contain no provider key or raw upstream error.
Metadata is bounded to 1 MiB; provider IO shares an eight-second deadline.

The returned destination must be HTTPS, with no credentials, explicit nonstandard
port, fragment, IP literal or local/reserved hostname. This is a URL-format check,
not a storage-host allowlist. Only the fixed Vapi API is contacted by the server.
The browser uses the provider-issued destination as an audio source under `media-src
https:`; it does not navigate there. The existing script/connect policies remain.

The signed URL is a temporary bearer capability visible to the authorized browser.
Already issued URLs cannot be revoked by closing this portal or ending its session;
provider expiry/retention controls still apply. No signed URL is persisted by this
feature. It does not download, proxy, export or delete audio, configure retention,
or introduce a new recording consent policy. The player currently requests mono audio.

## User experience and deployment

History advertises `recordingAvailable` while retaining a null `recordingUrl` field
for response compatibility. A safe provider artifact reference and a real call UUID
enable the button; synthetic placeholder links do not. Availability is a hint:
deleted audio or later access loss is checked when opening it.

The player uses native audio controls and does not fetch audio until playback.
Dashboard polling preserves the playing element. Close, Escape, navigation or
property-access invalidation closes/stops the player; delayed responses cannot reopen
it. Expired or failed playback has an explicit refresh action and truthful failure
copy. Closing the dialog restores keyboard focus when the initiating control remains.

Deploy the endpoint, normalized history, dashboard source/generated artifacts and
media policy together. It uses the existing server-side private Vapi credential and
assistant bindings; no per-user environment entry, new dependency or schema migration
is needed. Local fixture calls are not real provider recordings. Source publication
does not prove hosted playback or authorize production promotion.

## Verification

Focused unit/API coverage checks malformed IDs, private errors, URL validation,
timeouts, shared/named legacy authorization and credential/binding changes. Native
PostgreSQL HTTP tests verify role/property isolation and revocation/configuration
changes across provider waits. Chromium uses real local authorization with synthetic
provider metadata and an 8 kHz WAV: keyboard/mobile playback, polling, unavailable
audio, refresh, delayed close and mismatched-property responses.

See [the acceptance report](../reports/2026-09-23-recording-access.md) for exact results,
release evidence, remaining work and reciprocal handoff. These tests do not establish
live Vapi recordings, actual telephone quality, voice latency or a hosting improvement.
