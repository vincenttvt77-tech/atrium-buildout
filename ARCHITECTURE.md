# Atrium application architecture

Status: current-state assessment and implementation direction, September 9, 2026. This document is a development contract for evolving Atrium into an operable SaaS product. A target described below is **not implemented** unless the current-state section identifies its code. Passing local tests does not establish commercial readiness.

Keep Atrium as one modular application initially. Preserve the tested leasing, knowledge, scheduling and booking rules while separating request handling, authorization, application workflows, storage and external connectors. Ordinary customer onboarding should eventually create validated records and configuration versions, without source edits or a separate deployment per building.

This file contains technical architecture only. Customer agreements, the detailed scope of work, business plans, pricing, credentials and private rollout evidence belong in approved private storage, outside the repository and public site assets. The private scope remains the source for contractual acceptance; this document does not reduce that scope.

## 1. Current code and its actual guarantees

| Area | Implemented boundary | Current limitation |
| --- | --- | --- |
| Runtime and delivery | Node 22, strict TypeScript, Vercel-style handlers in `api/`; `scripts/build-api.mjs` creates API bundles; `scripts/build-site.mjs` and `scripts/build-ops.mjs` generate artifacts. | No database migration runner, infrastructure definition, staged rollout controller or automated restore procedure exists in this tree. Build success does not prove what is deployed. |
| Staff experience | `ops/src/` contains the authored HTML, CSS and browser JavaScript. The protected page is generated into `ops/dashboard.page.json` and served by `api/dashboard.ts`. | Feature code and API fetching remain concentrated in large browser modules. The console is a staff workspace, not separate role-authorized owner, vendor and platform-admin products. |
| Identity | `src/ops/accounts.ts` validates named accounts from `OPS_ACCOUNTS_JSON`, with salted scrypt hashes. `src/ops/session.ts` issues signed tenant-bound sessions and rechecks configured membership. | Accounts are environment configuration, not database-backed users/memberships. Each account has one tenant; all named users have staff powers in that tenant. No MFA/SSO, role policy or property grants are implemented. |
| Tenant scope | `src/tenancy/context.ts` provides request-local scope. Protected handlers and verified webhook routing choose it. Document/calendar adapters resolve scope per operation; named tenants use separate Redis namespaces. Missing tenant context fails closed in hosted runtimes. | Scope is a tenant string, not an authorized organization/property principal. Local compatibility code still has a `legacy` fallback. Key namespaces are not database row-level authorization. |
| Property data | `data/property.json`, `inventory.json`, `floorplans.json` and `knowledge.json` provide the bundled Larkin template. Loaders reject unusable records; knowledge rules check publication, scope, approval and review date. | Every workspace still uses one bundled property template. Re-reading that bundle does not refresh a PMS. Scheduling and several messages use New York time. No customer property catalogue, onboarding or configurable timezone exists. |
| Domain rules | `src/leasing/`, `inventory/`, `knowledge/`, `escalation/` and `conversation/` contain qualification, matching, answer guards and escalation logic. Branded IDs exist in `src/domain/ids.ts`. | Branded IDs are compile-time helpers; they do not validate ownership or persistence. Several workflows receive property context assembled directly in the HTTP handler. |
| Booking | `CalendarPort` separates booking orchestration from the calendar adapter. `bookTour` verifies read-back. The stored calendar atomically checks capacity, overlap, apartment policy and settings, and preserves actual reservation intervals. | The calendar is Atrium's standalone schedule, not a connected PMS/calendar. `recordIntent` constructs an in-memory intent; there is no durable action-intent transaction before an arbitrary external write. |
| Operational storage | `DocumentStore` and `CalendarStore` have local memory and Redis REST implementations. `src/store/config.ts` requires configured durable storage in hosted runtimes. Redis updates use compare-and-set; failed reads do not become empty availability. Health returns 503 for missing/unreachable hosted storage. Bulk lead and tour reset controls are refused in hosted runtimes. | Atomicity is per JSON document/key. There are no transactions spanning a call, lead, action, audit and job. Calendar changes rewrite a whole tenant calendar document. Prefix scans and whole-profile arrays are not a portfolio query model. |
| Voice integration | `api/vapi.ts` validates webhook credentials, resolves bound assistant ownership, runs tools and merges call state. `src/vapi/` generates and synchronizes assistant configuration with read-back. Call history is filtered to allowed assistants. `src/leads/inbox.ts` records a finished-call receipt before projection, supports explicit replay and compacts completed receipts; failed projection returns retryable HTTP 503 and retains working call state. | The handler also owns orchestration, property loading and diagnostics. The finished-call inbox is a bounded first step, not a general event inbox/action outbox. No scheduled recovery worker, job leasing, general connector registry or provider-event reconciliation exists yet. Redis receipt/projection writes are separate operations with idempotent recovery, not a multi-record transaction. |
| History and work queues | Call/lead/follow-up documents persist when Redis is configured. Domain event types exist in `src/record/store.ts`; Vapi history is fetched separately. | Dashboard decision events are a process-local bounded array. `RecordStore` only has a memory implementation; its comment referring to `src/record/kv.ts` does not establish such a file. Follow-ups have `executable: false`. A status named `queued` or `queuedForHuman` is not proof that a durable worker or notification exists. |
| Email and other channels | Email rendering/transport abstractions and simulations exist. | Email is not connected to the live booking workflow. Outbound SMS/calls, Apple Messages for Business, resident identity, maintenance/vendor/amenity lifecycle execution and billing are not delivered by the current leasing demo. |
| Runtime diagnostics | Vapi responses have request IDs; tool logs include tenant, request, full call/tool IDs, duration and error codes without caller words. Finished-call failures expose the request ID and retry status. | This is partial structured logging, not centralized traces, a durable audit ledger, tenant-level operational metrics, alert routing or an operator recovery console. |
| Verification | `npm run check` runs types, data validation and Node tests; GitHub Actions runs clean install, check and build. Tests cover handler behavior, tenancy attacks, retries, rules and scheduling. | CI does not currently prove a live database restore, real provider integration, voice latency, production load, MFA, continuous security monitoring or all contractual workflow acceptance. |

`TENANCY.md` describes current account isolation and tour settings. `QUALITY_REVIEW.md` records specific past verification runs and their limitations; its dated counts are historical evidence, not a live certification.

## 2. Target boundaries

```mermaid
flowchart LR
    Staff[Staff and operator UI] --> HTTP[HTTP boundary]
    Provider[Provider webhook] --> Verify[Webhook verification]
    HTTP --> Scope[Authorized scope]
    Verify --> Scope
    Scope --> Cases[Application use cases]
    Cases --> Rules[Domain rules]
    Cases --> Repos[Transactional repositories]
    Repos --> DB[(Operational database)]
    Repos --> Outbox[Durable outbox]
    Outbox --> Worker[Scoped worker]
    Worker --> Connector[Provider adapter]
    Connector --> External[Client system of record]
    External --> Verify
    Worker --> Repos
```

This diagram is the target, including components that do not exist yet. Keep the dependency direction explicit:

- **Transport:** authenticate, parse bounded input, resolve scope, invoke one use case and map the outcome to an HTTP or provider response. No direct rent, capacity, knowledge or authority decisions in a route.
- **Application use cases:** coordinate authorization, repositories, domain decisions and connector commands. Define transaction and retry boundaries here.
- **Domain:** deterministic rules with explicit input, clock and configuration version. Domain functions do not read environment variables, HTTP cookies, process-local tenant context or provider APIs.
- **Repositories:** scope every query and mutation, own serialization and database constraints, and expose domain operations rather than arbitrary unscoped JSON keys.
- **Connectors:** normalize external systems into versioned capabilities. Own provider authentication, timeouts, error classification, pagination and external identity mapping. They do not decide a user's permission.
- **Workers:** claim persisted work and execute application use cases under a recorded service principal. A worker is another application entry point, not an exception to authorization.
- **UI:** display server-authorized data and truthful workflow states. Browser filtering and hidden buttons are usability features, never the access-control boundary.

A practical extraction layout is `src/auth/`, `src/application/`, existing domain folders, `src/repositories/`, `src/connectors/` and `src/jobs/`. Create a module when a real workflow uses it. Keep API compatibility while moving behavior out of large handlers. Independent services become justified only by measured scaling, failure-isolation or ownership needs.

## 3. Organization, property and membership model

The target hierarchy is **client organization → property**, with portfolios grouping properties within the same organization. Atrium platform administrators are a separate principal class with explicit support capabilities. They are not ordinary client users with an unrestricted tenant selector.

| Record | Scope and invariant |
| --- | --- |
| Organization | Stable client identity, lifecycle state and customer-level policy. Never infer it from a browser label or email domain. |
| Property | Belongs to exactly one organization; holds location, timezone and references to published configuration. Portfolio membership cannot cross organizations. |
| User identity | Authenticated staff subject. May have multiple organization memberships, which confer no rights until checked for the chosen operation. |
| Membership and grant | Connects user to organization, role and optional property set; records status, permission version and revocation. Organization-wide access must be an explicit grant. |
| Platform/service principal | Has a purpose, allowed capabilities and scoped access. Support access is time-limited and auditable; background jobs record their initiating actor separately. |
| Person and contact identity | Person history is scoped to one client organization and may span its properties. Phone/email is a contact claim, not resident identity proof. No automatic cross-client person matching. |
| Interaction and workflow | Carries organization, property, person when known, channel, source identity and workflow ID. Unknown callers remain distinct until verified linkage is established. |
| Channel/connector binding | Server-owned binding from provider identity to organization/property and permitted capabilities. Provider IDs from model-generated arguments never choose scope. |

The server must resolve a request into an immutable **authorized scope** after identity verification and current membership/policy evaluation. Repositories and use cases receive that scope explicitly. A target interface may look like this; it is illustrative, not existing code:

```ts
interface AuthorizedPropertyScope {
  organizationId: OrganizationId
  propertyId: PropertyId
  actor: { kind: 'staff' | 'service'; id: string }
  permissionVersion: string
  requestId: string
}

interface BookingRepository {
  reserve(scope: AuthorizedPropertyScope, command: ReserveTour): Promise<BookingOutcome>
  findByIdempotencyKey(scope: AuthorizedPropertyScope, key: string): Promise<Booking | null>
}
```

Only the authorization module may issue this scope. Compile-time types alone do not make it trusted. The repository still binds organization/property IDs into every query and verifies returned ownership. Preserve the current hosted-runtime rejection of missing tenant scope, then extend it to explicit property authorization. Retire the remaining local `legacy` fallback into an explicit fixture/migration adapter; it must not become the default for new paths.

Switching properties means requesting and receiving a newly authorized scope, not changing a client-supplied tenant field. Workers retain original attribution but recheck current property status, connector authority, consent and approval validity before executing delayed work. Role revocation must affect pending work, exports and live sessions.

## 4. Durable data and transaction design

Use a transactional relational store as the target operational system of record for Atrium-owned data. Select the engine and hosting through a recorded architecture decision covering constraints, transaction isolation, backup/restore, residency, cost, operational ownership and testability. No database vendor, ORM or migration tool has been selected or installed by this document.

The client PMS remains authoritative for the records it owns. Atrium stores operational intent, verified projections, workflow history and reconciliation evidence; it must not silently become a competing source of truth for leases, balances or work orders.

Start the schema with organizations, properties, users, memberships, property grants, configuration versions, connector/channel bindings, people/contact claims, interactions, booking intents/reservations, webhook receipts, workflow actions, outbox jobs and audit events. Add resident, lease, vendor, maintenance, amenity, recommendation/intervention and outcome records when their workflows are implemented, retaining the same identity and audit envelope.

Enforce these invariants in storage as well as services:

- Non-null organization ownership on every tenant-owned row; property ownership on property operations. Use composite foreign keys such as `(organization_id, property_id)` so a record cannot reference another organization's property.
- Uniqueness of `(organization_id, connector_id, object_type, external_id)` for external mappings. Provider call IDs, apartment labels and email addresses are not globally unique application identities.
- A unique idempotency key per workflow scope plus a canonical payload hash. Reusing the key with changed apartment, time or operation must conflict, not return an unrelated success.
- Atomic publication of a complete configuration version. Each decision/action records the rules and source versions it used; later edits do not rewrite past decisions.
- A booking transaction validates current rules, checks peak resource occupancy, reserves the interval and persists the action/audit/outbox records together. A unique start timestamp alone cannot enforce capacity greater than one or overlapping durations. Use a property/resource scheduling lock or equivalent serializable transaction, with a documented lock order and concurrency tests.
- Persist actual tour and occupied intervals separately, using half-open intervals `[start, end)`. Store instants in UTC and property timezone as configuration; keep business dates as dates. Existing reservations never change duration because current settings change.
- Database enforcement of row scope where supported, under the real application role. Connection-pool scope must be transaction-local and cleared between requests. Administrative database access must not be the application default.
- Indexed, bounded queries and scope-bound pagination cursors. Avoid full tenant scans or loading every call/profile to render a page. Cursor validation must not allow a cursor from another organization to reveal rows.
- Schema validation and explicit serialization at boundaries. JSON payloads may hold provider extensions, but ownership, workflow state, timestamps, keys and relational references must be typed columns with constraints.

Introduce versioned migrations with a history table, checksums, one migration executor and a tested upgrade from the previous release. Use expand → backfill → verify → cut over → contract changes so old and new application versions can coexist during rollout. Backfills must be scoped, restartable and report counts and exceptions.

Migrating current Redis data needs an explicit mapping of legacy/named tenant IDs to organization and property IDs, source backup, dry run, duplicate/ownership reconciliation and a reversible cutover. Do not infer that all legacy data belongs to the new Larkin account. Compare counts, booking intervals, contact associations and ownership before enabling writes. Avoid uncoordinated dual writes; if parallel reads are used to verify migration, define which store is authoritative and how divergence is resolved.

## 5. Reliable integration execution

Extend the current finished-call receipt into a **durable inbox and outbox** before enabling unattended external actions. `src/leads/inbox.ts` already persists pending/complete call receipts and exposes `replayFinishedCall`; it relies on redelivery or explicit replay and does not schedule a worker. Preserve that recovery behavior while moving receipt, action and audit ownership into transactional repositories.

1. Authenticate and validate an incoming provider event, resolve its owned channel binding and store a receipt with a unique provider event key. Retain only the permitted payload and a payload digest. Replays must return the prior accepted result without repeating side effects.
2. In one database transaction, record the workflow/action intent, required authority or approval, current configuration/source version, audit event and any outbox work. Commit before attempting an external write. The existing in-memory `recordIntent` is insufficient for this guarantee.
3. A worker claims work with a lease and attempt count. Recheck current permissions, consent, property activation and connector capability. Network requests happen outside database transactions and Redis compare-and-set callbacks.
4. Send a stable provider idempotency key when supported. After an ambiguous timeout, look up/reconcile the original action before attempting another create. Document the safe manual path for providers that cannot support reliable deduplication or read-back.
5. Read back and compare the persisted external result. Move from `pending`/`executing` to `verified` only after this succeeds. The UI and voice response must distinguish pending, awaiting approval, retrying, blocked, verified and terminal failure.
6. Persist retry scheduling with bounded exponential backoff and jitter, connector circuit breakers, per-organization/provider concurrency budgets and a visible dead-letter/reconciliation queue. Preserve the original operation key during replay.
7. Run scheduled reconciliation and harmless synthetic checks through the same owned connector binding. Surface divergence, lost authorization, stale inventory and expired credentials with an operator and a next action.

Expected delivery is **at least once with idempotent processing and reconciliation**, not a claim of exactly-once external execution. Webhook receipt, workflow transition, outgoing message and verified completion are different events.

A connector capability record must identify available reads/writes, source-of-truth ownership, mapping version, rate limits, freshness policy, retry/read-back behavior, authorization method, health check, owner and manual fallback. Prefer authorized APIs and structured exchange; browser automation requires explicit client authorization and the same reliability controls. Do not make live connector installation or provider selection implicit in ordinary property onboarding.

## 6. Audit, observability and production debugging

Treat the audit ledger, operational logs and customer-visible history as separate products with different access and retention rules.

- **Audit:** append an actor-attributed event for privileged access, membership changes, configuration publication, approvals, external actions, exports and deletion. Include organization/property/workflow, trigger, decision/rule version, permitted input references, approver, before/after references and external result. Deny application updates/deletes to the ledger. Establish tamper evidence through independently retained checkpoints or equivalent protected storage; an editable table called `audit` is not tamper-evident.
- **Logs and traces:** carry request/trace ID, organization/property IDs, workflow/action/attempt ID, connector and deployed revision. Use structured error codes and redacted summaries. Do not log credentials, raw transcripts, caller numbers or full external payloads by default. Restricted evidence must be fetched through audited, role-scoped access.
- **Metrics:** track request and webhook latency, rejected signatures, deduplication, queue depth/oldest age, retries/dead letters, connector error/read-back mismatch rate, source freshness, booking contention, worker saturation and configuration version. Measure cost and usage by organization/connector without using unbounded customer labels in metrics.
- **Health:** separate process liveness, dependency readiness and property/connector workflow health. The public `api/health.ts` probe uses an explicit legacy infrastructure scope and returns no customer records; it is not proof of a successful booking, complete tenant configuration or voice performance. Keep detailed diagnostics authenticated.
- **Operator workflow:** locate an incident from a trace or action ID, inspect the scoped timeline and decision versions, identify whether a side effect happened, apply a permitted correction and replay safely. Support access and replay must themselves be audited.

Publish service objectives and alert routing only after owners approve measurable thresholds. Add runbooks for provider outage, database unavailability, webhook backlog, booking divergence, failed escalation, credential expiry, unauthorized access and deployment regression. Each runbook needs a detection signal, owner, containment steps, recovery verification and evidence location.

## 7. Recovery, release and acceptance

Maintain separate development, staging and production resources and credentials. The fixture server intentionally ignores live Redis/Vapi credentials and resets operational data; keep that behavior. A demo seed belongs only to its designated demo organization/property. Build artifacts and test fixtures must never include production credentials or resident data.

Before a production activation, establish approved recovery-point and recovery-time objectives, encrypted backups, restoration credentials and a restore drill into an isolated environment. Verify schema version, record counts, ownership constraints, booking intervals, required audit history and connector mappings. A successful backup job is not a restore demonstration. A rollback must account for both application and schema compatibility, and must not replay external actions blindly.

Retention requires scheduled, auditable jobs for raw audio, transcripts, attachments, exports and expired sessions/receipts, according to approved policy and legal holds. Deletion must cover replicas, derived stores and provider-held copies where supported, while preserving permitted audit evidence. Tenant offboarding must revoke users, service credentials, sender bindings and queued work before export/deletion completion is claimed.

Keep the current fast gate:

```sh
npm ci
npm run check
npm run build
```

Add release gates in stages, with evidence tied to the exact commit, configuration and schema versions:

1. Repository contract tests against memory and the real database engine, migration tests, direct database scope violations, transaction concurrency and two-organization/two-property authorization tests.
2. Handler-to-worker-to-provider contract tests, including duplicate/out-of-order events, uncertain writes, expired credentials, authority revocation, stopped workers, dead-letter replay and reconciliation.
3. Browser smoke tests of login, property switching, role restrictions, configuration changes, booking, failure visibility and operator recovery. Test compiled artifacts as well as source mode.
4. Approved staging provider scenarios and post-deployment synthetic checks; voice tests must measure the actual channel, interruptions and latency rather than treating text simulations as equivalent.
5. Dependency/secret scanning, static security checks, SBOM generation, branch protection/review, targeted security assessment and documented handling of high-severity findings.
6. Backup restore and rollback evidence, operational alerts and incident ownership before activating a property.

Critical invariant failures block promotion. Feature flags and staged property activation must be server-owned configuration, defaulting new external capabilities to inactive. No UI copy may claim a message, booking, dispatch or deployment succeeded solely because a request was attempted.

## 8. Implementation sequence and first foundation milestone

### Milestone 1 — explicit property scope and configurable property records

This is the next foundation priority. Deliver one vertical slice from authenticated request through authorization, property configuration, repository and existing leasing/calendar rules. It should support **two organizations with two distinct properties each**, without changing the application source for the fourth property.

- Introduce validated organization/property/membership records and a scope resolver behind the current account/session adapter. Preserve the existing demo login during migration.
- Add versioned property configuration for identity, location/timezone, inventory/knowledge source bindings, showing rules, escalation contacts and channel bindings. Keep secrets as references to protected server-side storage.
- Add scoped `PropertyRepository` and `InventoryPort` boundaries; move direct `data/*.json` imports into an explicit fixture adapter. Empty customer configuration must fail visibly rather than inherit Larkin facts.
- Select and document the transactional store, add initial schema/migrations, and implement the same repository contracts against an isolated test database. An in-memory implementation alone does not finish this milestone.
- Move context assembly out of `api/vapi.ts` into an application use case. Resolve scope once from an authenticated staff membership or verified provider binding; pass it through every read and mutation.
- Prove identical unit labels, contact numbers and provider-like record IDs cannot leak across organizations or unauthorized properties. Verify revocation, scoped caches, calendar rules, timezone-dependent times and unknown-property refusal.
- Document the migration and restore procedure for this slice. Cut over one demo/test organization first and retain evidence of the old/new record mapping.

### Milestone 2 — durable workflow and operator recovery

Extend the existing finished-call receipt/replay path into the inbox/action/outbox transaction, durable audit, worker leases, read-back, reconciliation and recovery UI for one real connector-backed booking workflow. Prove recovery when the process dies before send, after provider success and before verification. Follow-up records become executable only after sender ownership, consent/authority, deduplication and delivery evidence are in place.

### Milestone 3 — repeatable customer operations

Add membership administration/MFA, property onboarding with validation and dry runs, connector capability/health screens, approved configuration publication, scoped exports, retention/offboarding and tested backup recovery. Measure actual workload, latency and cost before changing deployment topology.

### Milestone 4 — expand workflows on shared foundations

Implement the remaining resident, maintenance, vendor, amenity, approval and evidence-based intelligence workflows using the same principals, action state machine, connector contracts and audit envelope. Each module needs its complete operational lifecycle and failure recovery; creating a table or a new screen does not establish delivery.

## 9. Enforceable development rules

1. New protected use cases require explicit authorized scope. Missing organization/property context is an error; never fall back to a demo tenant or bundled property.
2. Every tenant-owned repository operation and job includes ownership constraints. Add negative cross-organization and cross-property tests for new reads, writes, lists, exports and caches.
3. Keep business rules in tested domain/application modules. HTTP handlers, prompts and browser code cannot independently invent booking or authority rules.
4. No network side effects inside retryable transactions or compare-and-set callbacks. Action intent, audit and durable work must commit together before external execution.
5. An idempotency key identifies one immutable operation. A changed payload conflicts; uncertain outcomes require read-back/reconciliation.
6. New storage fields require validation, a migration/version strategy and backward compatibility or an explicit cutover plan. No production edits through one-off scripts without scoped dry-run and recovery evidence.
7. Property facts, hours, timezone, source bindings and permissions are configuration. Customer onboarding must not add conditionals such as `if tenant === ...` to domain code.
8. Every external capability declares its owner, scope, health, timeout, retries, read-back, rate budget, freshness and fallback. An unavailable connector must produce visible pending/manual work.
9. Operational errors need stable codes and trace/action IDs; secrets and raw personal content stay out of routine logs and public artifacts.
10. Tests assert business invariants and failure behavior. A fixture response is not evidence that a production provider or database works. Record what was exercised and what remains unverified.
11. Generated dashboard/site/assistant files are derived artifacts; edit their authored inputs and rebuild. Separate mechanical extraction from behavioral changes when possible, preserving regression coverage.
12. Architecture changes need a short decision record: problem, chosen boundary, alternatives considered, migration, verification and rollback. New dependencies or services need a concrete capability and operating owner.

Use this document with the current code and private acceptance requirements. When a milestone lands, update its status with specific source paths, migrations and verification evidence rather than leaving a permanent design claim that the system already satisfies.
