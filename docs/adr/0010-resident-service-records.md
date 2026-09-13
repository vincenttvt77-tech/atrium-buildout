# ADR 0010 — Staff resident records and maintenance intake

Status: accepted architecture decision; implementation and acceptance in progress.

## Context

The supplied SOW requires an organization-scoped person history, property-specific resident verification and maintenance from intake through verified resolution. Existing staff accounts identify operators; a Vapi binding identifies a building. Neither proves the identity of a resident on a call. Leasing lead contact records must not silently become residency or household authority.

The first resident-service increment provides maintained occupancy evidence and a real staff intake/triage/history workflow. The complete maintenance lifecycle, resident channel verification, external fulfillment and closure remain required subsequent work.

## Decision

Use normalized private PostgreSQL records. The organization person core contains an immutable identifier, ownership and creation time. Personal/contact observations and occupancy source evidence belong to a property residency relationship. Creating a relationship creates a new person identifier; this increment provides no automatic phone/email merge or caller-selected person linking. Future cross-property reconciliation requires explicit authorized evidence and a separately reviewed command.

Only current managed staff with property `operate` permission can read Service data. Generic viewer access and channel principals cannot read resident contacts or case history. Property managers with `configure` permission can add, review and revoke residency evidence. A configured role does not bypass account/session/MFA checks. The app role can call finite commands but cannot write service tables directly or inherit their executor.

Source review is an explicit human action: source reference/version, original observation instant, validity deadline, reviewer and review time are recorded. Occupancy start/end dates use the property's time zone, with an exclusive end date. Source evidence has a maximum 90-day validity interval in this initial manual-review adapter; this is a conservative implementation bound, not a statement of legal lease duration. A real property-configurable verification policy and approved PMS adapter remain separate requirements. No source timestamp is advanced by fetching or retrying a request.

Readiness is derived from current database time, active status, occupancy dates and source validity. Revoked, ended, future or expired records remain useful staff history but cannot make a unit request ready for planning. Reviewing occupancy does not verify an incoming caller, authorize entry, establish household delegation or approve spending.

A saved planning decision is historical triage, not a continuing authorization. Reads derive `contextNeedsReview` when a resident-reported unit case loses current occupancy context after triage or any unit case refers to a unit removed from current published inventory. Removed-unit checks include staff observations. Attention filtering includes these conditions before pagination; the screen labels the stored decision “Triaged for planning” and separately shows the current context warning. These changes do not rewrite the case version or event history. Explicit staff observations and common-area work retain their separate occupancy rules.

Staff may record a maintenance report before identity or exact location is known. Intake retains the reporter's name/contact as claims, the location, summary, description, category, reported priority, optional staff-selected residency and access notes. The notes are reported instructions, not entry permission. A linked relationship must belong to this property and the selected unit. The original resident version and name at intake remain in history even if the current record changes.

An explicit `update_context` command lets staff clarify a request's current location and resident link on the same case. It requires the current case version and a review note, validates the selected unit and residency within this property, and records a context event with the observed resident version/name. Original intake location, resident link/version/name and request origin remain immutable. Changed ordinary context returns the case to triage; it cannot carry an earlier planning decision forward. Existing or newly detected emergencies remain held. No caller, entry or spending authority is created by this correction.

The initial business states are `needs_triage`, `waiting_information`, `management_review`, `ready_for_planning` and `emergency_review`. Planning readiness is not a vendor selection, financial authorization or dispatch. Resident-reported or unknown-origin unit planning requires current occupancy context. Explicit staff observations may proceed to planning for known units without inventing a resident, supporting vacant-unit work; common-area planning also does not require a resident. Origin is an immutable staff-recorded claim with actor attribution, and never grants entry or dispatch authority. Unknown location needs clarification. Automatic emergency detection runs on intake and later notes, triage and context-correction notes, using the existing safety detector. Emergency state is retained; ordinary triage cannot downgrade it. The UI provides an immediate warning before saving, and saved detail supplies existing approved safety guidance. Saving does not contact responders; acknowledgment, backup contact and confirmed delivery are separate work.

Every mutation has an immutable organization/property/actor/request receipt, a complete canonical command and an expected resource version where applicable. Identical retries return the original receipt after current authorization; changed manifests conflict. State, source evidence and events commit atomically. Scope ownership cannot be reassigned. No provider calls occur inside these transactions.

One `/api/resident-services` handler supplies overview, resident/case lists, detail, event pagination and commands. Lists and histories use bounded keyset pagination. Case summaries exclude reporter contacts, access notes and full history. Forms bind the current user, exact session, credential version, organization, property, configuration and permission snapshot; mutations also require exact configured origin and an action header. Read and write responses recheck current staff access before release. All responses prohibit shared caching and indexing.

Detail reads recheck the case version, joined resident version and current review flag before returning. Concurrent case/source changes refuse the mixed response with a reload-required conflict, preventing earlier location/state from being paired with later events. This read guard does not widen database privileges or grant operational authority.

## Verification required before release

Native PostgreSQL checks must prove cross-organization/property denial, viewer/channel/sessionless denial, current unit ownership, source/date validity, revocation, exact retries, aggregate version conflicts, immutable history, atomic rollback, and lock-order/session/configuration races. The upgrade must preserve the verified eight- and nine-migration baselines without changing credentials or repairing unsafe ACLs. SQL and the additive migration must match; historical migrations remain unchanged.

HTTP and actual browser checks must prove normal staff intake, manager source review, missing/stale context, emergency interruption, reviewed saves, lost responses, version conflicts, keyboard/scroll behavior and mobile layouts. Synthetic WebAuthn and database tests do not establish physical-device or live resident verification. No deployment, notification, phone, PMS or full-SOW acceptance is implied by this decision.

## Remaining lifecycle

Implement configured resident-channel verification and household/lease context, approvals tied to the exact plan/vendor/cost, approved vendor selection, durable dispatch, provider readback, resident updates, resolution evidence, supported resident confirmation and verified external closure/reopening. Complete emergency acknowledgment and backup routing, messaging parity, import reconciliation and outcome intelligence. The customer's PMS remains the external system of record when integrated. A saved ticket or queued action does not complete this lifecycle.
