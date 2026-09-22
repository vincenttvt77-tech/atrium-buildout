import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflowOnce } from '../worker.ts'
import { hashJson } from '../validation.ts'
import type { WorkflowWorkerOptions } from '../worker.ts'
import type { ClaimDecision, DispatchResult, VerificationResult, WorkflowAction, WorkflowClaim,
  WorkflowConnector, WorkflowReceiptInput, WorkflowReceiptResult, WorkflowRepository, WorkflowSettlement } from '../model.ts'

const copy = <T>(value: T): T => structuredClone(value)
const initial: WorkflowAction = {
  id: 'action-1', receiptId: 'receipt-1', organizationId: 'org-a', propertyId: 'property-a', configurationVersion: 1,
  requestId: 'request-1', origin: { kind: 'user', userId: 'user-a', credentialVersion: 1 }, kind: 'synthetic_reservation',
  connector: 'synthetic', operationKey: 'org-a:property-a:reservation-1', input: { residence: '33A', time: '2026-09-16T20:00:00Z' },
  inputSha256: hashJson({ residence: '33A', time: '2026-09-16T20:00:00Z' }), state: 'queued', phase: 'dispatch', dispatchAttempts: 0, verificationAttempts: 0, verificationAttemptsAtReplay: 0, maxAttempts: 3,
  availableAt: '2026-09-09T00:00:00.000Z', createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
  completedAt: null, lastErrorCode: null, dispatchStarted: false, providerReference: null, evidence: null,
}

/** Transactional fake enforces the repository port; real PostgreSQL fencing is tested separately. */
class Repository implements WorkflowRepository {
  action: WorkflowAction
  time = Date.parse('2026-09-09T00:00:00.000Z')
  lease: WorkflowClaim | null = null
  sequence = 0
  inTransaction = false
  revoked = false
  configurationChanged = false
  events: string[] = []
  settlements: WorkflowSettlement[] = []
  afterClaim: (() => void) | undefined
  afterDispatchPersisted: (() => void) | undefined
  beforeVerification: (() => void) | undefined
  constructor(patch: Partial<WorkflowAction> = {}) { this.action = { ...copy(initial), ...patch } }
  now = () => new Date(this.time)
  advance(ms: number) { this.time += ms }
  tx<T>(name: string, work: () => T): T {
    assert.equal(this.inTransaction, false)
    this.inTransaction = true; this.events.push(name)
    try { return work() } finally { this.inTransaction = false }
  }
  ready(): ClaimDecision { return { status: 'ready', claim: { ...copy(this.lease!), action: copy(this.action) } } }
  guard(claim: WorkflowClaim): ClaimDecision | null {
    if (!this.lease || this.lease.token !== claim.token || this.time >= Date.parse(this.lease.expiresAt)) return { status: 'stale' }
    if (this.revoked || this.configurationChanged) {
      const code = this.revoked ? 'authority_revoked' : 'configuration_changed'
      this.action.state = 'needs_review'; this.action.lastErrorCode = code; this.lease = null
      return { status: 'held', code }
    }
    return null
  }
  async accept(_input: WorkflowReceiptInput): Promise<WorkflowReceiptResult> { throw new Error('Not used by worker') }
  async get(id: string) { return id === this.action.id ? copy(this.action) : null }
  async list() { return [copy(this.action)] }
  async replay(id: string, _reason: string): Promise<WorkflowAction> {
    // Simulate an already configure-authorized explicit repository operation. The worker
    // never calls this method; actual role enforcement belongs to PostgreSQL tests.
    assert.equal(id, this.action.id)
    return this.tx('operator_replay', () => {
      this.action.verificationAttemptsAtReplay = this.action.verificationAttempts
      this.action.state = 'queued'; this.action.phase = this.action.dispatchStarted ? 'verify' : 'dispatch'
      this.action.availableAt = this.now().toISOString(); this.lease = null
      return copy(this.action)
    })
  }
  async cancel(_id: string, _reason: string): Promise<WorkflowAction> { throw new Error('Not used by worker') }
  async claim(options: { workerId: string; leaseMs: number }): Promise<WorkflowClaim | null> {
    return this.tx('claim', () => {
      if (['succeeded', 'needs_review', 'cancelled'].includes(this.action.state) || Date.parse(this.action.availableAt) > this.time) return null
      if (this.lease && this.time < Date.parse(this.lease.expiresAt)) return null
      if (this.action.state === 'running' && this.action.dispatchStarted) this.action.phase = 'verify'
      this.action.state = 'running'
      this.lease = { token: 'lease-' + ++this.sequence, workerId: options.workerId, action: copy(this.action),
        acquiredAt: this.now().toISOString(), expiresAt: new Date(this.time + options.leaseMs).toISOString() }
      const result = copy(this.lease); this.afterClaim?.(); return result
    })
  }
  async startDispatch(claim: WorkflowClaim): Promise<ClaimDecision> {
    return this.tx('dispatch_started', () => {
      const stopped = this.guard(claim); if (stopped) return stopped
      assert.ok(this.action.dispatchAttempts < this.action.maxAttempts)
      this.action.dispatchStarted = true; this.action.phase = 'verify'; this.action.dispatchAttempts++
      this.afterDispatchPersisted?.()
      return this.ready()
    })
  }
  async startVerification(claim: WorkflowClaim): Promise<ClaimDecision> {
    return this.tx('verification_started', () => {
      const stopped = this.guard(claim); if (stopped) return stopped
      this.beforeVerification?.()
      assert.ok(this.action.verificationAttempts - this.action.verificationAttemptsAtReplay < this.action.maxAttempts)
      this.action.verificationAttempts++; return this.ready()
    })
  }
  async settle(claim: WorkflowClaim, result: WorkflowSettlement): Promise<boolean> {
    return this.tx('settle:' + result.state, () => {
      if (this.guard(claim)) return false
      this.settlements.push(copy(result)); this.action.state = result.state
      this.action.updatedAt = this.now().toISOString()
      if ('code' in result) this.action.lastErrorCode = result.code
      if ('delayMs' in result) this.action.availableAt = new Date(this.time + result.delayMs).toISOString()
      if (result.state === 'retry_wait') {
        assert.ok(['rejected_before_effect', 'authoritative_absence_idempotent'].includes(result.retryEvidence))
        this.action.phase = 'dispatch'
      }
      if (result.state === 'verifying') this.action.phase = 'verify'
      if ('providerReference' in result && result.providerReference) this.action.providerReference = result.providerReference
      if (result.state === 'succeeded') { this.action.evidence = copy(result.evidence); this.action.completedAt = this.now().toISOString() }
      this.lease = null; return true
    })
  }
  stealLease() {
    this.lease = { ...copy(this.lease!), token: 'lease-' + ++this.sequence, workerId: 'worker-new', expiresAt: new Date(this.time + 1000).toISOString() }
  }
}

function setup(patch: Partial<WorkflowAction> = {}) {
  const repository = new Repository(patch)
  const effects = new Map<string, string>()
  const calls = { dispatch: 0, verify: 0 }
  const matched = (action: WorkflowAction): VerificationResult => ({ status: 'matched', operationKey: action.operationKey,
    inputSha256: action.inputSha256, providerReference: 'synthetic-result', evidence: { observed: true } })
  const connector: WorkflowConnector = {
    id: 'synthetic', idempotentWrites: false,
    async dispatch(action) {
      assert.equal(repository.inTransaction, false, 'Dispatch IO must be after transaction commit')
      assert.equal(repository.action.dispatchStarted, true, 'Durable intent must precede network')
      assert.equal(repository.action.phase, 'verify')
      calls.dispatch++; repository.events.push('provider:dispatch'); effects.set(action.operationKey, action.inputSha256)
      return { status: 'accepted', providerReference: 'synthetic-result' }
    },
    async verify(action) {
      assert.equal(repository.inTransaction, false, 'Read-back IO must be outside transaction')
      calls.verify++; repository.events.push('provider:verify')
      const value = effects.get(action.operationKey)
      return value === action.inputSha256 ? matched(action) : value ? { status: 'mismatch', code: 'provider_payload_mismatch' }
        : { status: 'not_found', authoritative: true }
    },
  }
  const options: WorkflowWorkerOptions = { repository, connectors: new Map([[connector.id, connector]]), workerId: 'worker-test',
    now: repository.now, random: () => 1, baseBackoffMs: 10, maxBackoffMs: 100, leaseMs: 1000, timeoutMs: 100 }
  return { repository, connector, calls, effects, options, matched, run: () => runWorkflowOnce(options) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('persists dispatch before external IO, rechecks before readback and settles only verified success', async () => {
  const s = setup(); const result = await s.run()
  assert.deepEqual(result, { status: 'settled', actionId: 'action-1', state: 'succeeded' })
  assert.deepEqual(s.repository.events, ['claim', 'dispatch_started', 'provider:dispatch', 'verification_started', 'provider:verify', 'settle:succeeded'])
  assert.deepEqual(s.calls, { dispatch: 1, verify: 1 })
  assert.equal(s.repository.action.dispatchAttempts, 1); assert.equal(s.repository.action.verificationAttempts, 1)
  assert.equal(s.repository.action.providerReference, 'synthetic-result')
})

test('an idle queue does no connector work; unknown connector becomes visible needs_review', async () => {
  const idle = setup({ state: 'succeeded' }); assert.deepEqual(await idle.run(), { status: 'idle' }); assert.deepEqual(idle.calls, { dispatch: 0, verify: 0 })
  const absent = setup({ connector: 'disabled-provider' }); assert.equal((await absent.run()).status, 'settled')
  assert.equal(absent.repository.action.state, 'needs_review'); assert.equal(absent.repository.action.lastErrorCode, 'connector_unavailable')
  assert.deepEqual(absent.calls, { dispatch: 0, verify: 0 })
})

test('process failure after durable dispatch mark recovers by lookup without non-idempotent resend', async () => {
  const s = setup(); s.repository.afterDispatchPersisted = () => { throw new Error('process stopped after commit') }
  await assert.rejects(s.run(), /process stopped/)
  assert.equal(s.repository.action.dispatchStarted, true); assert.equal(s.calls.dispatch, 0)
  s.repository.afterDispatchPersisted = undefined; s.repository.advance(1001)
  await s.run()
  assert.equal(s.calls.dispatch, 0); assert.equal(s.calls.verify, 1)
  assert.equal(s.repository.action.state, 'needs_review'); assert.equal(s.repository.action.lastErrorCode, 'non_idempotent_outcome_unresolved')
})

test('process failure after provider success recovers by stable-key readback without another create', async () => {
  const s = setup(); s.repository.beforeVerification = () => { throw new Error('process stopped before readback') }
  await assert.rejects(s.run(), /process stopped/)
  assert.equal(s.effects.size, 1); assert.equal(s.calls.dispatch, 1)
  s.repository.beforeVerification = undefined; s.repository.advance(1001)
  await s.run()
  assert.equal(s.repository.action.state, 'succeeded'); assert.deepEqual(s.calls, { dispatch: 1, verify: 1 })
})

test('unknown dispatch with completed external effect succeeds only after matching readback', async () => {
  const s = setup(); const dispatch = s.connector.dispatch
  s.connector.dispatch = async (a, signal) => { await dispatch(a, signal); throw new Error('secret provider response must never reach logs') }
  await s.run()
  assert.equal(s.repository.action.state, 'succeeded'); assert.equal(s.calls.verify, 1)
  assert.equal(JSON.stringify(s.repository.settlements).includes('secret provider'), false)
})

test('unknown result with authoritative absence never blindly resends a non-idempotent create', async () => {
  const s = setup(); s.connector.dispatch = async () => { s.calls.dispatch++; return { status: 'unknown', code: 'lost_acknowledgement' } }
  await s.run(); s.repository.advance(5000); await s.run()
  assert.equal(s.calls.dispatch, 1); assert.equal(s.repository.action.state, 'needs_review')
  assert.equal(s.repository.action.lastErrorCode, 'non_idempotent_outcome_unresolved')
})

test('authoritative absence allows a bounded provider-idempotent retry with the original operation key', async () => {
  const s = setup(); s.connector.idempotentWrites = true; const dispatch = s.connector.dispatch; const keys: string[] = []
  let first = true
  s.connector.dispatch = async (a, signal) => { keys.push(a.operationKey); if (first) { first = false; return { status: 'unknown', code: 'lost_connection' } } return dispatch(a, signal) }
  await s.run()
  assert.deepEqual(s.repository.settlements[0], { state: 'retry_wait', code: 'verified_absent', delayMs: 10, retryEvidence: 'authoritative_absence_idempotent' })
  assert.equal(s.repository.action.dispatchStarted, true)
  s.repository.advance(10); await s.run()
  assert.deepEqual(keys, [initial.operationKey, initial.operationKey]); assert.equal(s.effects.size, 1)
  assert.equal(s.repository.action.state, 'succeeded')
})

test('explicit before-effect rejection has safe retry evidence; permanent rejection still gets readback', async () => {
  for (const retryable of [true, false]) {
    const s = setup(); s.connector.dispatch = async () => ({ status: 'rejected', retryable, code: 'provider_busy' })
    await s.run(); assert.equal(s.calls.verify, 1)
    assert.equal(s.repository.action.state, retryable ? 'retry_wait' : 'needs_review')
    if (retryable) assert.deepEqual(s.repository.settlements[0], { state: 'retry_wait', code: 'provider_busy', delayMs: 10, retryEvidence: 'rejected_before_effect' })
  }
})

test('unknown readback persists verification then exhausts bounded attempts without resending', async () => {
  const s = setup(); s.connector.verify = async () => { s.calls.verify++; return { status: 'unknown', code: 'provider_unavailable' } }
  for (let i = 0; i < 3; i++) { await s.run(); s.repository.advance(100) }
  assert.deepEqual(s.calls, { dispatch: 1, verify: 3 })
  assert.equal(s.repository.action.state, 'needs_review'); assert.equal(s.repository.action.lastErrorCode, 'verification_attempts_exhausted')
  assert.deepEqual(s.repository.settlements.slice(0, 2).map(r => r.state), ['verifying', 'verifying'])
})

test('non-authoritative absence never schedules dispatch even for an idempotent connector', async () => {
  const s = setup(); s.connector.idempotentWrites = true
  s.connector.verify = async () => ({ status: 'not_found', authoritative: false })
  await s.run(); assert.equal(s.repository.action.state, 'verifying'); assert.equal(s.repository.action.phase, 'verify')
  assert.equal(s.repository.action.lastErrorCode, 'verification_not_authoritative')
})

test('readback payload, operation identity or provider mismatch cannot be called succeeded', async () => {
  for (const kind of ['key', 'hash', 'provider'] as const) {
    const s = setup()
    s.connector.verify = async a => kind === 'provider' ? { status: 'mismatch', code: 'provider_payload_mismatch' }
      : { ...s.matched(a), ...(kind === 'key' ? { operationKey: 'some-other-operation' } : { inputSha256: 'b'.repeat(64) }) } as VerificationResult
    await s.run(); assert.equal(s.repository.action.state, 'needs_review', kind)
    assert.equal(s.repository.action.lastErrorCode, kind === 'provider' ? 'provider_payload_mismatch' : 'verification_identity_mismatch')
  }
})

test('invalid evidence and provider references fail closed instead of persisting unbounded data', async () => {
  for (const bad of [{ providerReference: '' }, { providerReference: 'line\nbreak' }, { evidence: { amount: Number.NaN } }, { evidence: { content: 'x'.repeat(17000) } }]) {
    const s = setup(); s.connector.verify = async a => ({ ...s.matched(a), ...bad }) as VerificationResult
    await s.run(); assert.equal(s.repository.action.lastErrorCode, 'invalid_verification_evidence')
  }
})

test('a connector ignoring AbortSignal times out and late acknowledgment cannot finalize the job', async () => {
  const s = setup(); const late = deferred<DispatchResult>(); let seenSignal: AbortSignal | undefined
  s.options.timeoutMs = 5
  s.connector.dispatch = async (_a, signal) => { s.calls.dispatch++; seenSignal = signal; return late.promise }
  s.connector.verify = async () => { s.calls.verify++; return { status: 'unknown', code: 'provider_pending' } }
  await s.run(); assert.equal(seenSignal?.aborted, true); assert.equal(s.repository.action.state, 'verifying')
  late.resolve({ status: 'accepted', providerReference: 'late-result' }); await Promise.resolve(); await Promise.resolve()
  assert.equal(s.repository.action.state, 'verifying'); assert.equal(s.repository.action.providerReference, null)
  assert.equal(s.repository.settlements.length, 1)
})

test('lease deadline bounds network timeout even when configured provider timeout is longer', async () => {
  const s = setup(); s.options.leaseMs = 10; s.options.timeoutMs = 1000
  let aborted = false
  s.connector.dispatch = async (_a, signal) => { signal.addEventListener('abort', () => { aborted = true; s.repository.advance(10) }); return new Promise(() => {}) }
  const result = await s.run(); assert.equal(aborted, true); assert.equal(result.status, 'stale')
  assert.equal(s.calls.verify, 0); assert.equal(s.repository.settlements.length, 0)
  assert.equal(s.repository.action.phase, 'verify')
})

test('lease theft after readback prevents stale success acknowledgment from overwriting newer work', async () => {
  const s = setup(); const ready = deferred<void>(); const result = deferred<VerificationResult>()
  s.connector.verify = async () => { ready.resolve(); return result.promise }
  const pending = s.run(); await ready.promise; s.repository.stealLease()
  result.resolve(s.matched(s.repository.action))
  assert.equal((await pending).status, 'stale'); assert.equal(s.repository.settlements.length, 0)
  assert.equal(s.repository.action.state, 'running'); assert.equal(s.repository.lease!.workerId, 'worker-new')
})

test('expired lease after an accepted create cannot finalize or perform an unleased readback', async () => {
  const s = setup(); const dispatch = s.connector.dispatch
  s.connector.dispatch = async (a, signal) => { const r = await dispatch(a, signal); s.repository.advance(1000); return r }
  assert.equal((await s.run()).status, 'stale'); assert.equal(s.calls.verify, 0)
  assert.equal(s.repository.action.state, 'running'); assert.equal(s.repository.action.phase, 'verify')
})

test('revocation and publication change before dispatch hold without external IO or second settlement', async () => {
  for (const field of ['revoked', 'configurationChanged'] as const) {
    const s = setup(); s.repository.afterClaim = () => { s.repository[field] = true }
    assert.equal((await s.run()).status, 'held'); assert.deepEqual(s.calls, { dispatch: 0, verify: 0 })
    assert.equal(s.repository.action.state, 'needs_review'); assert.equal(s.repository.settlements.length, 0)
  }
})

test('authority is checked before verification and again before committing readback success', async () => {
  for (const when of ['before_verify', 'after_verify'] as const) {
    const s = setup(); const dispatch = s.connector.dispatch; const verify = s.connector.verify
    if (when === 'before_verify') s.connector.dispatch = async (a, signal) => { const r = await dispatch(a, signal); s.repository.revoked = true; return r }
    else s.connector.verify = async (a, signal) => { const r = await verify(a, signal); s.repository.revoked = true; return r }
    const r = await s.run(); assert.equal(r.status, when === 'before_verify' ? 'held' : 'stale')
    assert.equal(s.repository.action.state, 'needs_review'); assert.equal(s.repository.settlements.length, 0)
    assert.equal(s.calls.verify, when === 'before_verify' ? 0 : 1)
  }
})

test('dispatch attempt cap blocks IO and bounded jitter never exceeds backoff maximum', async () => {
  const exhausted = setup({ dispatchAttempts: 3 }); await exhausted.run()
  assert.equal(exhausted.repository.action.lastErrorCode, 'dispatch_attempts_exhausted'); assert.equal(exhausted.calls.dispatch, 0)
  const jitter = setup({ state: 'verifying', phase: 'verify', dispatchStarted: true, dispatchAttempts: 8, verificationAttempts: 8, maxAttempts: 10 })
  jitter.options.random = () => 500; jitter.connector.verify = async () => ({ status: 'unknown', code: 'provider_busy' })
  await jitter.run(); assert.equal('delayMs' in jitter.repository.settlements[0]! && jitter.repository.settlements[0]!.delayMs, 100)
})

test('connector action copies cannot mutate the persisted intent or final identity comparison', async () => {
  const s = setup(); s.connector.dispatch = async a => { a.operationKey = 'attacker-key'; a.input.residence = '29E'; return { status: 'unknown', code: 'uncertain' } }
  s.connector.verify = async a => s.matched(a)
  await s.run(); assert.equal(s.repository.action.operationKey, initial.operationKey); assert.equal(s.repository.action.input.residence, '33A')
  assert.equal(s.repository.action.state, 'succeeded')
})

test('invalid worker options and clock fail before acquiring a lease', async () => {
  for (const invalid of [{ leaseMs: 0 }, { timeoutMs: Number.NaN }, { workerId: '' }, { baseBackoffMs: 10, maxBackoffMs: 5 }, { now: () => new Date('bad') }]) {
    const s = setup(); await assert.rejects(runWorkflowOnce({ ...s.options, ...invalid }), /Worker/)
    assert.deepEqual(s.repository.events, [])
  }
})

test('a corrupted persisted input digest becomes manual work without any connector request', async () => {
  const s = setup({ inputSha256: 'b'.repeat(64) }); await s.run()
  assert.equal(s.repository.action.lastErrorCode, 'workflow_input_digest_mismatch')
  assert.deepEqual(s.calls, { dispatch: 0, verify: 0 })
})

test('a repository that does not persist dispatch intent cannot trigger external IO', async () => {
  const s = setup()
  s.repository.startDispatch = async claim => ({ status: 'ready', claim })
  await assert.rejects(s.run(), /Dispatch intent was not durably marked/)
  assert.deepEqual(s.calls, { dispatch: 0, verify: 0 })
})

test('a changed connector or immutable payload in a returned claim is rejected before dispatch', async () => {
  for (const mutate of [(a: WorkflowAction) => { a.connector = 'other-provider' }, (a: WorkflowAction) => { a.input.residence = '29E' }]) {
    const s = setup(); const start = s.repository.startDispatch.bind(s.repository)
    s.repository.startDispatch = async claim => { const r = await start(claim); if (r.status === 'ready') mutate(r.claim.action); return r }
    await assert.rejects(s.run(), /different workflow claim/)
    assert.deepEqual(s.calls, { dispatch: 0, verify: 0 })
  }
})

test('malformed rejection metadata cannot authorize a non-idempotent retry', async () => {
  const s = setup()
  s.connector.dispatch = async () => ({ status: 'rejected', retryable: 'yes', code: 'provider_busy' }) as unknown as DispatchResult
  await s.run()
  assert.equal(s.repository.action.state, 'needs_review')
  assert.equal(s.repository.action.lastErrorCode, 'non_idempotent_outcome_unresolved')
})

test('a lease stolen while dispatch is in flight stops further connector work on late acceptance', async () => {
  const s = setup(); const dispatched = deferred<void>(); const late = deferred<DispatchResult>()
  s.connector.dispatch = async () => { s.calls.dispatch++; dispatched.resolve(); return late.promise }
  const running = s.run(); await dispatched.promise; s.repository.stealLease()
  late.resolve({ status: 'accepted', providerReference: 'late-provider-reference' })
  assert.equal((await running).status, 'stale'); assert.equal(s.calls.verify, 0)
  assert.equal(s.repository.settlements.length, 0); assert.equal(s.repository.action.state, 'running')
})

test('explicit replay after exhausted verification can find the original effect without another dispatch', async () => {
  const s = setup({ maxAttempts: 2 }); const originalVerify = s.connector.verify
  s.connector.verify = async () => { s.calls.verify++; return { status: 'unknown', code: 'provider_unavailable' } }
  await s.run(); s.repository.advance(100); await s.run()
  assert.equal(s.repository.action.state, 'needs_review')
  assert.equal(s.repository.action.lastErrorCode, 'verification_attempts_exhausted')
  assert.equal(s.repository.action.verificationAttempts, 2)
  assert.equal(s.repository.action.verificationAttemptsAtReplay, 0)
  const key = s.repository.action.operationKey, digest = s.repository.action.inputSha256
  await s.repository.replay('action-1', 'Provider read service restored')
  assert.equal(s.repository.action.verificationAttemptsAtReplay, 2)
  assert.equal(s.repository.action.verificationAttempts, 2)
  s.connector.verify = originalVerify; await s.run()
  assert.equal(s.repository.action.state, 'succeeded'); assert.equal(s.repository.action.verificationAttempts, 3)
  assert.equal(s.repository.action.dispatchAttempts, 1); assert.equal(s.calls.dispatch, 1)
  assert.equal(s.repository.action.operationKey, key); assert.equal(s.repository.action.inputSha256, digest)
  assert.deepEqual(s.repository.events.filter(e => e === 'operator_replay'), ['operator_replay'])
})

test('verification counters may exceed the per-generation budget without an automatic reset', async () => {
  const s = setup({ phase: 'verify', state: 'verifying', dispatchStarted: true, dispatchAttempts: 1,
    verificationAttempts: 105, verificationAttemptsAtReplay: 104, maxAttempts: 2 })
  s.connector.verify = async () => ({ status: 'unknown', code: 'still_unavailable' })
  await s.run()
  assert.equal(s.repository.action.verificationAttempts, 106)
  assert.equal(s.repository.action.verificationAttemptsAtReplay, 104)
  assert.equal(s.repository.action.state, 'needs_review')
  assert.equal(s.repository.action.lastErrorCode, 'verification_attempts_exhausted')
  assert.equal(s.calls.dispatch, 0)
})

test('explicit replay does not reset or enlarge the lifetime dispatch budget', async () => {
  const s = setup({ state: 'needs_review', phase: 'verify', dispatchStarted: true, dispatchAttempts: 3,
    verificationAttempts: 3, maxAttempts: 3 })
  s.connector.idempotentWrites = true
  await s.repository.replay('action-1', 'Check whether original external effect exists')
  await s.run()
  assert.equal(s.repository.action.state, 'needs_review')
  assert.equal(s.repository.action.lastErrorCode, 'dispatch_attempts_exhausted')
  assert.equal(s.repository.action.dispatchAttempts, 3); assert.equal(s.calls.dispatch, 0)
  assert.equal(s.repository.action.verificationAttempts, 4)
})

test('invalid replay checkpoints and exhausted safe-integer counters fail closed before verification IO', async () => {
  for (const patch of [
    { verificationAttempts: 2, verificationAttemptsAtReplay: 3 },
    { verificationAttempts: 2, verificationAttemptsAtReplay: -1 },
    { verificationAttempts: Number.MAX_SAFE_INTEGER + 1, verificationAttemptsAtReplay: 0 },
  ]) {
    const s = setup({ ...patch, phase: 'verify' }); await s.run()
    assert.equal(s.repository.action.lastErrorCode, 'invalid_workflow_attempts')
    assert.deepEqual(s.calls, { dispatch: 0, verify: 0 })
  }
  const maxed = setup({ phase: 'verify', verificationAttempts: Number.MAX_SAFE_INTEGER, verificationAttemptsAtReplay: Number.MAX_SAFE_INTEGER })
  await maxed.run(); assert.equal(maxed.repository.action.lastErrorCode, 'verification_counter_exhausted')
  assert.deepEqual(maxed.calls, { dispatch: 0, verify: 0 })
})
