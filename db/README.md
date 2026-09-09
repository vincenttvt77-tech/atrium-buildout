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
bindings and publish complete property bundles separately. No general customer
onboarding, password-reset or membership-management UI is included in this slice.
The hosting project/provider, production backup policy and production restore proof
remain open; native PostgreSQL test success does not resolve those choices.

## HTTP and portal contract

The PostgreSQL session is a signed user-only token containing `userId`,
`credentialVersion` and `expiresAt`; it contains no current property or cached role.
Authentication rereads the active user/credential version. Authorization resolves
current membership, organization/property status and explicit grants per operation.

| Route | Scope and behavior |
| --- | --- |
| `GET/POST /api/dashboard` | Sign-in/logout and protected HTML. A signed-in user with multiple properties sees a picker; an explicit page uses `?organizationId=...&propertyId=...`. |
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
| `atrium_authenticator` | Separate login/session repository connection. Read-only control-plane queries, narrowed by login username, actor identity or exact provider routing identity. Can read one selected user's password hash; has no operational table grants. |
| `atrium_app` | Property repositories only. Scoped configuration reads and operational document/calendar writes, plus scoped audit append/read. Cannot read password hashes, change memberships/configuration/channel bindings, truncate tables, or modify audit history. |

All three should be `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
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
| Staff property operation | `actor_user_id`, `credential_version`, `organization_id`, `property_id` |
| Verified channel property operation | `channel_binding_id`, `channel_binding_version`, `organization_id`, `property_id`; no staff actor |
| Password lookup | `login_username` only |
| Session identity lookup | `actor_user_id` only |
| Staff authorization lookup | `actor_user_id`, `credential_version` |
| Channel authorization lookup | `channel_provider`, `channel_external_id` |

These settings are a **trusted server boundary**. The role owning a connection can
set them. RLS catches omitted ownership predicates and invalid/revoked scope; it is
not protection against arbitrary SQL execution with stolen runtime credentials or
an injection that can impersonate another actor. Request/model-provided tenant IDs
must never be copied directly into this context. The authentication service issues
scope after checking the current identity or verified server-owned channel binding.

Before reading a property's operational data, the repository must execute:

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

Revocation and password rotation affect the next statement's current database
snapshot, including requests holding an old application scope. This does not cancel
a statement already executing or undo an operation committed before revocation.
Do not use `REPEATABLE READ` to stretch old authorization snapshots across a request.
Stronger cancellation of in-flight work requires a coordinated locking/cancellation
protocol; it is not claimed here.

## Tables and ownership

| Table | Key and purpose |
| --- | --- |
| `users`, `user_credentials` | Stable staff identity and separately protected scrypt hash. Canonical username is unique. Updating/deleting a hash advances the user's credential version. |
| `organizations` | Client boundary with status and permission version. |
| `properties` | One organization, validated database timezone, status and nullable current configuration version. |
| `memberships` | One user/organization membership. Role is `owner`, `admin`, `staff` or `viewer`; `access='organization'` must be explicit. Role alone never confers access to all properties. |
| `property_grants` | Membership/property grant with active/revoked status; composite foreign keys require both to belong to the same organization. |
| `property_configurations` | `(organization_id, property_id, version)` with immutable published facts, source metadata and draft/published/retired status. |
| `channel_bindings` | Server-owned provider routing identity, property ownership, capabilities and revocation version. |
| `operational_documents` | `(organization_id, property_id, key)`, JSON value and revision; adapts the existing document store. |
| `calendars` | One row per organization/property, JSON state and revision; adapts the existing atomic calendar. |
| `audit_events` | Scoped, append-only for runtime roles, with operation/key, exact actor, request and optional configuration version. No transcript/contact/body payload column. |

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
publication UI, migrate production Redis records, implement SSO/MFA, dispatch jobs,
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
