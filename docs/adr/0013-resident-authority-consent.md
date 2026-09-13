# ADR 0013 — Resident authentication and consent boundaries

Status: session audience foundation implemented locally; enrollment and consent remain subsequent work. This decision does not activate a resident portal or change a hosted deployment.

## Shared account, separate session audiences

Reuse Atrium's persisted credentials and password verification for first-party resident sign-in. An external identity provider is not required for this path. Account control, current residency, permission to consent and staff authority remain separate facts. A user may eventually hold several resident relationships and staff memberships, but a resident login cannot use the person's staff grants.

Every registered session has an immutable `staff` or `resident` audience. The signed cookie, validated record, opaque principal and transaction context must agree. Existing `a4` staff cookies retain the exact payload and signature purpose. New `r1` cookies use a different signature purpose and the `atrium_resident_session` cookie name. Moving a cookie between names, changing its prefix or issuing a staff-shaped token around a resident session ID cannot grant staff access.

The shared runtime exposes resident password and session authentication separately from staff authorization. Resident authentication proves control of the account only; it does not create a residency binding or authorize maintenance consent. Staff property selection, dashboard, account/MFA pages, Team, Service, Work queue and maintenance planning continue to require staff sessions. No resident HTTP sign-in or self-security page is delivered by this foundation.

Parsed session rows must contain a valid audience; missing or unknown values refuse authentication. Trusted internal issuance may default existing callers to staff. Database transactions set or clear `session_audience` on every pooled use. Missing legacy database context means staff only and must match a persisted staff session; it never infers authority from an arbitrary supplied session ID. Sessionless internal staff operations remain a trusted server capability. Resident context without a registered session cannot use it.

## Account security semantics

The 20-active-session limit, session listing and ordinary individual/all-other revocation are per user, credential version and audience. The staff account page labels its list accordingly. Password rotation invalidates sessions in both audiences. Passkey recovery deliberately revokes other sessions across the shared identity; ordinary resident session controls cannot revoke a staff session.

Both interactive login methods consume the same account and network rate limits before credential verification. They do not double the allowed password-guessing budget. Deliberately reused self-password and self-MFA commands preserve the current audience and exact session. Organization-administration challenges and assurance require a staff session. Neither MFA nor a membership change upgrades a session audience in place. Session-bound audit/proof history derives audience from the immutable session record.

## Database rollout

Apply `20260913091003_session_audience.sql` after all preceding migrations, including maintenance planning, before deploying this code into a PostgreSQL runtime. Existing rows become staff sessions without changing IDs, expiration, credentials or old cookies. The new application requires the audience column and refuses an old schema. The additive migration keeps existing function signatures and staff context behavior for database-first rollout.

The migration introduces no new role, public API or external identity dependency. It preserves forced RLS and finite command ownership. Native tests cover populated upgrade baselines, old staff cookies, actual restricted-role queries, dual-role identities, revoked/expired sessions, per-audience caps, audit rollback and concurrent operations. HTTP tests use actual local handlers and a disposable database. These checks do not establish a hosted rollout, live identity verification or phone behavior.

## Required enrollment and consent work

Enrollment needs an explicit current property-residency-to-user binding and an approved identity/delivery protocol. Staff must not create a known password and label subsequent actions independent resident consent. A new resident chooses their credentials; linking an existing account requires authenticating that account. Never merge or link global accounts by matching email, phone, name or unit. Invitations must be scoped, expiring, revocable and one-use, with atomic activation and recoverable receipts.

Resident authority must be opaque and separate from staff property scope. Future resident reads must project only the person's permitted information, including a staff-reviewed resident-facing work summary. Do not expose staff notes, directories or the complete maintenance authority graph. Current enrollment, residency evidence and property policy must be rechecked after waits and immediately before committing decisions.

Work consent and entry permission are separate decisions. Each binds the exact case, unit, work scope, plan/policy/vendor revisions, currency/cost ceiling, terms and relevant authority versions. Entry additionally requires explicit date/time boundaries and timezone; nonexistent or repeated local times need explicit resolution. Material changes require new consent. Fresh purpose-specific assurance, explicit decline, revocation, immutable history, exact replay receipts and unknown-outcome recovery remain required.

A saved approval must never claim vendor dispatch, delivery, payment, appointment acceptance or resolution. Those require current downstream authority and verified provider effects. The complete maintenance lifecycle and wider product scope remain open.

## Related decisions

- [Registered sessions](0005-revocable-sessions.md)
- [Passkeys and recovery](0006-multi-factor-authentication.md)
- [Staff resident records](0010-resident-service-records.md)
- [Maintenance authority](0011-maintenance-authority.md)
