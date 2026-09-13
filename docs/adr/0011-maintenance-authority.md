# ADR 0011 — Maintenance authority and reviewed work plans

Status: accepted architecture decision; implementation and release acceptance in progress.

## Context

The supplied scope requires maintenance to reach verified resolution. A recorded
request, financial approval and vendor appointment are distinct steps. Staff must
be able to prepare precise work, understand who may approve it and retain the
reason for each decision without allowing an outdated approval to authorize a
different job.

This increment adds property authority rules, an approved vendor directory and
versioned work plans to the existing Service workspace. It does not enable an
external dispatcher or establish resident identity, entry permission or closure.

## Decision

Keep policy, vendors, plans, decisions, events and receipts in normalized,
organization/property-scoped PostgreSQL records with forced row security.
Historical versions and decisions are immutable. Managed staff with current
`operate` authority may prepare or withdraw plans. An owner with `configure`
authority and fresh, exact-session organization-administration WebAuthn publishes
financial policy. An authorized administrator cannot raise their own delegated
limit. Vendor review and human decisions require current configure authority and
the same fresh verification. These are staff actions, not resident consent.

Policy sets per-job all-in USD ceilings in integer cents, including taxes, callout,
materials and contingency. Automatic and manager ceilings may be disabled; the
owner ceiling is explicit. Unknown cost is null, never zero. Unknown or partial
quotes, restricted work, excluded categories and costs above the owner ceiling
require management review. A per-job ceiling is not an aggregate property budget.

Four paths are represented: automatic authority, manager/owner approval,
management escalation and emergency protocol. Automatic authority additionally
requires routine priority, an eligible category and no unstructured vendor
restriction. Resident approval and independent-approver requirements are explicit
owner policy. Unit entry still requires separately verified authority even when
the policy does not otherwise require resident approval.

Every plan binds case, configuration, resident/source, policy and vendor versions,
the exact scope, route, currency, all-in ceiling and entry requirement. Preparation
or withdrawal creates a new version. One immutable human decision is permitted
per version; changing a rejection requires a new proposal. Reads derive current
readiness rather than copying a stored approval flag. Changed context or a revoked
or insufficient approver makes the plan stale and explicitly requires revision
and new approval. Current standing automatic policy does not depend on an optional
former human approver.

The finite `atrium_maintenance_approval_reader` role accepts only an existing
decision identifier in the unchanged requesting organization/property context.
It exposes the decision actor's current qualifying role and authority, not a
general account directory. It does not impersonate the approver or change actor
session variables. The role is NOLOGIN/NOBYPASSRLS, cannot be inherited by the app
or authenticator, has a fixed search path, and grants no public execution.

Vendor records capture reviewed trades, property coverage, contact details,
reported availability, preference, pricing notes and restrictions. Approval is not
a booking. Source validity is bounded to 90 days; reported availability to 14 days.
Owner policy evidence is bounded to 365 days. Reads and commands use current
database time. These initial bounds are implementation policy, not external
guarantees. Suspending a vendor must not require inventing fresh evidence; restored
approval requires a current reviewed source.

Emergency evidence outranks ordinary approval, including evidence first disclosed
while preparing or deciding a plan. An attempted approval that reveals a hazard
records a new plan version and safety-hold event with an `emergency_held` receipt;
it records no approval. Earlier hazards survive rejection, revision and
withdrawal. The UI shows immediate instructions and accurately distinguishes a
saved safety concern from an approved job. Saving does not contact responders.

The dedicated HTTP endpoint requires the exact configured origin, a separately
bound planning form, action header and current user/session/property/configuration
authority. Finite SQL commands repeat authority and version checks under their
transaction locks. State, history and canonical-command receipts commit together.
Exact retries preserve the original result; conflicting commands cannot reuse a
receipt. Lost responses preserve a deliberate exact retry. Session loss clears
private views while retaining the unknown-save warning until the user navigates
to sign in. A fresh-MFA refusal never triggers an automatic mutation retry.

## Execution and queue boundary

`spendingAuthorized` can be true while resident approval, entry permission or
vendor availability remains unmet. Every result still says `not_dispatched` and
`not_sent`. No generic workflow worker is enabled for these plans. A future
adapter must revalidate the exact domain authority before an external commitment
and reconcile its actual result; the existing generic worker's actor/configuration
check alone is insufficient.

The subsequent [property planning inbox](0012-maintenance-planning-inbox.md)
provides current attention and achievable next steps with bounded progressive
navigation. The original Service request filter still covers triage and location
context; Work plans evaluates policy, vendor and approver changes. Its live pages
are not a frozen snapshot and require Refresh to catch changes to earlier rows.

## Acceptance and remaining lifecycle

Before release, verify real PostgreSQL ownership/privileges, fresh-proof checks,
concurrency, source expiry after lock waits, exact retries, stale versions,
revoked approvers, immutable decisions and sticky safety holds. Preserve the
eight-, nine- and ten-migration hosted upgrade baselines and existing credentials.
The additive migration must match its reviewed SQL source.

Exercise real HTTP and browser policy/vendor/plan decisions, mobile and keyboard
review, conflict recovery and ambiguous saves. Synthetic WebAuthn does not prove
physical-device acceptance. Passing local fixtures does not establish a live
PMS, telephone, provider, resident or production account connection.

Next complete verified resident/channel/household
authority, approved dispatch and messaging adapters, appointment readback,
emergency acknowledgment and backup routing, updates, resolution evidence and
verified closure/reopening. The connected PMS remains the external system of
record. Intelligence must use verified outcomes rather than treating a queued
action as completed work.
