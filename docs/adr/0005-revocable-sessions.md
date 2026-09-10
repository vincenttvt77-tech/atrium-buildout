# 0005 — Registered and revocable staff sessions

Status: implemented for the PostgreSQL runtime. Apply the new migration and release
the matching application together before activating it in an environment. This is
part of SOW section 15.2; MFA, recovery, enterprise SSO and customer onboarding remain
separate work.

## Problem and decision

Previously a valid signed user cookie remained usable until expiration or a password
version change. Clearing one browser's cookie did not invalidate a copied cookie.
Staff could not see or revoke individual logins. A server-side session registry now
backs every PostgreSQL HTTP login and authenticated request.

After the shared sign-in reservation and password verification, the server creates
a random UUID session and commits its registration before issuing a cookie. The
`a4` signed cookie contains only user ID, credential version, session ID and the
registry's exact expiration. It contains no property, permissions or password.
Authentication checks the signature, registered record, revocation, expiration and
current user/version; authorization still checks current property access separately.
A database failure refuses access. There is no stateless or legacy fallback.

Database time fixes expiration at eight hours after registration. Page activity and
cookie reissuance do not extend it. The application also rejects expired signed
claims. Hosts must maintain synchronized clocks; a small database clock lead must
not make a newly registered cookie impossible to issue. Returned records must still
have the exact eight-hour lifetime and match all signed identifiers and expiration.

At most 20 sessions are active for one user/version. A new successful login revokes
the oldest active sessions needed to remain within this limit, in the same
transaction as registration and audit. The limit concerns active sessions, not
total historical rows. Password rotation invalidates prior credential versions;
disabled users cannot use their recorded sessions.

## User controls and truthful responses

Account security is available from Status and the property picker, even without a
property grant. It lists only the current user's active sessions and offers sign-out
for one session, the current session or all other sessions. Labels contain coarse
browser/device names derived from the user agent; they are hints, not verified
device identity. Raw user agents, IP addresses and locations are not stored here.
Times display in the viewer's device timezone. Last connection includes background
refreshes and is not a measure of deliberate human activity.

Every account mutation and authenticated dashboard logout requires same-origin
JSON, the rendered user/session IDs and a signed token bound to that session. The
form token expires after one hour; an older page must reload. A login change in
another tab therefore cannot silently retarget a stale page's sign-out or password
change. Session IDs and form tokens are not substitutes for the signed HTTP-only
session cookie.

The server confirms revocation only after commit. Unknown and other-user targets
receive the same generic refusal, with no identity disclosure. An owned session
already inactive permits a verified idempotent response. The current-session action
must return an explicit current-session revocation receipt. The page validates
receipt identities and session IDs before confirming success. A timeout, malformed
receipt or lost response retires the controls and requests reload/sign-in; it never
automatically retries "all other sessions" against a possibly changed session set.
Logout does not clear the cookie or show a signed-out state on an uncertain failure.

## Database authority and transaction ordering

The private forced-RLS registry and immutable lifecycle audit are accessed through
finite commands owned by `atrium_session_executor`, a NOLOGIN, non-BYPASSRLS role.
The authenticator may register, resolve, list and revoke sessions; it cannot mutate
registry rows directly. The property application role can execute only the narrow
current-session transaction fence. Neither runtime role may inherit the executor.
Its user lock privilege cannot update an identity, and it has no credential or
property data access. Functions use fixed search paths and explicit execution grants.

All pooled transactions bind or clear `session_id` along with every other identity
setting. Staff authentication and RLS validate it when present. Channel contexts
must have no human session ID. Only explicitly trusted internal non-HTTP operations
can use an opaque user principal without a registered browser session; public
password-login endpoints must register a session through `DatabaseRuntime.signIn`.

Before any property/document/calendar locks, a managed user property transaction
holds shared locks on the user and then the exact active session until commit or
rollback. Session revocation, session-limit eviction and password rotation acquire
the user lock exclusively first. An admitted operation can finish before revocation;
the revoker waits for it. Once revocation commits, an operation using that session
cannot pass the fence. Both race orders and rollback must be covered by native tests.
Do not perform network requests or expensive password hashing while holding these
locks. Keep transactions short and retain the existing entry/exit checks for grants,
property state and configuration. The fence does not serialize all membership or
configuration changes and does not cancel work already committed.

Background workflows reauthorize their durable initiating actor and permissions;
they do not inherit a browser cookie's lifetime. Temporary workflow contexts clear
and restore session identity. Browser logout is not a claim that already accepted
background work has been canceled.

## Rollout and remaining work

Provision the executor role before applying the immutable user-sessions migration.
Release the matching application and database together: PostgreSQL `a3` cookies
are deliberately rejected after this change and users sign in again with their
existing username/password. Do not change their credentials or require environment
edits per login. A rollback to stateless application code would weaken revocation;
treat rollback as a coordinated security decision, not a way to bypass migration.
The separate legacy KV/shared-passcode runtime and its production login are unchanged.

Follow-on work includes session-bound MFA and privilege elevation, verified member
invitations and recovery, idle expiration/renewal policy, breach response, operational
monitoring, and an approved archival/retention workflow. Historical session/audit rows
are immutable and currently retained without a purge path. The current account page
is personal session management, not a tenant-wide audit or administrator reset UI.
Local tests do not prove a hosted database rollout, production recovery or full SOW
security acceptance.

## References

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Personal account security](0002-personal-account-security.md)
- [Organization administration](0003-organization-administration.md)
- [Shared sign-in protection](0004-login-protection.md)
