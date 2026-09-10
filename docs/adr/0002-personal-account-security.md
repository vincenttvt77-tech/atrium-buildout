# 0002 — Personal account security, separate from building administration

Status: accepted for the PostgreSQL implementation slice, 2026-09-09.

## Context

An Atrium user is a global identity with memberships in one or more organizations.
A building or portfolio administrator can manage access only within that authority.
Resetting a shared user's password would also affect unrelated organizations.
Personal account security must work even when the user has no property grants or
no published property configuration. Existing deployment secrets are configured
once; routine sign-in and password changes must not edit environment files.

## Decision

Provide a property-independent `/api/account` page and password-change command in
the PostgreSQL runtime. The signed-in person confirms their current password and
chooses a different password of at least 15 Unicode code points, bounded by the
existing 256-code-unit verifier. No composition requirements or silent trimming
are introduced, and existing demo credentials are not changed by deployment.

The HTTP boundary requires a same-origin JSON request, a signed short-lived form
token bound to user/credential version, and the immutable rendered user identity.
No target-user, role, organization, property, credential version, or new hash is
accepted from the browser. The server passes a runtime-issued human principal to
the command. A disabled initial submit button and explicit POST action prevent
credentials from falling into URL parameters if JavaScript fails.

A durable database reservation limits password-change attempts across application
instances before expensive password verification. Scrypt verification/hashing runs
outside locks. A second short transaction checks the active user, current hash and
credential version again under locks, then saves the replacement, advances the
session version, and appends a minimal self-security audit atomically. An expired,
used or stale reservation cannot restore an earlier password. Wrong passwords and
failed operations never produce a success receipt.

Only finite private SQL commands are executable through the existing authenticator
connection. Their dedicated NOLOGIN, non-BYPASSRLS execution role has narrowly
scoped rights under forced row-level security. Runtime roles receive neither raw
credential writes nor membership in the execution role. The migration administrator
remains absent from all HTTP connection configuration.

After confirmed commit, clear the current cookie. All earlier sessions fail fresh
credential-version authentication. Require normal sign-in again. The page confirms
success only for a well-formed response matching the rendered identity. A lost,
malformed or otherwise uncertain response retires the form and offers explicit
reauthentication with the new password first; it never blindly retries a password
rotation. Passwords and hashes are absent from audit records and API responses.

## Consequences and remaining gates

This implements personal password changes, not credential recovery. Organization
administrators cannot choose another person's password. Recovery requires a
verified user-owned channel; invitations require acceptance by the intended person.
Neither should be simulated by an unsafe global-username upsert.

The full SOW15.2 requires MFA for privileged roles. This slice does not satisfy MFA,
enterprise SSO, breached-password screening, authentication-wide distributed rate
limiting, verified recovery or a production identity-provider decision. Complete
those gates before activating privileged customer administration. The bounded
password-change limiter does not replace login abuse controls.

Next dependencies: accepted invitations and scoped membership administration;
serialized last-owner protection and automatic permission revisions; MFA/session
recovery; guided property publication; rehearsed hosted migration and restore.
A future managed identity provider must map its verified subject to the existing
Atrium user ID; organization memberships and property data remain Atrium-owned.
Keep that exchange behind the authorization/session adapter so adopting SSO/MFA
does not require changing booking, maintenance or membership ownership. Do not
use a provider email or a browser role claim as a tenant key.

The live legacy demo remains on its existing passcode/KV runtime until a separately
verified migration. Local success is not evidence of a hosted account cutover.

References: [NIST password requirements](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/),
[OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html),
[OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html),
[PostgreSQL function security](https://www.postgresql.org/docs/17/sql-createfunction.html),
[Supabase private function privileges](https://supabase.com/docs/guides/database/functions#function-privileges).
