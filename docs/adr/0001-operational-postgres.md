# ADR 0001: PostgreSQL for Atrium operational data

Date: September 9, 2026

Status: accepted for the implemented foundation. Production hosting and runtime cutover remain open.

## Context

Atrium needs durable records across multiple client organizations and properties, current
membership and channel authorization, concurrent booking safeguards, and atomic operational
mutation/audit. The existing runtime uses tenant-scoped Redis JSON keys or local memory.
Those adapters support the current leasing workflows but do not provide relational ownership
constraints or a transaction spanning related records. Accounts and property facts are still
environment configuration and bundled files in the active API/portal paths.

## Decision

Use PostgreSQL as the relational engine for Atrium-owned operational data, accessed through
explicit repository contracts and parameterized SQL using `pg`. The current dependency is
`pg` 8.23.0. No ORM is selected. Keep one modular application while introducing repositories;
this decision does not require a service split or a rewrite of the existing domain rules.

The private `atrium` schema has three separate roles:

| Role | Boundary |
| --- | --- |
| `atrium_app` | Property-scoped configuration reads, operational document/calendar mutations and audit append/read. No password-hash access, membership/configuration administration or audit update/delete. |
| `atrium_authenticator` | Read-only identity, credential and authorization lookups, narrowed by server-owned login or actor/channel context. No operational-table access. |
| `atrium_admin` | Schema ownership, migrations and explicit provisioning/maintenance. Never used by HTTP requests. |

Roles and schema details are defined in `db/schema.sql` and `db/README.md`. Tables use forced
row-level security and composite organization/property ownership constraints. Runtime
connections verify their actual role and reject privileged or maintenance-role connections.
TLS verification is required for remote/hosted connections. `src/database/connection.ts`
sets every known authorization context value transaction-locally and releases the pooled
client only after commit/rollback. Property repositories also bind organization/property
predicates explicitly.

The application issues opaque `AuthorizedScope` objects through `src/auth/`. Repository
transactions in `src/database/scope.ts` check current permission on entry and exit; row
policies recheck current authority during SQL operations. A revoked request must not become
an empty calendar or a successful audited write. This is a trusted server boundary: a
connection holder can set context variables. It does not protect against arbitrary SQL
execution with stolen runtime credentials, and it cannot undo an operation already committed
before revocation.

Published configuration is versioned and property-owned. `src/database/properties.ts` reads
the property's published pointer and the matching content in one statement.
`src/properties/` validates ownership, timezone/jurisdiction, inventory and knowledge metadata;
the inventory source timestamp is retained, not reset to the configuration query time.
Missing or malformed configuration fails explicitly, without borrowing another building's
bundled data.

The first operational adapters retain JSON records in PostgreSQL to preserve tested domain
behavior during extraction. `src/database/operations.ts` uses transaction locks for document
updates and property calendars and appends actor/request-attributed mutation audit in the
same transaction. This is a transitional storage shape. It is not yet a normalized contact,
interaction, booking, maintenance or portfolio query model.

## Local verification and migrations

`scripts/lib/postgres-test.mjs` launches an isolated native PostgreSQL fixture on loopback
with private temporary files and synthetic credentials. `embedded-postgres` is pinned at
`17.10.0-beta.17`, providing the PostgreSQL 17.10 local test fixture. That pin makes these
tests reproducible; it is **not** a claim that this is the current production patch release.
Before production activation, verify the engine's supported major version, current patch,
provider compatibility and security/support policy, and record the result.

`scripts/lib/database-migrations.mjs` owns an ordered SQL migration transaction, advisory
lock and private checksum history. The initial generated migration resides in
`supabase/migrations/`; `db/schema.sql` is its development source. Do not alter an applied
migration. Subsequent changes require a new migration and upgrade/rollback evidence.

`npm run test:database` exercises actual restricted database roles, row isolation,
authorization and revocation races, concurrent mutations/bookings, atomic audit rollback,
published configuration and migration drift. The CI workflow includes this gate before
build. `test/database/migrations.test.mjs` verifies a synthetic two-organization snapshot
restored into a fresh test database, including exact credential records, ownership and UTC
booking intervals, with transaction rollback on an invalid ownership reference. This is
schema-level restore evidence only: no production/customer backup was restored, no
point-in-time recovery was exercised, and no production restore runbook is implemented.

## Hosting and operational decisions still open

PostgreSQL engine selection does not select a hosting provider or a remote project. The
schema and migration directory are compatible with Supabase tooling, and the private schema
is not intended for direct browser/Data API exposure. **No remote Supabase or other hosted
database was connected for this foundation.** A directory name, installed CLI or local test
does not establish a provider deployment.

Before selecting and activating hosting, document:

- Region/residency requirements, customer data policy and permitted operator access.
- Availability, connection limits/pooling, expected capacity and measured operating cost.
- Supported engine/patch versions, upgrade responsibility and incident ownership.
- Encrypted backups, point-in-time recovery where required, retention, recovery-point and
  recovery-time objectives, restoration credentials and an isolated restore drill.
- Separate development/staging/production resources, secret rotation, monitoring and alerts.

These are deployment review gates, not completed guarantees. No cost, residency or recovery
commitment is implied by the engine choice.

## Alternatives and consequences

Keeping Redis JSON as the sole long-term operational system would avoid a migration but
leave ownership constraints and related-record transactions in application code. A local
account JSON database would persist one preview but introduce a separate concurrency and
migration model from hosted deployment. PostgreSQL provides the relational and transaction
boundary required for the shared foundation, with the cost of schema evolution, database
operations and explicit migration work.

The client PMS remains authoritative for records it owns. Atrium stores authorized intent,
verified projections and operational evidence; moving Atrium records into PostgreSQL does
not implement a PMS integration or authorize competing lease/balance/work-order writes.

## Adoption and remaining work

The new `src/auth`, `src/database` and `src/properties` modules are implemented and locally
tested, but **existing APIs, the portal and runtime store factories have not selected them**.
They still use environment accounts, tenant namespaces and bundled property facts. Setting
database environment variables alone does not perform the cutover.

Next, implement a hash-preserving Larkin account import and explicit tenant-to-organization/
property mapping, validate/reconcile existing records, and integrate a complete request path
through property authorization, configuration and repositories. Property selection must be
per browser document and reauthorized on every API request; the session cannot silently
retarget writes when another tab changes buildings. Preserve the source data and a verified
rollback path, choose one authoritative store during cutover, and avoid uncoordinated dual
writes. No account/password or customer-data migration has occurred in this foundation.

Normalize operational repositories as workflows require them. A general inbox/action/outbox
transaction, queued workers, leases, connector delivery/read-back and recovery UI remain
unimplemented. Mutation audit is useful evidence but does not yet cover all privileged
reads, configuration changes, external actions or independently retained tamper evidence.
The full product acceptance scope remains open beyond this foundation.
