# Accounts and isolated property workspaces

Atrium has two explicit runtime paths. `ATRIUM_RUNTIME_MODE=postgres` uses persisted
users, organization memberships, property grants and published property configuration.
With that variable and both database URLs absent, the compatibility path uses legacy
named accounts or a single shared passcode. Selecting a mode does not migrate data.
The local preview selects PostgreSQL; a hosted legacy deployment continues to require
its own authentication and durable KV configuration.

With persisted or legacy named accounts, staff sign in with a username and password,
then open an authorized property when a picker is shown. The legacy shared-passcode
mode retains its separate passcode login. They do not enter database URLs, change environment variables
or create a deployment for each login. Deployment setup and account provisioning are
administrative work. See [the runtime contract](db/README.md#opt-in-runtime) and
[architecture boundaries](ARCHITECTURE.md#1-current-code-and-its-actual-guarantees).

## Persistent local preview

Run `npm run dev:ops` with Node 22 for `http://localhost:4300/`.
`npm run dev:ops -- --port 4301` changes the HTTP port; it does not create another
workspace. The HTTP server and its private PostgreSQL instance listen on loopback.
Only one preview process may open the same ignored `.atrium-local/` database.

On first setup, [the local database helper](scripts/lib/local-database.mjs) imports
the existing `larkin` salted password hash from `.env.demo-account.json` into a
persisted user. Its legacy `demo-larkin` identity is explicitly mapped to organization
`org-demo-larkin` and property `prop-demo`, with a property grant for the local owner.
If the private account file does not exist, the helper creates a random password and
startup shows it once in the terminal. The account file and database configuration
have owner-only permissions; neither stores the login password in plaintext. Keep
the generated password in a password manager.

Subsequent logins read the persisted database credential. Restarting the preview
preserves users, credentials, memberships, tour settings, bookings, blocks, leads,
follow-ups and staff changes. The original account hash is not reapplied after import;
editing the import file is not a way to reset an existing database user's password.
Sample calls are imported once with checkpointed progress and retained dates.
`npm run dev:ops -- --no-seed` skips fixture import without clearing saved records.
Malformed private files or an uncertain interrupted import fail instead of resetting
data. Stop the preview normally before reopening it.

This fixture server ignores external database/KV/Vapi credentials. Its calls and
inventory are explicitly fictional, and inventory source timestamps are preserved.
It does not connect to a live Vapi assistant or PMS. Local users and passwords are not
automatically provisioned in a hosted portal. See [local database notes](db/README.md#local-preview-and-verification).

## PostgreSQL accounts and deployment setup

Configure `ATRIUM_RUNTIME_MODE=postgres`, the separate `ATRIUM_DATABASE_URL`
(`atrium_app`) and `ATRIUM_AUTH_DATABASE_URL` (`atrium_authenticator`) role connections,
and an independent `OPS_SESSION_SECRET` once per deployment environment. Use its
secret store; do not supply administrator connections to HTTP handlers. Invalid
configuration fails closed, without falling back to legacy users, bundled property
data, KV or memory. Full connection, TLS and migration requirements are in
[db/README.md](db/README.md#opt-in-runtime).

Users, credentials, organizations, memberships and property grants are persisted
records, not one environment entry per PostgreSQL account. Sessions contain user
identity, credential version, registered session ID and fixed expiration, with no
active property or cached role. Each request verifies that the session remains
registered, unrevoked and unexpired. Current credential status, membership, grants and property status are checked again
when authorizing operations. Viewers have `read`; staff also have `operate`; admins
and owners have `configure` and membership permissions. A role does not implicitly
grant every property: organization-wide access or explicit property grants determine
which properties the user may open.

Interactive PostgreSQL sign-in allows 20 attempts per normalized username and 100
per client network in a rolling 15-minute window, shared across server instances.
Successful attempts count too. A generic retry response does not disclose account
existence; protection failures refuse new sign-ins without falling back to another
login mode. Existing sessions and logout are unaffected. This uses the deployment
session secret already configured, with no extra per-user environment setup.
See [shared login protection](docs/adr/0004-login-protection.md) for proxy handling,
privacy, temporary lockout tradeoffs and required database provisioning.

The dashboard and APIs already use these boundaries. This does not establish a
complete customer-onboarding system, hosted database rollout, enterprise SSO or verified
resident identity. Track implementation and remaining work in
[ARCHITECTURE.md](ARCHITECTURE.md), rather than treating an account record as a completed
customer deployment.

PostgreSQL users can change their own password under **Status → Account security**,
or from the property picker even without an active property grant. The current
password is required, and a confirmed change invalidates earlier sessions. This
changes a persisted user record without an environment-file edit. It does not
reset another user’s password, supply forgotten-password recovery, or change the
separate hosted legacy passcode. See [personal account security](docs/adr/0002-personal-account-security.md).

The same account page lists active logins and can sign out one session or all other
sessions. Sessions expire eight hours after registration; activity does not renew
them. New logins above the 20-active-session limit revoke the oldest active login.
Session controls and logout are bound to the identity/session that rendered the
page, so a stale tab cannot revoke a replacement login. A failed or uncertain
response does not confirm sign-out. Deploying the registered-session migration and
application requires one fresh sign-in for old PostgreSQL cookies, using the same
password. Historical security records remain retained; their retention policy is
follow-on work. See [revocable sessions](docs/adr/0005-revocable-sessions.md).

PostgreSQL passkeys use a deployment-configured `ATRIUM_AUTH_ORIGIN` and required
WebAuthn user verification. Enrolled users and active owner/admin/staff accounts
must verify the current registered session before property operations or password
changes. Passkey setup/recovery and own-session controls remain available while
verification is pending. Pending registration is activated only after a separate
signed assertion. Ten single-use recovery codes plus the current password allow
replacement setup; verification of that replacement revokes prior keys and other
sessions. Recovery alone does not grant administrator assurance. These controls
are implemented and locally tested; production activation and physical device
acceptance remain separate. See [passkeys](docs/adr/0006-multi-factor-authentication.md).

## Legacy named accounts and shared passcode

For the legacy named-account adapter, set `OPS_SESSION_SECRET` to an independent random secret of at least 32 characters and `OPS_ACCOUNTS_JSON` to an array of records:

```json
[
  {
    "username": "operator",
    "passwordHash": "<salted scrypt hash generated by hashPassword>",
    "tenantId": "client-one",
    "displayName": "Client One",
    "assistantIds": []
  }
]
```

`hashPassword(password)` is exported by `src/ops/accounts.ts`; pass it a password read from a protected local input, not a command-line argument. It returns the supported scrypt format. Keep both the hashes and signing key in secret configuration, never in browser code or a commit. Users belonging to the same client can share a stable tenant ID; different clients must use different IDs. Configured legacy tenant IDs start with a lowercase letter, contain only lowercase letters, digits and hyphens, are at most 63 characters, and cannot be `legacy`. Usernames are unique. Changing tenant IDs does not migrate old data.

The server checks the current configured account on every request. Removing an account, changing its password or membership, or rotating the session secret invalidates its old session. Named-account mode rejects the legacy passcode/header, even if `OPS_DASHBOARD_PASSCODE` remains set. Empty/malformed account configuration refuses access rather than reverting to legacy mode. If `OPS_ACCOUNTS_JSON` is absent entirely, the prior single-workspace passcode remains available for staged migration.

## Data boundary

In PostgreSQL mode, the authenticated user selects an authorized organization/property
through the dashboard URL. The page freezes that selection and sends
`x-atrium-organization-id`, `x-atrium-property-id` and `x-atrium-config-version` with
operational requests. Those values request a scope; they do not grant access. The
server issues an authorized scope, loads the published property snapshot, and rechecks
current permission/configuration around database work. Responses echo the scope so a
stale page cannot display another property's results. Switching properties loads a new
page; different tabs can retain different properties under one user session. See the
[HTTP contract](db/README.md#http-and-portal-contract).

In legacy mode, the authenticated session determines the tenant. Body/query tenant
IDs cannot retarget storage. The portal sends its frozen `x-atrium-tenant-id` as a
consistency check: a mismatch with the signed-in account returns 409 instead of using
the new cookie's workspace. New feedback, unit-availability, reschedule and tour-change
review writes require that header; compatible older actions may omit it. The whole
asynchronous request runs in the authenticated tenant context:

- Named Redis records: `atrium:tenant:<tenantId>:<logicalKey>`.
- Existing legacy records keep their original `atrium:<logicalKey>` keys. Reserved tenant keys cannot be read through the legacy adapter.
- In-memory records and event buffers are separate per tenant. Vapi history caches include tenant and assistant bindings.
- Lists, notes, follow-up status changes, tour settings, calendar blocks and reset actions use the same scope as reads.

There is no general automatic migration of hosted legacy records. Their original namespaces remain until an explicit reviewed migration assigns ownership. The local Larkin bootstrap above is a specific fixture import, not a migration of all accounts or live KV data. Newly provisioned accounts do not receive fictional operational records unless explicitly seeded.

## Tour settings and calendar API

**Tour settings** belong to the selected authorized property in PostgreSQL mode, or the signed-in tenant in legacy mode. Authorized operators can change the weekly schedule and these booking rules (PostgreSQL requires `configure`):

| Setting | Accepted value |
| --- | --- |
| Simultaneous staff capacity | 1–50 tours |
| Tour duration | 5–240 whole minutes |
| Start-time spacing | 5–120 whole minutes |
| Buffer before and after each tour | 0–120 whole minutes on each side |
| Minimum booking notice | 0–10,080 whole minutes |
| Advance booking limit | `null` for unlimited, or 1–730 whole days |
| Same-apartment policy | `exclusive` or `shared`, always within staff capacity |
| Weekly hours | Days `0` (Sunday) through `6` (Saturday); omit a day to close it |

Opening and closing hours use decimal hours at whole-minute precision. Each open day must fit a complete tour; a closing hour of `24` means midnight at the end of the day. Scheduling, calendar dates, spoken booking labels and follow-up times use the property’s validated IANA timezone, including daylight-saving changes. PostgreSQL reads the authoritative timezone from the property record and validates the published property/inventory bundle; legacy callers without an explicit timezone retain `America/New_York` compatibility. A browser request cannot choose a different authoritative timezone. Configuration support is implemented; general property onboarding remains separate work. The calendar is not connected to a PMS, Google Calendar or another external calendar.

`GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` returns the inclusive requested range, up to 62 days per request, together with `settings` and `settingsRevision`. Calendar navigation loads one visible day or week at a time and is independent of the advance booking limit. Historical tours remain visible; past times and times outside the notice/window rules are not bookable. Dates are supported from 1900 through 9998.

To change settings, send an authenticated, scoped `POST /api/calendar` with `action: "settings"`, the complete `settings` object, the `settingsRevision` read when editing began, and `expectedTimeZone` matching the page’s property timezone. PostgreSQL requires `configure` permission. A concurrent settings change returns HTTP 409 rather than silently overwriting it. Optional `from` and `to` fields keep the response on the displayed range. Settings are stored atomically in the scoped calendar state. PostgreSQL starts from required published `property.tourSettings`, with saved calendar overrides; legacy mode uses its bundled defaults. New availability and the property's verified Vapi tool requests use those same rules.

Existing bookings retain their original start, end and reserved staff interval after settings change; reducing capacity does not cancel or shorten a saved tour. Blocks refer to their saved targets and intervals, including when they make several overlapping start times unavailable. Reopening a projected start time removes its actual saved block; Undo restores that block's original bounds.

The selected PostgreSQL adapter persists settings and bookings by organization/property, including in the local preview. Hosted legacy mode persists them in its KV namespace and refuses missing or partial KV configuration. Only nonhosted legacy development/test adapters may use memory; that is not the `dev:ops` preview. Storage and timezone checks do not establish live PMS synchronization or live Vapi call behavior.

## Vapi ownership

In legacy named-account mode, `assistantIds` is a server-controlled allowlist. A Vapi assistant cannot be assigned to different tenants. Authenticated incoming webhooks use `message.call.assistantId` to select the bound workspace; missing/unassigned assistants are refused. Named-mode webhooks require `VAPI_WEBHOOK_SECRET`, including local tests. No tenant is accepted from assistant-generated tool arguments.

Call history requests are filtered to bound assistants and checked again before returning data. An account with no assistant binding reads no organization-wide history. Legacy assistant publishing requires exactly one bound assistant, `VAPI_SYNC_TENANT_ID` matching that tenant, and `VAPI_SERVER_BASE_URL` as the canonical origin. Production origins must use HTTPS. Preview deployments cannot publish to a live assistant. Successful publishing includes read-back verification. Verify deployed webhook credentials and the saved assistant/backend contract together when activating or changing an environment.

In PostgreSQL mode, verified incoming Vapi identity resolves a persisted, active
`channel_bindings` record into its organization/property. The binding's capability,
version and published configuration are checked; model arguments are not routing
authority. Call history is restricted to that property's bindings and revalidated
after fetching. Property assistant publishing remains disabled in the PostgreSQL
path; the legacy bundled-property publisher is not a general property publisher.

## Verification and limits

`api/test/tenant-isolation.test.ts` exercises identical caller/call IDs across two accounts, private notes, follow-up ownership, scoped reset controls, event logs, cached Vapi history, forged tenant inputs and concurrent asynchronous requests. It also changes one account's tour capacity from two to three while leaving the other at two, then verifies that authenticated calendar responses and Vapi tool responses offer the remaining place only in the correct account. Auth and Vapi suites cover session tampering/revocation and assistant ownership. KV tests exercise actual command namespaces through a Redis test double; they do not claim a live Redis deployment was tested.

The persisted PostgreSQL HTTP/property and restart boundaries are covered separately
by [native database tests](test/database/) and [portal scope tests](test/portal/property-scope.test.mjs).
These include role/grant enforcement and property isolation; local tests do not
establish hosted verification. The legacy named-account adapter
still gives its configured users staff access within their tenant and uses bundled
property content. PostgreSQL supports published per-property data and role permissions;
the local seed is specifically the fictional Larkin property. General customer
onboarding, verified invitations and new-member onboarding, hosted MFA rollout/SSO, resident identity, PMS integration and
commercial rollout acceptance remain tracked in [ARCHITECTURE.md](ARCHITECTURE.md).


### Existing organization members

In PostgreSQL mode, `/api/organizations` is independent of published property
configuration. A fresh session-bound administrator passkey proof is required for
its directory and writes. Owners manage only their organization and grant scope;
admins manage staff/viewers within their own grant scope. Full access replacement
uses a current aggregate member version, organization/action-bound CSRF token,
exact signed-in user/session headers, and an atomic audit/receipt. Concurrent owner
removal is serialized and cannot leave an organization without an active owner.
A global user may belong to several organizations; changing one membership does
not change that user's identity or other memberships. This existing-member screen
does not yet invite staff, establish a verified recipient, or create customers.

### Resident records and service requests

`/api/resident-services` is available only in PostgreSQL mode to registered staff
with current property `operate` permission and the required session verification.
Viewers and channel principals cannot read resident contacts or case history.
Managers with `configure` permission can add, review or revoke occupancy evidence.
All records, relationships, history and receipts retain organization/property scope.
An organization person ID contains no shared contact details; names and contacts
remain property-specific. No phone/email match links records across properties.

Source review establishes a documented occupancy claim, not caller identity,
household authority, entry consent or spending permission. Intake accepts unknown
reporters; resident-reported unit planning needs current context. Explicit staff
observations support known vacant units, and common areas use their own location
context. A stale source triggers current review even after historical triage.
Versioned commands and exact replay receipts preserve history and prevent duplicate
writes after an interrupted save. See [ADR 0010](docs/adr/0010-resident-service-records.md)
for the complete boundary and remaining verification/fulfillment work.
