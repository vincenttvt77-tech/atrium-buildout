# ADR 0013 — Resident authentication and consent boundaries

Status: session audience foundation and first-party enrollment accepted locally. Exact work and entry consent remain subsequent work. This decision does not activate a hosted deployment.

## Shared account, separate session audiences

Reuse Atrium's persisted credentials and password verification for first-party resident sign-in. An external identity provider is not required for this path. Account control, current residency, permission to consent and staff authority remain separate facts. A user may eventually hold several resident relationships and staff memberships, but a resident login cannot use the person's staff grants.

Every registered session has an immutable `staff` or `resident` audience. The signed cookie, validated record, opaque principal and transaction context must agree. Existing `a4` staff cookies retain the exact payload and signature purpose. New `r1` cookies use a different signature purpose and the `atrium_resident_session` cookie name. Moving a cookie between names, changing its prefix or issuing a staff-shaped token around a resident session ID cannot grant staff access.

The shared runtime exposes resident password and session authentication separately from staff authorization. Resident authentication proves control of the account only; it does not create a residency binding or authorize maintenance consent. Staff property selection, dashboard, account page, Team, Service, Work queue and maintenance planning continue to require staff sessions. The resident portal uses `/api/resident`; its own passkey surface is the fixed resident-audience `/api/resident?resource=mfa`. The existing `/api/mfa` endpoint remains fixed to staff. Requests cannot choose a security audience through a body field or cookie-name substitution.

Parsed session rows must contain a valid audience; missing or unknown values refuse authentication. Trusted internal issuance may default existing callers to staff. Database transactions set or clear `session_audience` on every pooled use. Missing legacy database context means staff only and must match a persisted staff session; it never infers authority from an arbitrary supplied session ID. Sessionless internal staff operations remain a trusted server capability. Resident context without a registered session cannot use it.

## Account security semantics

The 20-active-session limit, session listing and ordinary individual/all-other revocation are per user, credential version and audience. The staff account page labels its list accordingly. Password rotation invalidates sessions in both audiences. Passkey recovery deliberately revokes other sessions across the shared identity; ordinary resident session controls cannot revoke a staff session.

Both interactive login methods consume the same account and network rate limits before credential verification. They do not double the allowed password-guessing budget. Deliberately reused self-password and self-MFA commands preserve the current audience and exact session. Organization-administration challenges and assurance require a staff session. Neither MFA nor a membership change upgrades a session audience in place. Session-bound audit/proof history derives audience from the immutable session record.

## Database rollout

Apply `20260913091003_session_audience.sql` after all preceding migrations, including maintenance planning, before deploying this code into a PostgreSQL runtime. Existing rows become staff sessions without changing IDs, expiration, credentials or old cookies. The new application requires the audience column and refuses an old schema. The additive migration keeps existing function signatures and staff context behavior for database-first rollout.

The migration introduces no new role, public API or external identity dependency. It preserves forced RLS and finite command ownership. Native tests cover populated upgrade baselines, old staff cookies, actual restricted-role queries, dual-role identities, revoked/expired sessions, per-audience caps, audit rollback and concurrent operations. HTTP tests use actual local handlers and a disposable database. These checks do not establish a hosted rollout, live identity verification or phone behavior.

## First-party resident enrollment

The first supported enrollment protocol is an in-person recipient check defined and approved by the property. An absent, disabled or expired policy holds enrollment. A current staff configure actor with fresh organization-administration passkey verification publishes policy, records a completed recipient check and prepares an invitation. The invitation includes an immutable reference to the check; no ID document, ID number or automatically matched phone/email establishes the relationship.

An invitation pins organization, property, resident/source, policy and configuration versions. Its deadline is capped by the configured lifetime, recipient check freshness, source/policy validity and occupancy end. Its issuer must retain current configure authority. Policy/source/occupancy changes hold access rather than silently renewing old evidence. A new recipient check is required for a new invitation. Revocation remains available when the underlying source or policy is stale.

The raw 256-bit invitation token is shown once to the staff operator for private handoff; the database stores its digest only. Atrium does not send a message or claim delivery. The token travels in a URL fragment, which the resident client removes from browser history before asynchronous work. A same-origin, browser-form-bound exchange creates a short-lived HttpOnly invitation context. Preview returns only the selected property, unit, masked recipient hint and expiry. Every activation requires an explicit review of these facts.

A new resident chooses a username, display name and password of at least 15 Unicode characters. Creating the account and password record, binding the resident, consuming the invitation and saving the immutable receipt/event is one transaction. A normalized username collision never overwrites, resets or links another account. An existing user signs in through the resident audience, completes current login MFA if required and verifies the existing password before binding. Credentials, profile and staff memberships remain unchanged. No password work is performed while holding database locks.

Shared username/network login budgets apply before password work; enrollment also has token/client budgets and bounded attempt cleanup. New-user and existing-user lock ordering is designed to serialize username uniqueness, user/session changes and property/resident/invitation authority. The final database command rechecks current authority and expiry after waits. One narrow NOLOGIN/NOBYPASSRLS executor owns finite staff and resident commands; application and authenticator roles cannot write raw account or enrollment records. Private enrollment selectors are cleared on every pooled transaction and temporary workflow context.

Losing an issuance response cannot recover a digest-only handoff URL. Staff first read the saved command receipt, then explicitly replace the invitation if necessary. Losing activation requires ordinary account sign-in and own-receipt reconciliation, not a password reset or another automatically minted account. A browser may retain only the non-authorizing request and invitation IDs for this recovery; no token, password, contact or command is stored. Historical receipts and current binding status are displayed separately. Scoped binding revocation leaves the shared account, unrelated properties and staff sessions intact.

Apply additive `20260913160945_resident_enrollment.sql` after the audience migration and provision the restricted `atrium_enrollment_executor` before applying it. A database-first upgrade preserves existing users, credentials and staff sessions. Local tests and screens do not establish that these migrations or a real property protocol are active in a hosted environment.

## Required consent and fulfillment work

Enrollment needs an explicit current property-residency-to-user binding and an approved identity/delivery protocol. Staff must not create a known password and label subsequent actions independent resident consent. A new resident chooses their credentials; linking an existing account requires authenticating that account. Never merge or link global accounts by matching email, phone, name or unit. Invitations must be scoped, expiring, revocable and one-use, with atomic activation and recoverable receipts.

Resident authority must be opaque and separate from staff property scope. Future resident reads must project only the person's permitted information, including a staff-reviewed resident-facing work summary. Do not expose staff notes, directories or the complete maintenance authority graph. Current enrollment, residency evidence and property policy must be rechecked after waits and immediately before committing decisions.

Work consent and entry permission are separate decisions. Each binds the exact case, unit, work scope, plan/policy/vendor revisions, currency/cost ceiling, terms and relevant authority versions. Entry additionally requires explicit date/time boundaries and timezone; nonexistent or repeated local times need explicit resolution. Material changes require new consent. Fresh purpose-specific assurance, explicit decline, revocation, immutable history, exact replay receipts and unknown-outcome recovery remain required.

A saved approval must never claim vendor dispatch, delivery, payment, appointment acceptance or resolution. Those require current downstream authority and verified provider effects. The complete maintenance lifecycle and wider product scope remain open.

## Related decisions

- [Registered sessions](0005-revocable-sessions.md)
- [Passkeys and recovery](0006-multi-factor-authentication.md)
- [Staff resident records](0010-resident-service-records.md)
- [Maintenance authority](0011-maintenance-authority.md)
