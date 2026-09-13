import { ConsentError } from './consent-model.ts'
import type { ConsentDecision, ConsentEffectiveness, ConsentHold, ConsentRequest } from './consent-model.ts'
import { parseConsentEntryWindow } from './consent-validation.ts'
import { recordId } from './validation.ts'

export interface ConsentEvaluationInput {
  required: boolean
  request: ConsentRequest | null
  /** Current graph checks are supplied by the repository, never by browser input. */
  holds: ConsentHold[]
  recipients: Array<{ userId: string; decision: ConsentDecision | null; holds: ConsentHold[] }>
  /** Only relevant durable authority boundaries, not an old login/proof deadline. */
  deadlines: string[]
}

const positiveVersion = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const nonempty = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0
function requestEvidence(value: ConsentRequest): boolean {
  if (![value.id, value.organizationId, value.propertyId, value.caseId, value.planId, value.rosterId, value.publishedBy].every(recordId)
    || ![value.version, value.caseVersion, value.planVersion, value.configurationVersion, value.maintenancePolicyVersion,
      value.consentPolicyVersion, value.rosterVersion].every(positiveVersion)
    || !digest(value.materialDigest) || !digest(value.termsDigest)) return false
  const terms = value.terms
  if (!terms || terms.schemaVersion !== 1 || !['work', 'entry'].includes(value.purpose) || terms.purpose !== value.purpose
    || terms.funding !== 'property_no_resident_charge' || terms.currency !== 'USD' || terms.residentChargeCents !== 0
    || !Number.isSafeInteger(terms.propertyMaximumCents) || terms.propertyMaximumCents < 0
    || !recordId(terms.unitId) || ![terms.propertyName, terms.publicSummary, terms.scopeOfWork, terms.noChargeStatement].every(nonempty)
    || !['no_unit_entry', 'unit_entry'].includes(terms.accessRequirement)) return false
  const party = terms.party
  return !!party && nonempty(party.name) && (party.kind === 'internal'
    || party.kind === 'vendor' && recordId(party.id) && positiveVersion(party.version))
}

function decisionEvidence(value: ConsentDecision): boolean {
  return [value.id, value.requestId, value.actorUserId].every(recordId)
    && [value.version, value.requestVersion].every(positiveVersion) && digest(value.termsDigest)
}

/** Read projection only. It does not create consent or authorize a provider effect. */
export function evaluateConsent(input: ConsentEvaluationInput, now = new Date()): ConsentEffectiveness {
  const clock = now.getTime()
  if (!Number.isFinite(clock) || typeof input.required !== 'boolean') throw new ConsentError('consent_unavailable')
  const holds = new Set<ConsentHold>(), future: number[] = []
  const boundary = (value: string, expired: ConsentHold, invalid: ConsentHold = expired) => {
    const time = Date.parse(value)
    if (!Number.isFinite(time)) { holds.add(invalid); return null }
    if (time <= clock) holds.add(expired)
    else future.push(time)
    return time
  }
  const result = (): ConsentEffectiveness => ({
    required: input.required,
    effective: input.required && holds.size === 0,
    holds: [...holds],
    evaluatedAt: now.toISOString(),
    refreshAt: future.length ? new Date(Math.min(...future)).toISOString() : null,
    dispatchStatus: 'not_dispatched',
    notificationStatus: 'not_sent',
  })

  for (const value of input.deadlines) boundary(value, 'context_changed')
  if (!input.required) {
    // No irrelevant roster, request or signer is needed for a purpose the current policy does not require.
    holds.add('not_required')
    return result()
  }
  for (const hold of input.holds) holds.add(hold === 'not_required' ? 'context_changed' : hold)
  const request = input.request
  if (!request) holds.add('awaiting_decisions')
  if (!input.recipients.length) holds.add('missing_required_recipient')
  if (request && !requestEvidence(request)) { holds.add('terms_changed'); return result() }

  let responseAt: number | null = null
  if (request) {
    if (request.withdrawnAt !== null) holds.add('request_withdrawn')
    const validUntil = boundary(request.consentValidUntil, 'consent_expired', 'terms_changed')
    responseAt = Date.parse(request.responseDeadline)
    const publishedAt = Date.parse(request.publishedAt)
    if (!Number.isFinite(responseAt) || !Number.isFinite(publishedAt)
      || (validUntil !== null && responseAt > validUntil) || responseAt <= publishedAt || publishedAt > clock) {
      holds.add('terms_changed')
    } else if (responseAt > clock) future.push(responseAt)
    if (!['work', 'entry'].includes(request.purpose) || request.terms.purpose !== request.purpose) holds.add('terms_changed')
    if (request.purpose === 'entry') {
      if (!request.terms.entryWindow) holds.add('missing_entry_window')
      else {
        const window = request.terms.entryWindow
        const endsAt = boundary(window.endsAt, 'entry_expired', 'terms_changed'), startsAt = Date.parse(window.startsAt)
        try { parseConsentEntryWindow(window) } catch { holds.add('terms_changed') }
        if (!Number.isFinite(startsAt) || (endsAt !== null && startsAt >= endsAt)
          || (responseAt !== null && responseAt > startsAt)
          || (validUntil !== null && endsAt !== null && validUntil < endsAt)) holds.add('terms_changed')
      }
      if (request.terms.accessRequirement !== 'unit_entry') holds.add('terms_changed')
    } else if (request.terms.entryWindow !== null) holds.add('terms_changed')
  }

  let incomplete = !input.recipients.length
  const actors = new Set<string>()
  for (const recipient of input.recipients) {
    if (!recordId(recipient.userId) || actors.has(recipient.userId)) {
      holds.add('missing_required_recipient'); incomplete = true
    }
    actors.add(recipient.userId)
    for (const hold of recipient.holds) holds.add(hold === 'not_required' ? 'context_changed' : hold)
    const decision = recipient.decision
    if (!request || !decision) { holds.add('awaiting_decisions'); incomplete = true; continue }
    if (!decisionEvidence(decision) || decision.actorUserId !== recipient.userId
      || decision.requestId !== request.id || decision.requestVersion !== request.version
      || decision.purpose !== request.purpose || decision.termsDigest !== request.termsDigest) {
      holds.add('terms_changed'); incomplete = true; continue
    }
    if (decision.decision === 'decline') { holds.add('declined'); incomplete = true }
    else if (decision.decision === 'revoke') { holds.add('revoked'); incomplete = true }
    else if (decision.decision === 'grant') {
      const decidedAt = Date.parse(decision.decidedAt)
      if (decision.grantId !== decision.id || !Number.isFinite(decidedAt) || decidedAt > clock || decidedAt < Date.parse(request.publishedAt)
        || responseAt === null || !Number.isFinite(responseAt) || decidedAt >= responseAt) {
        holds.add('terms_changed'); incomplete = true
      }
    } else { holds.add('terms_changed'); incomplete = true }
  }
  // The deadline closes new decisions; a completed grant remains effective until its own evidence expires.
  if (incomplete && responseAt !== null && Number.isFinite(responseAt) && responseAt <= clock) holds.add('response_expired')
  return result()
}
