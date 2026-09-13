# PostgreSQL foundation

`schema.sql` is development source for the first property-scoped storage slice. It is
not a migration that has been applied to a shared database. The migration runner owns
the transaction, advisory lock and checksum history. Generate a migration filename
with `supabase migration new`, then copy the reviewed source into that file. Never
edit an already applied migration; use a new migration for subsequent changes.
Apply all reviewed files in `supabase/migrations/` in order; `schema.sql` alone does
not include later migrations such as immutable channel routing.

## Opt-in runtime

`src/application/runtime.ts` connects the persisted authorization/property repositories
to the dashboard, property catalogue, lead/calendar APIs and verified Vapi webhook.
This is a usable vertical slice behind an explicit runtime switch. It is not a
completed SaaS provisioning system or evidence of a hosted production cutover.

Set these values **once per deployment environment**, using its secret store:

| Variable | Required value |
| --- | --- |
| `ATRIUM_RUNTIME_MODE` | Exactly `postgres`. Leave the variable absent for the legacy adapter. |
| `ATRIUM_DATABASE_URL` | PostgreSQL URL whose login is the restricted `atrium_app` role. |
| `ATRIUM_AUTH_DATABASE_URL` | Separate PostgreSQL URL whose login is `atrium_authenticator`. |
| `OPS_SESSION_SECRET` | Independent random signing secret of at least 32 characters. |
| `ATRIUM_AUTH_ORIGIN` | Exact canonical HTTPS portal origin. HTTP is accepted only for localhost development; no path, query or fragment. |
| `ATRIUM_DATABASE_CA` | Optional PEM CA certificate for the database's trusted TLS chain. |

Both database URLs require host, username, password and one database path, with no
query parameters or fragments. Percent-encode credentials as URL components. The
driver enforces certificate verification for nonlocal connections; only a loopback
database in nonhosted development can use plaintext. The connection verifies the
actual login/current role and rejects administrator privileges or cross-role membership.
Do not supply a privileged URL and rely on `SET ROLE` to reduce it.

A blank/unknown runtime mode or either URL present without `postgres` fails closed.
PostgreSQL initialization errors never select KV, memory, environment-defined users
or bundled Larkin property data. `OPS_ACCOUNTS_JSON` and `OPS_DASHBOARD_PASSCODE` are
legacy identity sources; adding a PostgreSQL user does not require changing them.
The admin connection is deliberately absent from HTTP runtime configuration.
Each role pool currently allows four connections; account for function concurrency
and the database connection budget when selecting hosting/pooling.

Provision users, scrypt credential hashes, organizations, memberships and explicit
property grants through a reviewed administrative workflow. Configure channel
bindings and publish complete property bundles separately. The PostgreSQL portal includes personal password changes at `/api/account`.
Existing members are managed at `/api/organizations` using fresh administrator
passkey assurance. General customer onboarding, invitations and forgotten-password
recovery remain open; a personal password change is not an administrator reset.
The dedicated hosted demo database has been provisioned on Free Supabase.
Production runtime activation, the production backup policy and restore proof
remain separate open gates; native test success does not establish them.

## HTTP and portal contract

The PostgreSQL `a4` session is a signed user-only token containing `userId`,
`credentialVersion`, registered `sessionId` and fixed `expiresAt`; it contains no
current property or cached role. Authentication checks the exact unrevoked registry
record and rereads the active user/credential version. Authorization resolves
current membership, organization/property status and explicit grants per operation.

| Route | Scope and behavior |
| --- | --- |
| `GET/POST /api/dashboard` | Sign-in/logout and protected HTML. A signed-in user with multiple properties sees a picker; an explicit page uses `?organizationId=...&propertyId=...`. |
| `GET/POST /api/account` | Personal password change and active-session list/revocation. Requires a current registered user session; mutations require same-origin JSON and a signed user/session-bound form token. Independent of property access; absent in legacy mode. |
| `GET/POST /api/mfa` | Own passkey setup, verification, factor management and recovery. Exact configured origin, registered-session binding and CSRF checks on POST. Finite commands only; absent in legacy mode. |
| `GET/POST /api/organizations` | Scoped existing-member directory and full access replacement; fresh organization-administration MFA, org/action/session-bound form tokens and atomic versioned receipts. Independent of property publication; absent in legacy mode. |
| `GET/POST /api/resident-services` | Staff-only property resident records, maintenance intake, notes, triage and paginated history; configure-only source changes. Property/configuration/session-bound forms, atomic receipts and current context checks. No dispatch or caller verification; absent in legacy mode. |
| `GET/POST /api/maintenance-plans` | Scoped owner policy, approved vendors, versioned proposals and immutable decisions. Separate bound forms; protected actions require fresh administration MFA. Operate reads/proposals, configure vendor/decision actions, owner-only policy. No external execution; absent in legacy mode. |
| `GET/POST /api/workflows` | Property-scoped action queue; read permission for bounded listing, configure permission and same-origin JSON for recovery. Required expected row revision is checked under lock; no action creation, connector execution or legacy fallback. |
| `GET /api/properties` | Authenticated, unscoped catalogue of properties this user can read. It exposes safe labels, role/permissions and navigation links, not property inventories or credentials. |
| `GET /api/leads`, `/api/calendar`, `/api/vapi` | Require the user session and all three explicit property headers below; permission is `read`. |
| `POST /api/leads`, `/api/calendar` | Same explicit selection plus `operate`; calendar `settings` requires `configure`. Bulk demo resets are unavailable in PostgreSQL mode. |
| `POST /api/vapi` | Verified webhook secret and server-owned channel binding select the property. Browser headers or model-supplied property fields are not routing authority. |
| `POST /api/vapi-sync` | Checks `configure`, but property assistant publishing currently refuses; the bundled Larkin publisher is not reused for another property. |
| `GET /api/health` | Public minimal infrastructure probe; no user, property, count, password or connection URL disclosure. |

Every staff operational request supplies:

```text
x-atrium-organization-id: <selected organization ID>
x-atrium-property-id: <selected property ID>
x-atrium-config-version: <positive published configuration version>
```

These headers are selections, never proof of access. The server issues an opaque
authorized scope after authenticating the user, then loads that property's published
snapshot. SQL repository checks and RLS independently revalidate current authority
and configuration before an operation. Success responses echo:

```json
{
  "scope": {
    "organizationId": "selected-organization",
    "propertyId": "selected-property",
    "configurationVersion": 1,
    "permissionVersion": "server-derived-permission-fingerprint"
  }
}
```

The page captures its selection/version once, attaches it to every scoped request,
and checks the echo before ingesting reads or mutation results. The property switch
performs full navigation to a newly authorized document. There is no global
active-property cookie, so changing one tab cannot retarget another tab's writes.
Presentation preferences are namespaced by organization/property/user.

Missing selection/version returns 428; malformed or ambiguous input returns 400;
stale configuration returns 409 `property_configuration_changed`; absent/expired
authentication returns 401; unavailable access returns 403. Invalid/unavailable
configuration or storage refuses with 503. The page retires cached views and pending
responses on revocation/mismatched scope, and offers reload/property selection
instead of repeatedly reloading a 403. Normal calendar conflicts retain their own
retry behavior. These guards do not cancel work already committed before revocation.

## Shared sign-in protection

Every interactive PostgreSQL password sign-in commits a database reservation before
credential lookup or scrypt. Separate budgets permit **20 attempts per normalized
username** and **100 attempts per client network**, each in a rolling **15-minute**
window shared across application instances and restarts. Known and unknown usernames
follow the same procedure. All admitted attempts count, including successful sign-ins;
success does not reset either budget. A request denied by its username budget still
consumes an available client attempt. An exhausted client budget does not allocate
a new username record.

A refused attempt returns generic HTTP 429 with a database-derived `Retry-After`
and no session cookie. Missing migrations or permissions, database failures and
invalid reservation results return HTTP 503 before password verification. There is
no process-local or legacy-credential fallback. Existing session authentication,
page reads and logout do not consume these budgets. Retry timing uses database time
and assumes no additional activity; it is not a guaranteed unlock time.

Only deployment-owned `VERCEL=1` enables trust in Vercel's
`x-vercel-forwarded-for` header. Elsewhere the actual socket peer is used, ignoring
forwarded headers. Missing or malformed addresses share an unknown-client bucket;
IPv4-mapped IPv6 addresses share the IPv4 bucket, and other IPv6 hosts share their
canonical /64. Operators behind a shared network or unsupported proxy therefore
share a client budget.

The server HMACs canonical usernames and client networks using the existing
`OPS_SESSION_SECRET`; the private bucket table stores digests and timestamps, not
raw usernames, IP addresses or passwords. Instances must share that deployment
secret. No additional environment variable or per-login configuration is required.
Provision `atrium_login_executor` before applying the login-protection migration,
as described below. Deploying the code alone does not activate PostgreSQL or add
this protection to the separate legacy shared-passcode adapter.

[ADR 0004](../docs/adr/0004-login-protection.md) records the concurrency, retention,
proxy trust and availability tradeoffs. These limits are separate from MFA,
recovery and perimeter abuse controls.

## Personal password changes

Status → Account security opens an identity-scoped page. Users without property
grants can reach the same page from the property picker. Enter the current password
and a different new password of at least 15 characters. On confirmed save, all old
sessions are revoked and normal sign-in is required again. No environment edits
are involved. The legacy production passcode is unaffected.

A database reservation limits each identity to 10 password-change attempts in a
rolling 15-minute window across application instances. Current-password verification
and hashing occur outside locks, followed by a version/hash compare-and-swap and
minimal audit in one transaction. This authenticated identity limit is independent
of the username/client sign-in budgets above; it neither consumes nor clears them.
Lost responses never trigger blind password retries. No other person’s password
can be changed through this route.

[ADR 0002](../docs/adr/0002-personal-account-security.md) records the boundary and
remaining MFA, invitation, recovery, breached-password screening and hosted
migration gates. The security event table is private, not a customer audit UI.

## Registered sessions and sign-out

A successful password login registers a UUID session and lifecycle audit before
issuing its cookie. Database time sets an absolute eight-hour expiration. Requests
and page reloads do not renew it. Authentication refuses missing, revoked, expired,
wrong-version or mismatched records, including correctly signed old `a3` cookies.
Registry unavailability refuses access instead of falling back to a stateless cookie.

Account security lists at most 20 active sessions for the current user/version.
New logins beyond the cap revoke the oldest active sessions in the registration
transaction. Users can revoke one session or all other sessions. An unknown or
foreign target returns the same generic refusal; an owned inactive target permits
an idempotent result. Last connection includes background activity. Device/browser
labels are coarse, unverified hints; raw user agents, IPs and locations are not stored.

Account mutations and authenticated dashboard logout require same-origin JSON,
`x-atrium-user-id`, `x-atrium-session-id` and a signed `x-atrium-csrf` token bound to
the rendered session. Account mutations also require the matching
`x-atrium-account-action`. Form tokens last one hour; stale pages must reload.
Logout revokes the session before clearing the cookie. Missing/malformed/lost
receipts do not display success or trigger an automatic mutation retry.

Provision `atrium_session_executor NOLOGIN` before the user-sessions migration and
release the corresponding application together. Users with old PostgreSQL cookies
sign in again with their existing password; no account reset or per-login environment
change is required. The legacy hosted adapter remains separate. Historical session
and lifecycle audit rows are retained; a purge/archival policy is not implemented.
See [ADR 0005](../docs/adr/0005-revocable-sessions.md) for transaction ordering, trusted
internal operations, rollout and remaining MFA/recovery/retention work.

## Published showing rules

A PostgreSQL property must publish `property.tourSettings` in its configuration
bundle. `DatabaseRuntime.resolve` validates every required field; it does not supply
the legacy building's defaults. For example:

```json
{
  "capacity": 2,
  "slotMinutes": 30,
  "startIntervalMinutes": 30,
  "bufferMinutes": 0,
  "minimumNoticeMinutes": 120,
  "bookingWindowDays": null,
  "sameUnitPolicy": "exclusive",
  "hours": {
    "1": { "openHour": 9, "closeHour": 17 },
    "2": { "openHour": 9, "closeHour": 17 }
  }
}
```

Days use `0` for Sunday through `6` for Saturday; an omitted day is closed. Opening
hours must fit a complete tour. Numeric limits and accepted policies are enforced
by `src/calendar/settings.ts`; `null` is the explicit unlimited advance-booking
window. Timezone is the validated `properties.time_zone` value and is not editable
inside tour settings. Optional display/contact fields do not fill in another
building's phone, address or leasing hours.

Published settings supply the initial rules. A saved calendar `settings` object is
the explicit operational override and wins until changed, using its own
`settingsRevision` conflict guard. Publishing a new bundle does not silently erase
that override. Publishing moves the configuration pointer; old document versions
are rejected before new operations. Existing bookings retain their actual UTC tour
and reserved buffer intervals when future rules or timezone change.

## Roles and trust boundary

Provision these roles through the database administrator, with credentials supplied
separately by the deployment secret store. There are no database passwords in SQL:

| Role | Purpose and privileges |
| --- | --- |
| `atrium_admin` | Owns the private `atrium` schema and its objects. Runs migrations, explicit provisioning and maintenance. Has an explicit all-row policy, including under forced RLS. Never use this role in an HTTP request. |
| `atrium_authenticator` | Separate login/session connection. Scoped identity queries, the finite sign-in reservation, two personal password commands and four session commands. Can read the selected credential/current session but cannot write raw identity/session tables, access login buckets directly or access operational tables. |
| `atrium_account_executor` | NOLOGIN owner of the two private password commands. Has only self-scoped credential/version writes, attempt reservations and audit append under forced RLS. Runtime logins cannot inherit or assume this role. |
| `atrium_login_executor` | NOLOGIN owner of `atrium.reserve_login_attempt(text,text)`. Can maintain only the private forced-RLS login bucket table; cannot read or change identities, credentials or property records. Runtime logins cannot inherit or assume this role. |
| `atrium_session_executor` | NOLOGIN owner of four finite session commands and the current-session transaction fence. Own-user registry changes and append-only lifecycle audit under forced RLS; user row locking cannot change identity. No credential or property access. Runtime logins cannot inherit or assume this role. |
| `atrium_mfa_executor` | NOLOGIN owner of finite passkey commands. Self-only factor/challenge/proof/recovery writes under forced RLS, plus security audit. Does not receive raw credential writes or property data access. Runtime roles cannot inherit or assume it. |
| `atrium_organization_executor` | NOLOGIN owner of scoped organization directory and full existing-member access commands. Current administration proof, last-owner protection and atomic command/audit history; no credential writes. |
| `atrium_resident_services_executor` | NOLOGIN owner of finite resident/service and maintenance-planning mutation commands. Staff-only property records, immutable source/event/receipt history, versioned triage and policy-bound decisions under forced RLS; no caller identity, entry or dispatch authority. |
| `atrium_maintenance_approval_reader` | NOLOGIN/NOBYPASSRLS owner of the finite decision-authority reader. Returns current qualifying role/access for an existing scoped decision without changing requester context or exposing a general user directory. No runtime inheritance. |
| `atrium_app` | Scoped property repositories plus finite existing-member administration commands. Configuration reads, operational document/calendar writes and scoped audit append/read; service writes go through their finite command. Cannot read password hashes, directly write membership/configuration/channel-binding tables, truncate tables, or modify audit history. |

All ten must be `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
Provision `atrium_account_executor NOLOGIN` before the account-security migration
and `atrium_login_executor NOLOGIN` before the login-protection migration. Provision
`atrium_session_executor NOLOGIN` before the user-sessions migration and
`atrium_mfa_executor NOLOGIN` before the WebAuthn migration. Provision
`atrium_organization_executor NOLOGIN` and `atrium_resident_services_executor NOLOGIN`
before their respective additive migrations. Provision
`atrium_maintenance_approval_reader NOLOGIN` before maintenance-planning. Grant
these executor roles only to `atrium_admin` so migrations can transfer function
ownership; do not grant them to either runtime login. The migration grants the
authenticator explicit execution of the login reservation while denying execution
to `atrium_app` and `PUBLIC`. No additional runtime connection or deployment secret
is required. The local preview and isolated test provisioning create these roles;
an external database administrator must provision them before applying migrations.
Runtime roles must not own objects or inherit/assume another role, especially the
maintenance role. An initial cluster administrator must provision roles and grant
the migration executor only the required access to create the schema and assume
`atrium_admin`. Runtime connection validation must verify the actual login role and
its attributes, rather than making a privileged connection safe with `SET ROLE`.

The schema is private and is not a Supabase Data API exposed schema. It gives no
grants to `anon`, `authenticated`, `service_role` or `PUBLIC`. Existing installations
must also inspect inherited privileges; changing application configuration does not
remove pre-existing grants. The April 2026 Supabase change to automatic Data API
grants does not replace explicit privileges and RLS for these direct SQL connections.

Every runtime transaction uses `READ COMMITTED` and parameterized
`set_config('atrium.<name>', value, true)`. Set every context field, clearing unused
fields to the empty string; commit or rollback before releasing a pooled connection.
Never use session-scoped `SET` for request identity.

| Transaction | Local settings |
| --- | --- |
| Staff property operation | `actor_user_id`, `credential_version`, `session_id`, `organization_id`, `property_id` |
| Verified channel property operation | `channel_binding_id`, `channel_binding_version`, `organization_id`, `property_id`; no staff actor or session |
| Pre-login attempt reservation | All authorization settings empty; only two server-derived HMAC keys enter the finite function |
| Password lookup | `login_username` only |
| Session commands / identity lookup | `actor_user_id`, `credential_version`, `session_id`; registration has no session yet |
| Staff authorization lookup | `actor_user_id`, `credential_version`, `session_id` for HTTP users |
| Channel authorization lookup | `channel_provider`, `channel_external_id` |

These settings are a **trusted server boundary**. The role owning a connection can
set them. RLS catches omitted ownership predicates and invalid/revoked scope; it is
not protection against arbitrary SQL execution with stolen runtime credentials or
an injection that can impersonate another actor. Request/model-provided tenant IDs
must never be copied directly into this context. The authentication service issues
scope after checking the current identity or verified server-owned channel binding.

For registered staff sessions, acquire the finite fence before any property locks:

```sql
SELECT atrium.hold_current_session() AS allowed;
```

It holds the current user and exact active session in that order through commit or
rollback; anything other than true is forbidden. It is callable only by the property
application role. Channel operations and explicitly trusted internal user operations
without a browser session do not use this fence. All HTTP users have registered
sessions. The same transaction must then check property authority:

```sql
SELECT atrium.can_access_property($1, $2, $3) AS allowed;
```

`$1/$2` are the already authorized organization/property IDs; `$3` is the required
permission (`read`, `operate` or `configure` for this slice). Anything other than true is an
authorization failure, not an empty or newly open calendar. Every operational query
also binds the organization/property predicates explicitly. RLS independently checks
the active user, exact credential version, active organization/property, current
membership, explicit property grant or organization-wide access, and current role.
Channel operations instead recheck the active binding, its version and capability.
Neither route trusts a cached role or client-selected binding.

Session revocation, session-cap eviction and password rotation take the user lock
exclusively before session locks. They wait for previously admitted property
transactions to complete. After revocation commits, the old session cannot pass a
new property transaction's fence, including with an already issued application scope.
Keep these transactions short; never hold their locks across network or password
hashing work. Entry/exit checks still cover membership, configuration and property
changes; the session fence does not serialize every authorization change. Do not
use `REPEATABLE READ` to stretch old authority across a request. Already committed
work and accepted background workflows are not canceled by browser logout.

## Tables and ownership

| Table | Key and purpose |
| --- | --- |
| `users`, `user_credentials` | Stable staff identity and separately protected scrypt hash. Canonical username is unique. Updating/deleting a hash advances the user's credential version. |
| `login_attempt_buckets` | `(bucket_kind, bucket_key)` for private username/client HMAC digests and bounded timestamp queues. Only the finite reservation function and authorized maintenance can access these rows; they are distinct from personal password-change attempts. |
| `user_sessions` | UUID session records with user/version, coarse label, fixed expiration, last connection and irreversible revocation. At most 20 active per user/version; historical rows retained. |
| `user_session_events` | Append-only registration/revocation lifecycle audit, including session-cap eviction. No caller, credential or raw user-agent payload. |
| `organizations` | Client boundary with status and permission version. |
| `properties` | One organization, validated database timezone, status and nullable current configuration version. |
| `memberships` | One user/organization membership. Role is `owner`, `admin`, `staff` or `viewer`; `access='organization'` must be explicit. Role alone never confers access to all properties. |
| `property_grants` | Membership/property grant with active/revoked status; composite foreign keys require both to belong to the same organization. |
| `property_configurations` | `(organization_id, property_id, version)` with immutable published facts, source metadata and draft/published/retired status. |
| `channel_bindings` | Server-owned provider routing identity, property ownership, capabilities and revocation version. |
| `operational_documents` | `(organization_id, property_id, key)`, JSON value and revision; adapts the existing document store. |
| `calendars` | One row per organization/property, JSON state and revision; adapts the existing atomic calendar. |
| `audit_events` | Scoped, append-only for runtime roles, with operation/key, exact actor, request and optional configuration version. No transcript/contact/body payload column. |
| `organization_people`, `property_residents` | Immutable organization person core and property-specific occupancy relationship; no global PII or contact-based identity merge. |
| `resident_sources`, `resident_events` | Original property source observations, occupancy dates and staff review/revocation history. Source review does not establish channel identity. |
| `service_cases`, `service_events`, `service_commands` | Scoped intake, versioned triage, append-only history and canonical idempotency receipts; no external dispatch or completion claim. |
| `maintenance_policies`, `maintenance_vendors` | Immutable property authority rules and vendor review versions, including original evidence timestamps and distinct availability reports. |
| `maintenance_plans`, `maintenance_decisions`, `maintenance_plan_events`, `maintenance_commands` | Exact version-bound work proposals, one human decision per revision, retained safety/history and atomic command receipts. |

IDs accept the application's bounded stable ID format; they are not inferred from a
legacy tenant name. Relational references repeat organization/property ownership.
Identical document keys, unit labels, contact data and external record IDs can exist
in separate properties without colliding. The unique `(provider, external_id)` on a
channel binding is deliberately different: it is the routing identity used by the
verified webhook, and a duplicate would make ownership ambiguous. Providers whose
resource IDs are only unique within an account need a namespaced routing identity
and an expanded resolver contract before they are connected.

Configuration JSON is the complete `{property, inventory, floorplans, knowledge}`
bundle. `inventory_read_at` and `inventory_source` retain its source freshness;
loading a saved bundle must not replace its source timestamp with the current time.
`properties.time_zone` is authoritative. Application publication/loading validation
must reject contradictory embedded identity/timezone, invalid units/article scopes,
unapproved knowledge, missing sources and secrets. Secrets belong in protected
server storage and only safe references may appear in a bundle. SQL enforces the
top-level bundle shape, exact embedded property ID and composite ownership; it does
not inspect arbitrary strings for secrets or implement all domain validation.

Publish a complete new version and update the property's pointer in one maintenance
transaction. Deferred constraints require that pointer to resolve to a published
version at commit. The pointer can be null for an unconfigured property; such a
property must fail visibly, never inherit Larkin data. Published content and source
timestamps cannot be edited in place. Switch to a new version before retiring the
old current version. Reference past versions when recording decisions.

Document/calendar updates automatically advance `revision`. Calendar mutations must
serialize on the property row or a transaction-scoped property scheduling lock,
re-read state and run existing overlap/capacity rules before updating. This retains
actual UTC booking intervals; changing timezone/showing rules never rewrites those
intervals. Insert the corresponding audit event in the same transaction. No external
network side effect may run inside a retryable database transaction.

## Migration and current limits

Before applying to a customer database: back up source data, record an explicit
legacy tenant → organization/property mapping, dry-run scoped counts and identifiers,
reconcile duplicate records and compare all booking intervals. Keep the old store
read-only during cutover. Rollback means stop writes, restore the verified database
backup/mapping and select the previous authoritative adapter; do not perform ad hoc
dual writes or assume every legacy record belongs to the demo account.

The isolated PostgreSQL test suite must apply the generated migration under the
maintenance role, connect through the real restricted roles and exercise two
organizations with two properties each, including repeated record IDs. It must
cover failed ownership references, missing/stale context, member/grant/password/
channel revocation, viewer writes, audit attribution and rollback, row-lock booking
concurrency, pooled context cleanup, and immutable publication. Review database
advisors before an external deployment. Development source review alone is not a
successful migration or restore test.

This slice does not normalize people/interactions/bookings, provide membership or
publication UI, migrate production Redis records, implement enterprise SSO, dispatch jobs,
or deliver general inbox/outbox/reconciliation. Calendar/document JSON can still
contain growing arrays; current repositories reject oversized serialized documents
and unpaginated key lists over 5,000, but do not provide a normalized portfolio-query
API. Runtime audit
history is append-only but remains editable by a database administrator; it is not
independently tamper-evident. Backup recovery, retention and production cutover need
their own verified operational evidence.

## Local preview and verification

`npm run dev:ops` mounts the real HTTP handlers with a private persistent native
PostgreSQL instance. `.atrium-local/` contains its data, a private configuration file
and process lock; the directory is ignored by Git and is not a deployment artifact.
The native process listens only on loopback, with Unix sockets disabled. The helper
refuses hosted/production/simulation mode and ignores external database/provider
configuration. It is a local development helper, not a production database manager.

The initial import explicitly maps only the existing `larkin` / `demo-larkin` account
to the fictional demo organization/property. It preserves the saved scrypt hash and
then uses the persisted user record. Restarts retain password changes, grants,
showing settings, records and source dates. It does not import arbitrary legacy
customer tenants. A first run without a private account creates a random password
and displays it once; existing passwords are not displayed or regenerated.

Synthetic call import is checkpointed. Completed steps are not replayed. An
uncertain interrupted step stops for inspection rather than assuming a failed write
or resetting the database. `--no-seed` skips call import and preserves existing data.
Changing the HTTP port does not permit concurrent use of one database directory.
Do not treat deleting `.atrium-local/` as a routine refresh; it contains persisted
local accounts and staff changes.

`npm run test:database` uses separate disposable native databases and the restricted
roles. Tests cover SQL ownership/RLS, migration ordering/checksums, synthetic restore
into a fresh database, current authorization under revocation, transaction audits,
concurrent bookings, property publication, HTTP scope and local restart behavior.
`npm run build` separately imports all deployed handler bundles without inherited
credentials or installed dependencies and checks unconfigured runtime refusal.
Neither check establishes hosted service health or a production recovery procedure.

References: [PostgreSQL 17 RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html),
[transaction-local SET](https://www.postgresql.org/docs/17/sql-set.html),
[composite foreign keys](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK),
[Supabase Data API grant change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).

## Session-bound passkeys

`mfa.sql` and its new migration add private `mfa_states`, `mfa_password_checks`,
`mfa_factors`, `mfa_assurances`, `mfa_recovery_codes`, `mfa_recovery_grants`,
`mfa_challenges`, `mfa_attempts`, `mfa_requests` and `mfa_events`. The authenticator
role invokes finite self-only commands; it cannot directly mutate these records.
Actual password and WebAuthn verification results are opaque, process-issued
capabilities at the repository boundary. Database claims remain single-use even
when verification fails or a process dies. Security state changes serialize with
already-admitted property transactions using the registered user/session fence.

Every enrolled user and every active owner/admin/staff member needs a current
session-login proof before property operations. The password-only phase still
allows own MFA setup/recovery, session controls and logout. Pending registration
requires a second signed assertion. Fresh passkey proof and password are required
for factor management; the last active factor cannot be removed. Recovery replaces
keys and revokes other sessions only when the replacement is verified. It never
substitutes for an organization-administration proof.

The PostgreSQL runtime requires the canonical `ATRIUM_AUTH_ORIGIN` once per
environment; do not derive it from HTTP forwarding headers. Apply all migrations
and provision the executor before activating this runtime. Existing production
legacy authentication is separate. See [ADR 0006](../docs/adr/0006-multi-factor-authentication.md)
for proof lifetimes, recovery and deployment limitations.


## Existing-team administration

Apply the additive organization-administration migration after provisioning
`atrium_organization_executor` as NOLOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE.
Only `atrium_admin` inherits it; runtime role inheritance is rejected. Three finite
functions expose a scoped directory and full member replacement to `atrium_app`;
raw identity/grant writes remain denied. The two new command/audit tables have
forced RLS and immutable evidence. Appending the receipt or audit must succeed in
the same transaction as changing access. The command increments the aggregate
membership version once; privileged maintenance must preserve that invariant too.

The hosted bootstrap can extend verified eight- or nine-migration installations
with only the missing organization/resident-service executors. It checks all prior role/ACL/RLS safety and the exact saved
manifest first, refuses an already-applied migration with a missing role, and never
rotates existing credentials or seeds over existing records. Its `root` option is
a complete repository root containing both data and migrations. See
[ADR 0003](../docs/adr/0003-organization-administration.md) for locking, recovery
and the separate unimplemented invitation/onboarding contract.

## Resident services

Apply the resident-services migration after provisioning its restricted executor.
The application reads scoped projections and invokes
`atrium.execute_resident_service(jsonb,bigint,text[])`; it cannot directly mutate
these tables. The command rechecks the managed staff session, property/configuration,
current resource version and source context, then writes the resource, history and
exact request receipt atomically. Existing source observations are immutable.

Manual sources have a maximum 90-day validity interval and property-local occupancy
dates. Current context warnings are derived when reading cases and included in the
Attention filter before pagination. Stored triage history never silently grants
entry, spending or continued occupancy authority. See
[ADR 0010](../docs/adr/0010-resident-service-records.md) for source review, emergency
holds, practical vacant/common-area planning, privacy and remaining lifecycle work.

## Maintenance planning

Apply the additive maintenance-planning migration after provisioning its finite
approval reader. `atrium.execute_maintenance_planning(jsonb,bigint,uuid)` performs
bounded commands under the service executor. `atrium.maintenance_decision_authority(uuid)`
returns current role/authority only for an existing decision under the unchanged
requester's scope. Runtime users cannot inherit either role or directly mutate
planning tables. Policy publishing, vendor review and decisions recheck a fresh
exact-session administration proof inside the command.

Sources and commands remain retry-stable; final database-time checks govern
current authority. Automatic and human financial authority are separate from
resident approval, entry, vendor readiness and dispatch. See
[ADR 0011](../docs/adr/0011-maintenance-authority.md) for version binding, emergency
receipts, expired-vendor suspension and the remaining approval inbox and execution
work. Hosted activation and actual provider acceptance remain separate gates.
