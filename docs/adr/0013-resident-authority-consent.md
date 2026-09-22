# ADR 0013 — Resident authentication and consent boundaries

Status: session audiences, first-party enrollment and exact work/entry consent accepted. Consent implementation is under integration verification. This decision does not activate a hosted deployment.

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

## Exact work and entry consent

Property owners publish current consent rules, including explicit funding, the recipient and entry review protocols, expiry limits and a staff help route. The first supported funding policy is `property_no_resident_charge`: the property pays and the resident owes zero. A cost ceiling alone cannot imply this arrangement. Other funding and assisted consent protocols need separate implementation.

Staff review the complete current household roster, including members who are not required to decide, and record each required person's work and entry authority against their actual resident-account binding. Enrollment and occupancy alone confer neither authority. An empty required set is held; a genuinely unnecessary purpose is explicitly marked `not_required`. Renewing revoked authority requires a reviewed new revision of the same binding/purpose chain. A new binding needs its own authority chain.

Work and entry requests have independent IDs and revisions. Their common material digest binds the exact case, plan, scope, all-in property cost, funding, named internal team/vendor and current financial authority. Each purpose additionally pins its own reviewed roster/authority and public terms. Entry adds a bounded window with timezone, local time and explicit offset; local values must agree with the actual timezone at both endpoints. Changing only that window requires new entry decisions while unchanged work consent remains valid. Shared material changes hold both purposes.

`/api/maintenance-consent` is staff-only. Policy and household/authority changes require current configure access and fresh administration MFA; request publication requires operate access. Case-specific forms cannot select another case or unit. `/api/resident-consent` accepts only resident sessions and projects the person's own public terms, decisions, receipt and history. It does not expose the household directory, sources, staff notes, other people's decisions or security material.

Approval requires a new user-verifying passkey assertion for that exact request, revision, terms/material digests, resident, credential version, session, security state, RP and origin. Its private proof brand is distinct from ordinary login or administration verification. Reservation, one-use attempt, shared factor-counter revision compare-and-swap, decision and recovery receipt are checked and committed atomically. Even a zero-counter authenticator uses the shared revision to reject concurrent reuse. A staff-held password, browser flag, caller statement or generic MFA proof cannot become resident approval.

Every required person's grant must remain current. Source/policy/occupancy/binding changes, lost purpose authority, disabled accounts, credential changes, revoked signing factors and changed terms hold permission. Ordinary logout, session expiry, unrelated factor use or adding another passkey does not erase a completed grant. The response deadline closes new approvals; it does not invalidate a completed grant before its own consent or entry expiry.

Residents can decline, reconsider and revoke only their exact current grant, with immutable versioned history. Historical terms and self-reduction remain available after source expiry or staff withdrawal through a current authenticated resident session with its ordinary login MFA. A new grant still needs current authority. Historical receipts do not restore permission. Unknown saves retain their non-authorizing command/request identifiers for explicit receipt lookup; the client never silently issues a new command or retries the write.

The finite `atrium_consent_executor` has NOLOGIN/NOBYPASSRLS and fixed private-schema command entry points, not general identity or credential access. Writes discover a bounded relevant user set, acquire sorted user locks before session/security, organization and exclusive property locks, then rediscover the graph and reject changed membership of that set. Planning reads use a minimal consent projection under the existing scoped property transaction. Detail/inbox compare initial and final evidence before filtering or pagination, and HTTP responses check current projection deadlines after their final awaited authorization check. History and receipts are not capped by a current-permission deadline.

Apply `20260913173058_resident_consent.sql` after enrollment, with its restricted executor provisioned first. Historical migrations remain immutable. The local runner and native fixtures support this additive upgrade; hosted database/runtime activation remains separate.

## Remaining fulfillment

Consent contributes current readiness to maintenance detail and Work plans. Missing or stale setup, declined and revoked decisions need property-team attention; a current request awaiting required decisions belongs with resident follow-up. It records no appointment, dispatch, delivery, payment or resolution.

Full fulfillment still needs an exact job manifest, current consent and spending admission at execution, transactional outbox integration, authorized provider adapters, replay-safe dispatch/readback, appointment acceptance, resident updates and evidence-based closure. A changed or revoked permission after external commitment must enter reconciliation rather than merely displaying a local cancellation. Real provider, physical-device, accessible assisted/SMS protocol and hosted rollout acceptance remain required for the wider product.

## Related decisions

- [Registered sessions](0005-revocable-sessions.md)
- [Passkeys and recovery](0006-multi-factor-authentication.md)
- [Staff resident records](0010-resident-service-records.md)
- [Maintenance authority](0011-maintenance-authority.md)
