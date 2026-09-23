# Work queue query reliability

The queue must remain usable after a building accumulates calls and follow-ups.
The previous page query timed out under the normal ten-second statement limit
with 300 synthetic actions. An actual PostgreSQL plan showed nested joins reading
all property receipts and outbox rows repeatedly, invoking the property permission
function before rejecting unrelated join rows. This was reproduced locally with a
registered staff session and signed MFA, not a superuser read.

`PostgresWorkflowRepository.list` now uses correlated receipt/outbox lookups.
These preserve row security and make each join test the exact action relationship.
Mutation queries keep their ordinary table aliases and row locks. Page records
retain physical tuple identity, but omit those extra projection fields from the
record JSON used for revision hashing. A page, exact read and unchanged recovery
command therefore agree on the same revision.

The additive migration
`supabase/migrations/20260923200722_workflow_read_policies.sql` also changes only the
four workflow tables' `scoped_read` policies. Each policy requires both:

- Row organization/property equal the current transaction's selected scope.
- The existing `can_access_property` function grants read access to that scope.

The permission expression is an uncorrelated subquery, evaluated as an InitPlan
instead of per row. This function is already STABLE, so its statement-snapshot
semantics are retained. Nothing is cached across SQL statements, requests,
prepared-query executions or pooled sessions. Roles, grants, forced RLS, current
MFA/session checks, write policies, original-actor checks and transaction exit
checks remain intact. No SECURITY DEFINER helper or timeout increase is added.

The actual plan for a 3,000-action empty filter showed every permission InitPlan
executed once. The list still scans property history for some sparse state filters;
this is not a claim of constant-time queries or unlimited-history performance.
Normal table statistics and further indexed history work remain relevant at larger
volumes. No workload-level or hosted service latency guarantee is established.

## Evidence

Synthetic diagnostic samples on the local PostgreSQL17 fixture:

| Query | Previous behavior | Revised behavior |
| --- | --- | --- |
| First26 actions, 300-action property | Cancelled at10 seconds | About210ms with query change alone |
| Empty state filter, 3,000-action property | Cancelled at10 seconds, even after the query-only fix | About410ms with the policy migration |
| First26 actions, 3,000-action property | Not measured as a successful old query | About33ms with both changes |

These are individual diagnostic observations, not percentiles or phone latency.
The focused suite seeds3,600 actions across three properties, including two in one
organization. It verifies all3,000 primary-property records exactly once through
keyset pages, tied timestamps, sparse and empty filters, exact read/revision
agreement, reasoned recovery, stale revisions, raw RLS reads, foreign scope,
prepared/pool context changes and revoked authority. Migration tests compare row
digests, grants, forced-RLS flags and all non-read policies before/after applying
the exact SQL over populated tables.

Full application/native/browser/build evidence and initial failures are recorded
in the [implementation report](../reports/2026-09-23-work-queue-performance.md).
The Supabase CLI advisor was attempted against the isolated native fixture but
could not run because the platform `anon` role is absent. No platform roles or
grants were fabricated to produce a green result. Hosted advisors and representative
deployment/load checks remain separate acceptance work.

## Rollout

The migration was generated with the installed Supabase CLI and copied from
`db/workflow-read-policies.sql`, following this repository's migration contract.
It is additive and changes no stored records. The query-only improvement is
compatible with the old policies, but the larger-history filter evidence depends
on applying the new migration. Review/apply it in isolated Preview before a managed
production release. Existing legacy KV mode does not use this repository.

Do not edit previous migration files or assume a source push migrated a database.
Any reversal must be a separately reviewed forward migration; reverting only the
application query does not reverse the policy. Preserve a rollback plan and verify
the real configured runtime and authority after deployment.
