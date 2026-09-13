# 0003 — Organization administration with accepted invitations

Status: existing-member directory and access replacement implemented in PostgreSQL,
with registered-session WebAuthn assurance and a responsive Team page. Invitation
delivery, verified recipient acceptance and new-account onboarding remain future work.
Hosted activation and production acceptance are separate from source implementation.

## Context

Atrium identities are global. A person may belong to several organizations, each
with independent memberships and explicit property access. An organization owner
must be able to invite staff and adjust that organization's access without taking
over the person's account, changing another organization's membership, or requiring
a published property configuration merely to open administration.

[ADR 0002](0002-personal-account-security.md) implements personal password changes.
It grants no administrator password-reset authority. The current PostgreSQL `a4`
cookie identifies a persisted revocable session; WebAuthn assurances are stored and
checked independently. A role name, a browser Boolean, or successful password
authentication is not proof of multi-factor verification.

## Current implementation

`src/auth/administration.ts` contains current-snapshot policy functions, an opaque
organization read/preparation scope, a read-only preparation service and finite
ports for future invitation acceptance. The production existing-member path is
`src/auth/organization-management.ts`, `src/database/organization-administration.ts`,
`db/organization-administration.sql` and `GET/POST /api/organizations`. It uses the
actual request runtime's registered session and purpose-specific WebAuthn adapter.
The Team screen lists only administrable organizations and scoped existing members,
then reviews and saves a complete role/status/property manifest. It does not create
new users, send invitations, reset another person's password or change global status.

Directory responses issue a form token bound to the current user, credential version,
registered session, selected organization and replacement action. POST also checks
the exact configured origin and user/session headers. A page token alone cannot
change a different organization. Ambiguous saves retain the original manifest and
request ID for explicit reconciliation; they do not silently create a fresh command.
Exact safe receipts remain available to the same active user/current credential
version after intentional self-demotion or fresh authentication in another session.
Every reconciliation still requires fresh proof for that exact current session;
old browser headers cannot operate with a replacement login. Receipt recovery does
not expose the directory or restore authority. A recovered receipt proves the earlier
commit, not that no later administrator has changed that membership.

The service accepts a runtime-issued human principal and explicit organization ID.
Channel capabilities, legacy tenant IDs and selected-property cookies confer no
organization-administration authority. It reads current user status/credential
version, organization, membership, property identities/status and grants. It does
not load inventory, timezone or published configuration. Property-limited owners
can administer their existing grant set; a property publication outage does not
remove the separate organization administration boundary.

`authorizeOrganization` issues a frozen scope with runtime provenance. Preparation
methods return frozen plans marked `executionAuthority: false`. Such a plan is a
preview, not an approval token. The future transaction interface accepts original
commands and the verified request context, never a plan or cached scope as authority.
Pure policy functions are intentionally atemporal: the trusted caller supplies
current snapshots, while the service and future database command check time-sensitive
verification, invitation expiry and revocation. A pure function does not establish
that its input came from a database or that concurrent changes were serialized.

## Delegation policy

- An active owner may manage owner/admin/staff/viewer roles. An active admin may
  manage staff/viewer only, never another owner/admin or their own membership.
  Staff/viewer and voice/channel principals cannot administer members.
- Organization-wide property access is explicit `access: organization`, with no
  property IDs. An owner role alone does not confer organization-wide access.
  Property-limited administrators may delegate only their current active grants.
- Replacement applies to the entire membership access manifest. A limited
  administrator cannot alter a target whose current access is broader, even when
  requesting a narrower result. An organization-wide owner can handle cleanup of
  grants to inactive properties; partial authority does not justify changing a
  wider membership.
- Target user and organization ownership are immutable. Commands cannot set global
  user status, username, display name, password, credential version, or membership
  in another organization. A shared user's access elsewhere is unaffected.
- A replacement carries `expectedVersion`. Membership and grant changes must advance
  one aggregate membership version exactly once in the finite replacement command.
  Privileged maintenance must follow that same invariant; there is no broad grant
  trigger that silently changes versions for seed or maintenance scripts.
  Unsafe integer overflow refuses the operation; a browser version is concurrency
  input, never authorization.
- Removing or demoting an active owner requires another active owner, counting both
  active membership and active user. An intentional owner self-demotion is permitted
  with another owner. Lock-time policy must distinguish that requested change from
  unrelated revocation, rather than rejecting every legitimate self-demotion in a
  generic post-write role check.

## Verified MFA boundary

Every privileged organization read/preparation requires a trusted
`PrivilegedAuthentication` adapter bound to the exact request's authenticated
session. A proof binds issuer, session, user, current credential version,
organization-administration purpose, verification ID, factor method and bounded
verification/expiry times. The current policy accepts a maximum ten-minute proof
window. A real adapter must recheck factor/session revocation and establish the
factor; checking the shape of the returned record is not MFA verification.

There is deliberately no fallback adapter or Boolean flag. The cookie alone cannot
supply this proof. Registered sessions and durable/revocable passkeys, recovery and
rate limits are implemented in ADRs 0005/0006. Physical-device and hosted acceptance
remain deployment gates. Verified invitation-recipient identity remains unimplemented.
A per-user `mfa: true` flag would improperly elevate every concurrent session.
Privileged owner/admin invitation acceptance also requires MFA for the accepting
user's exact session or the exact new-user enrollment session.

## Invitation and first-account acceptance

Creating an invitation records the selected organization, requested role/access,
canonical recipient email, current inviter and verification reference. Email here
is a recipient binding, not permission to create or modify a matching global user.
The eventual input adapter and identity provider must agree on canonical recipient
comparison. The domain requires a normalized value and does no fuzzy matching.
A high-entropy single-use token is stored only as a digest; raw tokens and passwords
must not enter audit, logs, URLs that are logged, or generic idempotency payloads.
There is no email delivery claim until a chosen provider is connected and verified.

Acceptance has two explicit paths:

1. **Existing account:** the intended recipient signs in and proves that the
   invitation belongs to their verified recipient identity and session. Attach a
   new membership to that stable user ID. Do not change their username, profile,
   password or other memberships. If a membership already exists, use the reviewed
   member-replacement path; an invitation cannot overwrite it.
2. **New account (future):** the recipient proves ownership and chooses username,
   display name and their own password. Create a pending identity with no organization
   access, then complete session-bound passkey enrollment before attaching membership. A
   trusted enrollment adapter prepares credentials outside database locks and
   returns a request-bound enrollment identity, not an invented authenticated user.
   Username availability is not ownership proof. The transaction inserts a new
   globally unique identity; a username conflict aborts without updating its owner.
   Existing accounts must use the authenticated acceptance path. No `ON CONFLICT`
   credential/profile upsert, administrator-chosen password or global directory
   enumeration is permitted.

The preparation service consumes only the verified enrollment reference; its plans
contain no password, hash or invitation token. The future finite command contract
includes user-chosen credential input for the new-account route. That service must
apply password policy and compromised-password screening, hash outside locks, and
bind the prepared credential to the same verified enrollment. Such credential
preparation is unimplemented, not a placeholder hash or a trusted browser field.

At acceptance, recheck the invitation's pending state, version, recipient, expiry
and current inviter authority. The preparation service rechecks recipient and
invitation expiry after awaiting the current snapshot, so a proof that expires
during that read cannot produce a preview. Revoked inviter membership or removed grants must
not be preserved by an old invitation. An expired/revoked/used invitation cannot
create membership. Exact committed acceptance retry is resolved by a secret-free
receipt before normal used-token refusal, and only for the same verified subject
and original request. Preparation alone cannot provide this retry behavior.

## Required transaction and privilege boundary

Implement finite organization commands using the existing protected database
connection and a narrowly reviewed execution boundary. Runtime roles must retain
no raw identity/membership/credential write privileges or membership in an executor
role. Any new private SECURITY DEFINER functions require explicit ownership,
non-BYPASSRLS execution, fixed search path, denied PUBLIC execution, forced RLS,
minimal grants and direct runtime privilege tests; do not widen the existing
self-password functions to become arbitrary administration commands.

Existing-member replacement locks actor and target users in sorted ID order, then
the exact session/MFA rows, organization, memberships, properties and grants.
Invitation acceptance must follow the same order and add its invitation lock.
The organization row serializes all membership/owner-count transitions, including
invitation acceptance. Re-read actor, current MFA/session, target version/access,
recipient proof and post-change owner count under the same locks. Two owners
cannot both pass an unlocked pre-read and remove one another. Any future global
user deactivation must participate for every affected owner organization; it is
outside this contract. Delayed commands must not reuse an earlier preparation scope.

Replacement commits membership/grants, aggregate version, command receipt and
secret-free organization audit together. Existing-user acceptance commits membership/grants, token consumption, receipt and
audit in one transaction. Future new-user onboarding stages an access-free identity
first because the implemented passkey registry requires a persisted user/session;
final acceptance must atomically consume the verified enrollment/invitation and
attach access. That staged contract supersedes the earlier new-user all-in-one
preparation sketch and must be implemented and tested before enabling signup. Audit or unique-constraint failure rolls back all of them.
No hashing, MFA-provider call, email delivery or other network operation belongs
inside a held SQL transaction. Commit-time verification uses authenticated durable
references and current revocation state, not a provider call under a lock.

Idempotency keys are bounded, scoped by organization/operation/actor and compared
against the exact safe command manifest. A changed manifest conflicts. Retry must
not generate a second invitation or replace an accepted identity. Token issuance
needs a recoverable secure delivery/reissue design: losing a response must not
silently leave multiple unknown active invitations. Raw credentials are excluded
from manifest hashes as well as plaintext receipts/audits; reconcile a signup by
its verified enrollment and accepted identity instead.

Organization audit is independent of property operational audit: record current
actor/verification references, affected identity/membership, safe before/after
access, request ID, versions and database time. Do not manufacture a property ID,
expose other organizations, or describe an append-only table as tamper-evident.

## Acceptance gates for the next slice

Domain policy tests are complemented by native PostgreSQL, HTTP and actual browser
regressions for existing-member management. Release records identify actual results;
no test count here is a production certification. Preserve these gates and add the
unimplemented invitation/onboarding cases before enabling those flows:

- Concurrent two-owner removal, actor/grant revocation, target version changes and
  factor/session revocation under the final lock protocol.
- Shared global identity with independent organizations, full grant replacement,
  denied raw runtime writes and failure of every audit/receipt/overflow stage.
- Existing and new recipient acceptance, two concurrent accepts, duplicate
  usernames without takeover, expired/revoked/consumed tokens, stale enrollment,
  credential-preparation binding and exact retry after an ambiguous response.
- Mandatory MFA enrollment/verification/recovery; CSRF and same-origin protection;
  scope-bound directory pagination without global lookup; secret-safe transport;
  observed mobile/desktop invite and member-management flows.

The next implementation owner should deliver verified-recipient onboarding and
invitation acceptance using these boundaries. Existing-member access replacement
is not complete customer onboarding and does not supply a resident identity model.
