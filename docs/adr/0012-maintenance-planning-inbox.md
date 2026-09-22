# ADR 0012 — Property maintenance planning inbox

Status: Accepted for the managed-runtime implementation.

## Context

A manager must find requests whose policy, vendor, resident context or recorded
approver no longer permits the proposed work. Opening every case individually is
not a practical queue. Historical triage alone cannot express current readiness.

The inbox must remain useful for large properties without exposing unnecessary
resident details, copying financial policy into a second evaluator, or silently
dropping matches beyond a fixed query cap. It does not authorize outside work.

## Decision

Service has a Work plans tab with Action needed, Waiting and All filters. Rows
include the case identity/version, summary/location, recorded dates, plan version,
nullable cost ceiling, current assessment, responsible party and next step. They
exclude reporter contacts, access notes, resident names and full plan/decision
prose. Selection loads current case and plan detail before any existing action.

`GET /api/maintenance-plans?resource=inbox` uses the registered session and current
property operate permission. The repository obtains a bounded graph of at most
201 candidate cases: 200 candidates plus lookahead. Common property, inventory,
policy and requester authority are materialized once per statement. Historical
approval authority is read once per distinct approver using the existing finite,
scoped decision reader. No case-history or single-case repository loop is used.

A second bounded read verifies the fetched graph, including nonmatching cases,
before the shared domain evaluator admits rows to the result page. Changes to
the graph refuse the read. Current database time determines readiness. Emergency
holds remain visible after withdrawal; unknown costs remain unknown. Operational
context review takes precedence over asking someone to prepare a financial plan.

## Progressive live navigation

Each response returns at most 50 matches (the portal requests 25). The continuation
advances only through consumed cases in immutable creation-time/ID order,
including consumed nonmatches. Unconsumed lookahead or later candidates are not
skipped. If the bounded scan fills before the result page, `scanIncomplete` and a
continuation remain present, even when no matches were returned. The portal offers
Continue checking instead of claiming the queue is empty. There is no global count.

HTTP continuations are signed and bind the user, credential version, exact session,
organization/property, configuration/permission versions, filter, unit, page size,
policy version and original scan lifetime. They expire within five minutes and
cannot be extended by requesting another page. A policy change requires Refresh.
Evidence boundaries—including policy/vendor/source expiry and resident start/end
dates in the property time zone—and session expiry can shorten the deadline. The
handler checks it again after final access revalidation. The portal retires expired
rows and detail while preserving an unresolved-save warning.

This is a live scan, not a frozen or complete-current snapshot across pages.
Earlier cases may change after they were checked; rows describe their evaluation
time. Refresh restarts from the top to catch those changes. A continuation is
navigation, never decision authority. A future push channel or complete snapshot
requires an explicit mutation epoch across every dependency; a timestamp alone
cannot establish that contract.

## Operational boundaries and acceptance

Waiting includes financially authorized plans that still lack verified resident
permission, vendor availability or a real appointment. It does not mean done.
Available approval actions reuse the current exact-plan, role, independence,
passkey and version checks. The inbox neither assigns a worker nor contacts a
vendor, verifies entry, acknowledges an emergency or completes maintenance.

Verify sparse scans beyond the candidate boundary, equal creation timestamps,
no skipped unconsumed rows, source expiry, policy/vendor/approver changes,
cross-property and session refusal, concurrent graph changes and response-fence
expiry. Exercise real browser mobile/keyboard approval, rejection and revision,
selection/scroll, expired rows, lost responses and late property results.

This change needs no new database migration beyond the maintenance authority
schema in ADR 0011. Hosted schema application and runtime activation are separate
release gates. Continue verified resident/channel authority, emergency delivery
and acknowledgment, provider commitment/readback, updates and verified closure.
