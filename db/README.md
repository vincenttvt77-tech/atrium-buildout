# PostgreSQL foundation

`schema.sql` is development source for the first property-scoped storage slice. It is
not a migration that has been applied to a shared database. The migration runner owns
the transaction, advisory lock and checksum history. Generate a migration filename
with `supabase migration new`, then copy the reviewed source into that file. Never
edit an already applied migration; use a new migration for subsequent changes.

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
permission (`read` or `operate` for this slice). Anything other than true is an
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
contain growing arrays and requires repository size/query limits. Runtime audit
history is append-only but remains editable by a database administrator; it is not
independently tamper-evident. Backup recovery, retention and production cutover need
their own verified operational evidence.

References: [PostgreSQL 17 RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html),
[transaction-local SET](https://www.postgresql.org/docs/17/sql-set.html),
[composite foreign keys](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK),
[Supabase Data API grant change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).
