# ADR 0006 — Passkeys tied to registered staff sessions

Status: implemented and tested locally; physical-device acceptance and hosted activation remain open.
Supersedes the policy-only MFA placeholder in ADR 0003; extends ADR 0005 sessions.

The supplied SOW §15.2 requires MFA for Atrium administrators and privileged client
roles. It does not prescribe a factor or identity vendor. Atrium retains global
username/password identities and implements WebAuthn with required user verification.
No deployment variable or identity-provider account is required per staff login.

## Decision

- Use pinned SimpleWebAuthn server 14.0.1/browser 14.0.0 and Node 22. Advertise ES256
  credentials, require user verification, and accept none attestation. Registration
  establishes a pending public key; a separate signed assertion activates it.
- Configure one exact `ATRIUM_AUTH_ORIGIN` per PostgreSQL deployment. Derive the RP
  identifier from that configured hostname, never request headers. HTTPS is required
  except exact localhost development origins. Origin/domain migration is explicit;
  localhost credentials are not production credentials.
- A password login creates a registered session. Every enrolled user and every user
  with an active owner/admin/staff membership must also establish session-login
  assurance before opening property data. Unenrolled viewer-only users can use a
  password-only session. Own passkey setup, recovery, session controls and logout
  remain reachable while verification is pending.
- Login assurance expires with the eight-hour registered session. Security-management
  and organization-administration proofs last at most ten minutes and never outlive
  the session. A successful active-factor assertion also establishes login assurance.
  Proofs do not confer membership permissions.
- First enrollment requires a freshly verified password. Further additions/removals
  require both fresh password verification and an active-factor management proof.
  Removing the final active factor is refused. Pending credentials expire rather than
  accumulating unusable permanent entries.
- Ordinary enrollment is capped at ten active/pending factors. A valid recovery
  grant may create one temporary replacement beyond that cap, so losing all ten
  keys does not prevent recovery. The stored set never exceeds eleven, and never
  has more than ten active factors; replacement activation revokes the prior set.
- Ten random 128-bit recovery codes are hashed with account context before storage.
  A code plus a fresh password grants only short-lived replacement setup. New-key
  assertion activates the replacement, revokes prior factors and other sessions,
  and establishes login assurance; it does not issue administrator proof. Original
  factors remain until replacement activation commits. Code plaintext is returned
  only after a confirmed matching batch write, and cannot be reread. Lost responses
  require checking state and deliberately rotating again after verification.

## Durable security boundary

Finite self-only SQL commands reserve shared budgets, issue/claim/consume challenges,
commit verified public keys/counters/proofs, and append security audit. The runtime
accepts branded results from real password/WebAuthn verification; HTTP booleans or
proof-shaped JSON are never verification authority. Password hashing, browser waits
and cryptography run outside database locks.

Claims bind user, credential version, exact session, security version, origin/RP,
purpose and response digest. A challenge is claimed once before verification and
cannot reopen after an invalid response, crash or failed final commit. Final writes
recheck current authority and counter revision. A separate monotonically increasing
counter revision covers authenticators that legitimately retain a zero sign counter.
Factor lifecycle changes invalidate proofs through the security version.

Use user → session → MFA state → challenge → factor → proof/code/grant lock ordering.
MFA mutation takes the user lock exclusively, ordering it with the existing shared
property-transaction fence. Recheck database time after waits. SQL policies must
preserve the existing atomic password-version transition while refusing subsequent
old-version sessions. The private executor must not create recursive identity policies
or grant runtime roles raw factor, recovery-code or credential writes.

## Proof required before rollout

Real signed software-authenticator tests exercise production cryptography. Database
and HTTP tests must additionally prove replay refusal, exact-session isolation,
recovery restrictions, counter races, revocation order, audit rollback and current
property admission. Client tests prove truthful state/receipt handling, not hardware
security. Actual browser ceremonies and native device/PIN/security-key verification
are separate acceptance evidence. No production MFA or full SOW security compliance
is claimed by this decision.

The E30 persistent demo remains running while this work is integrated. A future
preview/hosted activation must include a tested enrollment path, migration/restore
plan and origin configuration. Staff invitation execution and enterprise SSO remain
separate unfinished work; future SSO must link verified issuer+subject identities
without merging accounts by unverified email.

References: [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server),
[browser package](https://simplewebauthn.dev/docs/packages/browser),
[WebAuthn assertion verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion),
[OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).

## Current local acceptance

Actual Chromium `navigator.credentials.create/get` has completed setup, signed
activation, security-management verification, recovery-code creation/dismissal and
verification on a fresh sign-in against disposable PostgreSQL. `test/browser/mfa.mjs`
uses Chrome's native virtual CTAP2 authenticator through CDP, without replacing the
browser API. This exercises the bundled client, CSP, real HTTP and SQL; it does not
verify a physical fingerprint/PIN/security key or hosted origin. The test accepts an
installed Playwright module and Chrome executable through `ATRIUM_PLAYWRIGHT_MODULE`
and `ATRIUM_CHROME_EXECUTABLE`; it never uses the user's existing browser profile.
Optional `ATRIUM_BROWSER_ARTIFACTS` saves synthetic-page screenshots.

The local fixture importer uses finite operations on the fictional demo channel's
scoped, audited stores. It never creates a synthetic passkey for the staff account
or exempts interactive HTTP from verification. Saved import checkpoints remain
one-time and refuse uncertain replay. Existing persisted preview data is preserved.
