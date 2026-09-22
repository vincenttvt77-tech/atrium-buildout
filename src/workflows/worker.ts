import { WorkflowError } from './model.ts'
import { isDeepStrictEqual } from 'node:util'
import { canonicalJson, hashJson } from './validation.ts'
import type { ClaimDecision, DispatchResult, JsonObject, VerificationResult, WorkflowClaim,
  WorkflowConnector, WorkflowRepository, WorkflowSettlement } from './model.ts'

export interface WorkflowWorkerOptions {
  repository: WorkflowRepository
  /** Server-owned registry; no connector is enabled by this module. */
  connectors: ReadonlyMap<string, WorkflowConnector>
  workerId: string
  leaseMs?: number
  timeoutMs?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
  now?: () => Date
  random?: () => number
}

export type WorkflowWorkerResult =
  | { status: 'idle' }
  | { status: 'stale'; actionId: string }
  | { status: 'held'; actionId: string; code: string }
  | { status: 'settled'; actionId: string; state: WorkflowSettlement['state']; code?: string }

const boundedInteger = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max
const reason = (code: unknown, fallback: string): string => typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : fallback
const isJsonObject = (value: unknown): value is JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try { return Buffer.byteLength(canonicalJson(value), 'utf8') <= 16_384 } catch { return false }
}
const dispatchWasPersisted = (claim: WorkflowClaim) => claim.action.dispatchStarted && claim.action.phase === 'verify'

/**
 * Executes one durable claim. Repository calls finish their own transactions before
 * any connector IO starts. A provider acknowledgment never establishes success: only
 * matching read-back can do that, followed by the repository's final authority/fence
 * check. An unhandled repository error leaves the persisted phase for lease recovery.
 */
export async function runWorkflowOnce(options: WorkflowWorkerOptions): Promise<WorkflowWorkerResult> {
  const leaseMs = options.leaseMs ?? 30_000
  const timeoutMs = options.timeoutMs ?? 10_000
  const baseBackoffMs = options.baseBackoffMs ?? 1_000
  const maxBackoffMs = options.maxBackoffMs ?? 60_000
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.workerId)
    || !boundedInteger(leaseMs, 10, 300_000) || !boundedInteger(timeoutMs, 1, 300_000)
    || !boundedInteger(baseBackoffMs, 1, 3_600_000) || !boundedInteger(maxBackoffMs, baseBackoffMs, 3_600_000)) {
    throw new WorkflowError('invalid_worker_configuration', 'Worker limits are invalid.')
  }
  const now = options.now ?? (() => new Date())
  const random = options.random ?? Math.random
  const repository = options.repository
  const currentTime = () => {
    const value = now().getTime()
    if (!Number.isFinite(value)) throw new WorkflowError('invalid_worker_clock', 'Worker clock is invalid.')
    return value
  }
  // Validate the clock before taking a lease, so a bad injected clock does not strand work.
  currentTime()
  let claim = await repository.claim({ workerId: options.workerId, leaseMs })
  if (!claim) return { status: 'idle' }
  const actionId = claim.action.id
  const stale = (): WorkflowWorkerResult => ({ status: 'stale', actionId })
  const remaining = () => Date.parse(claim!.expiresAt) - currentTime()
  const verificationAttemptsInGeneration = () => claim!.action.verificationAttempts - claim!.action.verificationAttemptsAtReplay
  const backoff = () => {
    const attempt = Math.max(claim!.action.dispatchAttempts, verificationAttemptsInGeneration(), 1)
    const ceiling = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.min(attempt - 1, 30))
    const sampled = random()
    const jitter = Number.isFinite(sampled) ? Math.max(0, Math.min(1, sampled)) : 0.5
    // Equal jitter stays positive and below the configured maximum.
    return Math.max(1, Math.floor(ceiling * (0.5 + jitter * 0.5)))
  }
  const settle = async (result: WorkflowSettlement): Promise<WorkflowWorkerResult> => {
    if (!(remaining() > 0)) return stale()
    const committed = await repository.settle(claim!, result)
    // False includes an authority/configuration hold persisted instead of the requested
    // transition. Never report the requested success when the repository refused it.
    if (!committed) return stale()
    return { status: 'settled', actionId, state: result.state,
      ...('code' in result ? { code: result.code } : {}) }
  }
  const review = (code: string) => settle({ state: 'needs_review', code })
  const adopt = (decision: ClaimDecision): WorkflowWorkerResult | null => {
    if (decision.status === 'stale') return stale()
    if (decision.status === 'held') return { status: 'held', actionId, code: reason(decision.code, 'workflow_held') }
    // A repository must never change ownership, intent or lease identity mid-operation.
    if (decision.claim.token !== claim!.token || decision.claim.workerId !== claim!.workerId
      || decision.claim.action.id !== actionId || decision.claim.action.organizationId !== claim!.action.organizationId
      || decision.claim.action.propertyId !== claim!.action.propertyId
      || decision.claim.action.operationKey !== claim!.action.operationKey
      || decision.claim.action.inputSha256 !== claim!.action.inputSha256
      || decision.claim.action.configurationVersion !== claim!.action.configurationVersion
      || decision.claim.action.verificationAttemptsAtReplay !== claim!.action.verificationAttemptsAtReplay
      || decision.claim.action.connector !== claim!.action.connector || decision.claim.action.kind !== claim!.action.kind
      || decision.claim.action.receiptId !== claim!.action.receiptId
      || !isDeepStrictEqual(decision.claim.action.input, claim!.action.input)
      || !isDeepStrictEqual(decision.claim.action.origin, claim!.action.origin)
      || decision.claim.expiresAt !== claim!.expiresAt) {
      throw new WorkflowError('workflow_claim_changed', 'The repository returned a different workflow claim.')
    }
    claim = decision.claim
    return remaining() > 0 ? null : stale()
  }

  /** Bounds waiting even if abort is ignored; it cannot cancel an already-sent provider effect. */
  const network = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> => {
    const budget = Math.min(timeoutMs, Math.floor(remaining()))
    if (!(budget > 0)) return { ok: false, code: 'workflow_lease_expired' }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<{ ok: false; code: string }>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ ok: false, code: 'connector_timeout' }) }, budget)
    })
    const invoked = Promise.resolve().then(() => operation(controller.signal)).then(
      value => ({ ok: true as const, value }),
      () => ({ ok: false as const, code: 'connector_exception' }),
    )
    try { return await Promise.race([invoked, timedOut]) }
    finally { if (timer) clearTimeout(timer) }
  }

  if (!(remaining() > 0)) return stale()
  const connector = options.connectors.get(claim.action.connector)
  if (!connector || connector.id !== claim.action.connector) return review('connector_unavailable')
  if (!boundedInteger(claim.action.maxAttempts, 1, 10)
    || !boundedInteger(claim.action.dispatchAttempts, 0, 10)
    || !boundedInteger(claim.action.verificationAttempts, 0, Number.MAX_SAFE_INTEGER)
    || !boundedInteger(claim.action.verificationAttemptsAtReplay, 0, claim.action.verificationAttempts)) return review('invalid_workflow_attempts')
  try { if (hashJson(claim.action.input) !== claim.action.inputSha256) return review('workflow_input_digest_mismatch') }
  catch { return review('invalid_workflow_input') }

  const verify = async (dispatchResult?: DispatchResult): Promise<WorkflowWorkerResult> => {
    if (!(remaining() > 0)) return stale()
    if (verificationAttemptsInGeneration() >= claim!.action.maxAttempts) return review('verification_attempts_exhausted')
    if (claim!.action.verificationAttempts >= Number.MAX_SAFE_INTEGER) return review('verification_counter_exhausted')
    const decision = adopt(await repository.startVerification(claim!))
    if (decision) return decision
    const response = await network(signal => connector.verify(structuredClone(claim!.action), signal))
    if (!(remaining() > 0)) return stale()
    const result: VerificationResult = response.ok && response.value && typeof response.value === 'object'
      ? response.value : { status: 'unknown', code: response.ok ? 'invalid_verification_result' : response.code }
    switch (result.status) {
      case 'matched':
        if (result.operationKey !== claim!.action.operationKey || result.inputSha256 !== claim!.action.inputSha256) return review('verification_identity_mismatch')
        if (typeof result.providerReference !== 'string' || !result.providerReference.trim() || result.providerReference.trim() !== result.providerReference || result.providerReference.length > 256
          || /[\u0000-\u001f\u007f]/.test(result.providerReference) || !isJsonObject(result.evidence)) return review('invalid_verification_evidence')
        return settle({ state: 'succeeded', providerReference: result.providerReference, evidence: result.evidence })
      case 'mismatch':
        return review(reason(result.code, 'verification_mismatch'))
      case 'not_found': {
        if (result.authoritative !== true) break
        if (dispatchResult?.status === 'rejected' && !dispatchResult.retryable) return review(reason(dispatchResult.code, 'connector_rejected'))
        if (claim!.action.dispatchAttempts >= claim!.action.maxAttempts) return review('dispatch_attempts_exhausted')
        // A known no-effect rejection is safe even without provider idempotency.
        // After any ambiguous result only provider-enforced deduplication permits retry.
        if (dispatchResult?.status === 'rejected' && dispatchResult.retryable === true) {
          return settle({ state: 'retry_wait', code: reason(dispatchResult.code, 'connector_rejected'), delayMs: backoff(), retryEvidence: 'rejected_before_effect' })
        }
        if (connector.idempotentWrites === true) {
          return settle({ state: 'retry_wait', code: 'verified_absent', delayMs: backoff(), retryEvidence: 'authoritative_absence_idempotent' })
        }
        return review('non_idempotent_outcome_unresolved')
      }
      case 'unknown': break
      default: return review('invalid_verification_result')
    }
    if (verificationAttemptsInGeneration() >= claim!.action.maxAttempts) return review('verification_attempts_exhausted')
    if (claim!.action.verificationAttempts >= Number.MAX_SAFE_INTEGER) return review('verification_counter_exhausted')
    const code = result.status === 'unknown' ? reason(result.code, 'verification_unknown') : 'verification_not_authoritative'
    const reference = dispatchResult?.status === 'accepted' ? dispatchResult.providerReference : undefined
    return settle({ state: 'verifying', code, delayMs: backoff(),
      ...(typeof reference === 'string' && reference.length > 0 && reference.length <= 256 && !/[\u0000-\u001f\u007f]/.test(reference)
        ? { providerReference: reference } : {}) })
  }

  // The repository converts expired running claims that might have dispatched into
  // verify phase. A persisted safe retry may explicitly return to dispatch phase.
  if (claim.action.phase === 'verify') return verify()
  if (claim.action.phase !== 'dispatch') return review('invalid_workflow_phase')
  if (claim.action.dispatchAttempts >= claim.action.maxAttempts) return review('dispatch_attempts_exhausted')
  const decision = adopt(await repository.startDispatch(claim))
  if (decision) return decision
  if (!dispatchWasPersisted(claim!)) {
    throw new WorkflowError('dispatch_not_persisted', 'Dispatch intent was not durably marked before connector execution.')
  }
  const response = await network(signal => connector.dispatch(structuredClone(claim!.action), signal))
  let dispatchResult: DispatchResult = { status: 'unknown', code: response.ok ? 'invalid_dispatch_result' : response.code }
  if (response.ok && response.value && typeof response.value === 'object') {
    if (response.value.status === 'accepted' || response.value.status === 'unknown'
      || (response.value.status === 'rejected' && typeof response.value.retryable === 'boolean')) dispatchResult = response.value
  }
  // Even a rejected request is read back: a provider result must never outrank a
  // persisted external object or bypass the final repository authority/lease check.
  return verify(dispatchResult)
}
