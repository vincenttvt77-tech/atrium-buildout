# 0004 — Shared protection for interactive password sign-in

Status: implemented for the PostgreSQL runtime; production activation requires its
normal migration and release gates. This is one control toward SOW section 15.2,
not complete identity/MFA, account recovery or enterprise SSO acceptance.

## Why

The PostgreSQL dashboard previously delayed failed logins using a process-local
map. Requests spread across instances or made after a restart received independent
budgets. The password verifier also ran before that delay, consuming expensive
hashing work regardless of prior attempts.

Every interactive PostgreSQL password login now uses `DatabaseRuntime.signIn`.
It commits a shared reservation before looking up credentials or running scrypt.
Database unavailability, missing migration/permissions and malformed readback refuse
sign-in with 503. There is no fallback to memory or to legacy credentials.

## Policy

- Each normalized username receives 20 admitted attempts in a rolling 15-minute
  window across client networks and application instances. Known and unknown
  usernames follow the same reservation procedure without an identity lookup.
- Each client network receives 100 attempts in the same rolling window. A request
  refused by the username budget still consumes an available client attempt.
  An exhausted client budget does not allocate a new username record.
- All admitted attempts count, including successful sign-ins. Success does not
  clear counters or interfere with another in-flight attempt. Merely reading a
  page, authenticating an existing session or signing out consumes no attempt.
- Denied attempts do not extend the exhausted budget's window. A 429 response
  contains generic copy and a database-derived `Retry-After` value. It does not
  state whether an account exists, echo a password or issue a session cookie.
  The retry time assumes no additional activity; it is not a promised unlock.
- Database time owns the rolling window. Future reservations survive a backwards
  clock adjustment; retry timing is not artificially capped to 15 minutes.

These limits intentionally trade some sign-in availability for guessing resistance.
An attacker can temporarily restrict a known username by exhausting its budget.
Operators behind one NAT or unsupported reverse proxy also share a network budget.
Existing authenticated sessions continue to work. Recovery, MFA and perimeter
abuse controls are separate requirements; do not claim this eliminates distributed
credential stuffing or denial of service.

## Client address and storage

Only the deployment-owned `VERCEL=1` environment setting enables trust in Vercel's
`x-vercel-forwarded-for` header. Other deployments use the actual socket peer and
ignore forwarded headers. Missing, repeated, chained, zoned or malformed addresses
share an unknown-client budget. Custom ingress must have an explicitly implemented
and verified trust boundary; setting a request header does not establish one.

IPv4-mapped IPv6 addresses share the IPv4 budget. Other IPv6 addresses are grouped
by canonical /64, preventing textual aliases or host-address rotation within that
network from resetting the budget. Prefix choice does not identify a person.

The application HMACs each canonical username/network with domain separation and
the existing deployment session secret. PostgreSQL receives only 64-character
digests and times, never raw usernames, IP addresses, passwords or user existence.
The secret must be the same across instances of a deployment; rotating it also
starts fresh limiter keys. Do not rotate it as an ordinary way to clear limits.
No additional environment file or per-user deployment configuration is needed.

Timestamp queues are capped at 20 or 100 entries. Each reservation performs bounded
cleanup of expired inactive keys while skipping locked rows. This does not claim
constant total storage under an unbounded distributed attack; monitor load and
storage and retain perimeter controls. Digests remain pseudonymous security data,
with access confined to this control and authorized database maintenance.

## Database authority and concurrency

The private finite reservation function is owned by a dedicated NOLOGIN,
non-BYPASSRLS role with privileges only on the forced-RLS bucket table. It cannot
read or change identities, credentials, memberships or property records. The HTTP
authenticator role can execute the function but cannot read or write buckets;
the application role cannot execute it. Neither HTTP role may inherit its owner.

The command requires an empty pre-login authorization context, validates both
digest keys, serializes client then username reservations, and commits before the
password verifier runs. No network or hashing work is done under its locks.
Cleanup must not remove a row between establishing it and taking the reservation
lock. SQL privilege, race, expiry and rollback tests cover the actual database
boundary; HTTP tests cover failure responses and ordering through separate servers.

The lower-level password verifier remains useful for trusted provisioning/tests;
it is not an interactive sign-in endpoint. Future password-login endpoints must
call the protected runtime method or an equivalent authenticated identity provider.
Changing this invariant requires reviewing all public authentication entry points.

## Compatibility and follow-on work

The hosted legacy KV/shared-passcode adapter is unchanged by this PostgreSQL-only
control. Deploying the source does not activate PostgreSQL or migrate customer data.
Apply the immutable migration and provision the role through the deployment
workflow before activating this runtime. Never modify an already-applied migration.

Continue with unique revocable sessions, real session-bound MFA, verified invitation
acceptance/recovery and audited membership commands from ADR 0003. Perform hosted
ingress and load testing, define monitoring thresholds, and complete the full SOW
security control assessment rather than treating these test results as certification.

## References

- [Vercel request headers](https://vercel.com/docs/headers/request-headers): provider
  header behavior reviewed September 9, 2026; live ingress behavior still needs its
  deployment verification.
- [Supabase database functions](https://supabase.com/docs/guides/database/functions):
  fixed search paths and restricted execution for privileged functions.
