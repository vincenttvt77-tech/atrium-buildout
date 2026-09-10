import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { AuthorizedScope, Permission } from '../auth/index.ts'
import { assertAuthorizedScope } from '../auth/index.ts'
import { WorkflowError } from '../workflows/model.ts'
import type { ClaimDecision, JsonObject, WorkflowAction, WorkflowClaim, WorkflowOrigin,
  WorkflowReceiptInput, WorkflowReceiptResult, WorkflowRepository, WorkflowSettlement, WorkflowState } from '../workflows/model.ts'
import { canonicalJson, hashJson, validateReceiptInput } from '../workflows/validation.ts'
import type { DatabaseConnection, DatabaseContext } from './connection.ts'
import { assertCurrentPropertyAccess, propertyTransaction, scopeContext } from './scope.ts'
import type { DocumentStore } from '../store/documents.ts'
import { createTransactionDocumentStore } from './operations.ts'
import { TransactionQueue } from './transaction-queue.ts'

type Row = Record<string, any>
export interface WorkflowAttribution { requestId: string; configurationVersion: number }
export interface WorkflowTransaction {
  readonly documents: DocumentStore
  readonly workflows: WorkflowRepository
}
type TransactionExecutor = <T>(permission: Permission, work: (client: PoolClient) => Promise<T>, admission: boolean) => Promise<T>
const STATES: WorkflowState[] = ['queued','running','retry_wait','verifying','succeeded','needs_review','cancelled']
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const CODE = /^[a-z][a-z0-9_]{0,127}$/
const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max
const invalid = (): never => { throw new WorkflowError('workflow_invalid_input', 'Workflow input is invalid.') }
const iso = (value: Date | string): string => new Date(value).toISOString()
const SELECT = `SELECT a.id,a.receipt_id,a.organization_id,a.property_id,a.kind,a.connector,a.source_operation_key,
  a.operation_key,a.input,a.input_sha256,a.max_attempts,a.created_at AS action_created_at,
  r.configuration_version,r.request_id,r.origin_kind,r.origin_user_id,r.origin_credential_version,
  r.origin_binding_id,r.origin_binding_version,r.origin_provider,r.origin_external_id,
  o.state,o.phase,o.dispatch_attempts,o.verification_attempts,o.verification_attempts_at_replay,o.available_at,o.updated_at,o.completed_at,
  o.last_error_code,o.dispatch_started,o.safe_retry_evidence,o.provider_reference,o.evidence,
  o.lease_token,o.worker_id,o.lease_acquired_at,o.lease_expires_at
  FROM atrium.action_intents a JOIN atrium.inbox_events r
    ON (r.organization_id,r.property_id,r.id)=(a.organization_id,a.property_id,a.receipt_id)
  JOIN atrium.outbox_messages o
    ON (o.organization_id,o.property_id,o.action_id)=(a.organization_id,a.property_id,a.id)`
const WHERE = 'a.organization_id=$1 AND a.property_id=$2'
const CLEAR_LEASE = 'lease_token=NULL,worker_id=NULL,lease_acquired_at=NULL,lease_expires_at=NULL'

function origin(row: Row): WorkflowOrigin {
  return row.origin_kind === 'user'
    ? { kind: 'user', userId: row.origin_user_id, credentialVersion: Number(row.origin_credential_version) }
    : { kind: 'channel', bindingId: row.origin_binding_id, bindingVersion: Number(row.origin_binding_version),
      provider: row.origin_provider, externalId: row.origin_external_id }
}
function action(row: Row): WorkflowAction {
  return { id: row.id, receiptId: row.receipt_id, organizationId: row.organization_id, propertyId: row.property_id,
    configurationVersion: Number(row.configuration_version), requestId: row.request_id, origin: origin(row),
    kind: row.kind, connector: row.connector, operationKey: row.operation_key, input: row.input,
    inputSha256: row.input_sha256, state: row.state, phase: row.phase,
    dispatchAttempts: row.dispatch_attempts, verificationAttempts: Number(row.verification_attempts), verificationAttemptsAtReplay: Number(row.verification_attempts_at_replay), maxAttempts: row.max_attempts,
    availableAt: iso(row.available_at), createdAt: iso(row.action_created_at), updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null, lastErrorCode: row.last_error_code,
    dispatchStarted: row.dispatch_started, providerReference: row.provider_reference, evidence: row.evidence }
}
function claimValue(row: Row): WorkflowClaim {
  return { action: action(row), token: row.lease_token, workerId: row.worker_id,
    acquiredAt: iso(row.lease_acquired_at), expiresAt: iso(row.lease_expires_at) }
}

const contextSettings = [
  ['actor_user_id','actorUserId'],['credential_version','credentialVersion'],['session_id','actorSessionId'],['organization_id','organizationId'],
  ['property_id','propertyId'],['login_username','loginUsername'],['channel_provider','channelProvider'],
  ['channel_external_id','channelExternalId'],['channel_binding_id','channelBindingId'],['channel_binding_version','channelBindingVersion'],
] as const
async function setContext(client: PoolClient, context: DatabaseContext): Promise<void> {
  await client.query(`SELECT ${contextSettings.map(([name], index) => `pg_catalog.set_config('atrium.${name}',$${index + 1},true)`).join(',')}`,
    contextSettings.map(([, key]) => String(context[key] ?? '')))
}

/** No connector IO or portfolio-wide authority lives in this repository. */
export class PostgresWorkflowRepository implements WorkflowRepository {
  private readonly connection: DatabaseConnection
  private readonly scope: AuthorizedScope
  private readonly attribution: WorkflowAttribution
  private transactionExecutor: TransactionExecutor | undefined
  constructor(connection: DatabaseConnection, scope: AuthorizedScope, attribution: WorkflowAttribution) {
    assertAuthorizedScope(scope)
    if (!ID.test(attribution.requestId) || !integer(attribution.configurationVersion, 1, Number.MAX_SAFE_INTEGER)) invalid()
    this.connection = connection; this.scope = scope; this.attribution = { ...attribution }
  }
  private ids(): string[] { return [this.scope.organizationId, this.scope.propertyId] }
  private tx<T>(permission: Permission, work: (client: PoolClient) => Promise<T>, admission = false): Promise<T> {
    if (this.transactionExecutor) return this.transactionExecutor(permission, work, admission)
    return propertyTransaction(this.connection, this.scope, permission, work,
      admission ? this.attribution.configurationVersion : undefined)
  }

  /** Atomic local composition. Never perform provider IO in this callback.
   * Both ports use this one property transaction and expire when its callback ends.
   * Complete operations are serialized so temporary original-actor checks cannot
   * leak their transaction-local context into a concurrent document operation.
   */
  transaction<T>(work: (unit: WorkflowTransaction) => Promise<T>): Promise<T> {
    if (typeof work !== 'function') throw new WorkflowError('workflow_invalid_input', 'A workflow transaction callback is required.')
    return propertyTransaction(this.connection, this.scope, 'operate', async client => {
      const queue = new TransactionQueue()
      const documentUnit = createTransactionDocumentStore(client, this.scope, this.attribution)
      const raw = documentUnit.documents
      const documents: DocumentStore = Object.freeze({
        get: <U>(key: string) => queue.run(() => raw.get<U>(key)),
        set: <U>(key: string, value: U) => queue.run(() => raw.set(key, value)),
        update: <U>(key: string, initial: U, fn: (current: U) => U) => queue.run(() => raw.update(key, initial, fn)),
        list: (prefix: string) => queue.run(() => raw.list(prefix)),
        delete: (key: string) => queue.run(() => raw.delete(key)),
        describe: () => { queue.assertOpen(); return raw.describe() },
      })
      const bound = new PostgresWorkflowRepository(this.connection, this.scope, this.attribution)
      bound.transactionExecutor = async (permission, operation, admission) => {
        const version = admission ? this.attribution.configurationVersion : undefined
        await assertCurrentPropertyAccess(client, this.scope, permission, version)
        const result = await operation(client)
        await assertCurrentPropertyAccess(client, this.scope, permission, version)
        return result
      }
      const workflows = Object.freeze<WorkflowRepository>({
        accept: input => queue.run(() => bound.accept(input)),
        get: id => queue.run(() => bound.get(id)), list: options => queue.run(() => bound.list(options)),
        claim: options => queue.run(() => bound.claim(options)),
        startDispatch: claim => queue.run(() => bound.startDispatch(claim)),
        startVerification: claim => queue.run(() => bound.startVerification(claim)),
        settle: (claim, result) => queue.run(() => bound.settle(claim, result)),
        replay: (id, reason) => queue.run(() => bound.replay(id, reason)),
        cancel: (id, reason) => queue.run(() => bound.cancel(id, reason)),
      })
      try {
        const result = await work(Object.freeze({ documents, workflows }))
        await queue.close()
        await documentUnit.close()
        return result
      } catch (error) {
        try { await queue.close() } catch { /* Preserve the first callback/operation failure. */ }
        try { await documentUnit.close() } catch { /* Drain before the owner releases its client. */ }
        throw error
      }
    }, this.attribution.configurationVersion)
  }
  private async row(client: PoolClient, id: string, locked = false): Promise<Row | null> {
    return (await client.query(`${SELECT} WHERE ${WHERE} AND a.id=$3${locked ? ' FOR UPDATE OF o' : ''}`, [...this.ids(), id])).rows[0] ?? null
  }
  private async event(client: PoolClient, id: string, kind: string, details: JsonObject = {}): Promise<void> {
    const actor = this.scope.actor
    await client.query(`INSERT INTO atrium.workflow_events
      (organization_id,property_id,id,action_id,event_kind,actor_user_id,actor_channel_binding_id,request_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [...this.ids(), randomUUID(), id, kind, actor.kind === 'user' ? actor.userId : null,
      actor.kind === 'channel' ? actor.bindingId : null, this.attribution.requestId, canonicalJson(details)])
  }
  /** Evaluate original authority with ordinary RLS, then restore the worker before writes. */
  private async originalHold(client: PoolClient, row: Row): Promise<string | null> {
    const accepted = origin(row)
    const context: DatabaseContext = { organizationId: row.organization_id, propertyId: row.property_id,
      ...(accepted.kind === 'user' ? { actorUserId: accepted.userId, credentialVersion: accepted.credentialVersion }
        : { channelBindingId: accepted.bindingId, channelBindingVersion: accepted.bindingVersion,
          channelProvider: accepted.provider, channelExternalId: accepted.externalId }) }
    try {
      await setContext(client, context)
      const allowed = await client.query('SELECT atrium.can_access_property($1,$2,\'operate\') AS allowed', this.ids())
      if (allowed.rows[0]?.allowed !== true) return 'original_authorization_changed'
      const property = await client.query(`SELECT published_configuration_version FROM atrium.properties
        WHERE organization_id=$1 AND id=$2`, this.ids())
      return Number(property.rows[0]?.published_configuration_version) === Number(row.configuration_version)
        ? null : 'original_configuration_changed'
    } finally { await setContext(client, scopeContext(this.scope)) }
  }
  /** Roll back a transition if original authority changes while it is being written.
   * This is an entrance/exit gate, not serializable revocation or cancellation of
   * provider IO already sent after a previously successful gate.
   */
  private async originalTransition<T>(client: PoolClient, row: Row, write: () => Promise<T>): Promise<
    { allowed: true; value: T } | { allowed: false; code: string }> {
    await client.query('SAVEPOINT workflow_transition')
    const value = await write()
    const code = await this.originalHold(client, row)
    if (code) await client.query('ROLLBACK TO SAVEPOINT workflow_transition')
    await client.query('RELEASE SAVEPOINT workflow_transition')
    return code ? { allowed: false, code } : { allowed: true, value }
  }
  private validClaim(claim: WorkflowClaim): boolean {
    return Boolean(claim && claim.action && ID.test(claim.action.id) && TOKEN.test(claim.token)
      && typeof claim.workerId === 'string' && ID.test(claim.workerId)
      && claim.action.organizationId === this.scope.organizationId && claim.action.propertyId === this.scope.propertyId)
  }
  private async fenced(client: PoolClient, claim: WorkflowClaim): Promise<Row | null> {
    if (!this.validClaim(claim)) return null
    return (await client.query(`${SELECT} WHERE ${WHERE} AND a.id=$3 AND o.state='running'
      AND o.lease_token=$4::uuid AND o.worker_id=$5 AND o.lease_expires_at>clock_timestamp() FOR UPDATE OF o`,
    [...this.ids(), claim.action.id, claim.token, claim.workerId])).rows[0] ?? null
  }
  private async hold(client: PoolClient, claim: WorkflowClaim, code: string): Promise<boolean> {
    const changed = await client.query(`UPDATE atrium.outbox_messages SET state='needs_review',completed_at=clock_timestamp(),
      last_error_code=$6,${CLEAR_LEASE} WHERE organization_id=$1 AND property_id=$2 AND action_id=$3
      AND lease_token=$4::uuid AND worker_id=$5 AND state='running' AND lease_expires_at>clock_timestamp()`,
    [...this.ids(), claim.action.id, claim.token, claim.workerId, code])
    if (!changed.rowCount) return false
    await this.event(client, claim.action.id, 'held', { code })
    return true
  }

  async accept(raw: WorkflowReceiptInput): Promise<WorkflowReceiptResult> {
    const input = validateReceiptInput(raw), payload = canonicalJson(input.payload), manifest = canonicalJson(input.actions)
    const payloadHash = hashJson(input.payload), accepted = this.scope.actor
    const originKey = `${accepted.kind}:${accepted.kind === 'user' ? accepted.userId : accepted.bindingId}`
    try {
      return await this.tx('operate', async client => {
        await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))',
          [canonicalJson([...this.ids(), originKey, input.source, input.eventId])])
        const old = (await client.query(`SELECT id,payload,payload_sha256,action_manifest FROM atrium.inbox_events
          WHERE organization_id=$1 AND property_id=$2 AND origin_key=$3 AND source=$4 AND event_id=$5`,
        [...this.ids(), originKey, input.source, input.eventId])).rows[0]
        if (old) {
          if (old.payload_sha256 !== payloadHash || canonicalJson(old.payload) !== payload || canonicalJson(old.action_manifest) !== manifest) {
            throw new WorkflowError('workflow_receipt_conflict', 'This event identity was already accepted with different content.')
          }
          const rows = (await client.query(`${SELECT} WHERE ${WHERE} AND a.receipt_id=$3 ORDER BY a.created_at,a.id`, [...this.ids(), old.id])).rows
          const ordered = input.actions.map(item => rows.find(row => row.connector === item.connector
            && row.kind === item.kind && row.source_operation_key === item.operationKey))
          if (rows.length !== input.actions.length || ordered.some(row => !row)) {
            throw new WorkflowError('workflow_receipt_incomplete', 'The accepted receipt needs a consistency review.')
          }
          return { receiptId: old.id, duplicate: true, actions: ordered.map(row => action(row!)) }
        }
        const receiptId = randomUUID()
        await client.query(`INSERT INTO atrium.inbox_events(organization_id,property_id,id,source,event_id,origin_kind,
          origin_user_id,origin_credential_version,origin_binding_id,origin_binding_version,origin_provider,origin_external_id,
          configuration_version,request_id,payload,payload_sha256,action_manifest)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb)`,
        [...this.ids(), receiptId, input.source, input.eventId, accepted.kind,
          accepted.kind === 'user' ? accepted.userId : null, accepted.kind === 'user' ? accepted.credentialVersion : null,
          accepted.kind === 'channel' ? accepted.bindingId : null, accepted.kind === 'channel' ? accepted.bindingVersion : null,
          accepted.kind === 'channel' ? accepted.provider : null, accepted.kind === 'channel' ? accepted.externalId : null,
          this.attribution.configurationVersion, this.attribution.requestId, payload, payloadHash, manifest])
        const actions: WorkflowAction[] = []
        for (const item of input.actions) {
          const id = randomUUID()
          const operationKey = hashJson([...this.ids(), item.connector, item.kind, item.operationKey])
          await client.query(`INSERT INTO atrium.action_intents(organization_id,property_id,id,receipt_id,kind,connector,
            source_operation_key,operation_key,input,input_sha256,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
          [...this.ids(), id, receiptId, item.kind, item.connector, item.operationKey, operationKey, canonicalJson(item.input), hashJson(item.input), item.maxAttempts])
          await client.query('INSERT INTO atrium.outbox_messages(organization_id,property_id,action_id) VALUES($1,$2,$3)', [...this.ids(), id])
          await this.event(client, id, 'accepted', { receiptId })
          actions.push(action((await this.row(client, id))!))
        }
        return { receiptId, duplicate: false, actions }
      }, true)
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') throw new WorkflowError('workflow_operation_conflict', 'This operation key already belongs to another accepted action.')
      throw error
    }
  }

  async get(id: string): Promise<WorkflowAction | null> {
    if (!ID.test(id)) invalid()
    return this.tx('read', async client => { const row = await this.row(client, id); return row ? action(row) : null })
  }
  async list(options: { states?: WorkflowState[]; limit?: number; before?: { createdAt: string; id: string } } = {}): Promise<WorkflowAction[]> {
    const limit = options.limit ?? 50
    if (!integer(limit, 1, 100) || (options.states && (!Array.isArray(options.states) || !options.states.length
      || options.states.some(state => !STATES.includes(state)) || new Set(options.states).size !== options.states.length))) invalid()
    if (options.before && (!ID.test(options.before.id) || !Number.isFinite(Date.parse(options.before.createdAt)))) invalid()
    return this.tx('read', async client => {
      const parameters: unknown[] = this.ids(), conditions = [WHERE]
      if (options.states) { parameters.push(options.states); conditions.push(`o.state=ANY($${parameters.length}::text[])`) }
      if (options.before) {
        parameters.push(options.before.createdAt, options.before.id)
        conditions.push(`(a.created_at,a.id)<($${parameters.length - 1}::timestamptz,$${parameters.length}::text)`)
      }
      parameters.push(limit)
      return (await client.query(`${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC,a.id DESC LIMIT $${parameters.length}`, parameters)).rows.map(action)
    })
  }
  async claim(options: { workerId: string; leaseMs: number }): Promise<WorkflowClaim | null> {
    if (!ID.test(options.workerId) || !integer(options.leaseMs, 10, 300_000)) invalid()
    return this.tx('operate', async client => {
      const row = (await client.query(`${SELECT} WHERE ${WHERE} AND (
        (o.state IN ('queued','retry_wait','verifying') AND o.available_at<=clock_timestamp())
        OR (o.state='running' AND o.lease_expires_at<=clock_timestamp()))
        ORDER BY o.available_at,a.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`, this.ids())).rows[0]
      if (!row) return null
      const phase = row.state === 'running' ? (row.dispatch_started ? 'verify' : 'dispatch') : row.phase
      const token = randomUUID()
      await client.query(`UPDATE atrium.outbox_messages SET state='running',phase=$4,lease_token=$5::uuid,worker_id=$6,
        lease_acquired_at=clock_timestamp(),lease_expires_at=clock_timestamp()+($7::integer * interval '1 millisecond'),
        safe_retry_evidence=CASE WHEN $4='verify' THEN NULL ELSE safe_retry_evidence END
        WHERE organization_id=$1 AND property_id=$2 AND action_id=$3`,
      [...this.ids(), row.id, phase, token, options.workerId, options.leaseMs])
      await this.event(client, row.id, row.state === 'running' ? 'lease_recovered' : 'claimed', { phase, workerId: options.workerId })
      return claimValue((await this.row(client, row.id))!)
    })
  }
  private async start(claim: WorkflowClaim, phase: 'dispatch' | 'verify'): Promise<ClaimDecision> {
    return this.tx('operate', async client => {
      const row = await this.fenced(client, claim)
      if (!row) return { status: 'stale' }
      if (row.phase !== phase) return { status: 'stale' }
      const code = await this.originalHold(client, row)
        ?? ((phase === 'dispatch' ? row.dispatch_attempts : Number(row.verification_attempts) - Number(row.verification_attempts_at_replay)) >= row.max_attempts
          ? `${phase === 'dispatch' ? 'dispatch' : 'verification'}_attempts_exhausted` : null)
      if (code) return await this.hold(client, claim, code) ? { status: 'held', code } : { status: 'stale' }
      const update = phase === 'dispatch'
        ? "dispatch_started=true,phase='verify',safe_retry_evidence=NULL,dispatch_attempts=dispatch_attempts+1"
        : 'verification_attempts=verification_attempts+1'
      const transition = await this.originalTransition<ClaimDecision>(client, row, async () => {
        const changed = await client.query(`UPDATE atrium.outbox_messages SET ${update}
          WHERE organization_id=$1 AND property_id=$2 AND action_id=$3 AND state='running'
          AND lease_token=$4::uuid AND worker_id=$5 AND lease_expires_at>clock_timestamp()`,
        [...this.ids(), claim.action.id, claim.token, claim.workerId])
        if (!changed.rowCount) return { status: 'stale' }
        await this.event(client, row.id, phase === 'dispatch' ? 'dispatch_started' : 'verification_started')
        return { status: 'ready', claim: claimValue((await this.row(client, row.id))!) }
      })
      if (transition.allowed) return transition.value
      return await this.hold(client, claim, transition.code) ? { status: 'held', code: transition.code } : { status: 'stale' }
    })
  }
  startDispatch(claim: WorkflowClaim): Promise<ClaimDecision> { return this.start(claim, 'dispatch') }
  startVerification(claim: WorkflowClaim): Promise<ClaimDecision> { return this.start(claim, 'verify') }

  async settle(claim: WorkflowClaim, result: WorkflowSettlement): Promise<boolean> {
    if (!result || !['succeeded','verifying','retry_wait','needs_review'].includes(result.state)) invalid()
    if ('code' in result && !CODE.test(result.code)) invalid()
    if ('delayMs' in result && !integer(result.delayMs, 0, 3_600_000)) invalid()
    if ('providerReference' in result && (typeof result.providerReference !== 'string' || !result.providerReference.trim()
      || result.providerReference.length > 256 || /[\u0000-\u001f\u007f]/.test(result.providerReference))) invalid()
    if (result.state === 'succeeded' && (!result.evidence || typeof result.evidence !== 'object' || Array.isArray(result.evidence)
      || canonicalJson(result.evidence).length > 16_384)) invalid()
    if (result.state === 'retry_wait' && !['rejected_before_effect','authoritative_absence_idempotent'].includes(result.retryEvidence)) invalid()
    return this.tx('operate', async client => {
      const row = await this.fenced(client, claim)
      if (!row) return false
      const code = await this.originalHold(client, row)
      if (code) { await this.hold(client, claim, code); return false }
      if (result.state !== 'needs_review' && (!row.dispatch_started || row.phase !== 'verify')) invalid()
      if (result.state === 'succeeded' && row.verification_attempts < 1) invalid()
      if ('providerReference' in result && row.provider_reference && row.provider_reference !== result.providerReference) {
        await this.hold(client, claim, 'provider_reference_conflict'); return false
      }
      const terminal = result.state === 'succeeded' || result.state === 'needs_review'
      const transition = await this.originalTransition(client, row, async () => {
        const changed = await client.query(`UPDATE atrium.outbox_messages SET state=$6,
          phase=CASE WHEN $6='retry_wait' THEN 'dispatch' ELSE phase END,
          safe_retry_evidence=$7,available_at=clock_timestamp()+($8::integer * interval '1 millisecond'),
          completed_at=CASE WHEN $9::boolean THEN clock_timestamp() ELSE NULL END,
          last_error_code=$10,provider_reference=coalesce($11,provider_reference),evidence=$12::jsonb,${CLEAR_LEASE}
          WHERE organization_id=$1 AND property_id=$2 AND action_id=$3 AND lease_token=$4::uuid AND worker_id=$5
          AND state='running' AND lease_expires_at>clock_timestamp()`,
        [...this.ids(), claim.action.id, claim.token, claim.workerId, result.state,
          result.state === 'retry_wait' ? result.retryEvidence : null, 'delayMs' in result ? result.delayMs : 0,
          terminal, 'code' in result ? result.code : null, 'providerReference' in result ? result.providerReference : null,
          result.state === 'succeeded' ? canonicalJson(result.evidence) : null])
        if (!changed.rowCount) return false
        await this.event(client, row.id, 'settled', { state: result.state,
          ...('code' in result ? { code: result.code } : {}),
          ...(result.state === 'retry_wait' ? { retryEvidence: result.retryEvidence } : {}) })
        return true
      })
      if (transition.allowed) return transition.value
      await this.hold(client, claim, transition.code)
      return false
    })
  }
  async replay(id: string, reason: string): Promise<WorkflowAction> {
    if (!ID.test(id) || !CODE.test(reason)) invalid()
    return this.tx('configure', async client => {
      const row = await this.row(client, id, true)
      if (!row) throw new WorkflowError('workflow_not_found', 'The workflow action does not exist.')
      if (row.state === 'succeeded' || row.state === 'running') throw new WorkflowError('workflow_replay_refused', 'This action cannot be replayed in its current state.')
      const phase = row.dispatch_started ? 'verify' : 'dispatch'
      const code = await this.originalHold(client, row)
        ?? (phase === 'dispatch' && row.dispatch_attempts >= row.max_attempts ? 'workflow_attempts_exhausted' : null)
      const write = async (heldCode: string | null): Promise<WorkflowAction> => {
        await client.query(`UPDATE atrium.outbox_messages SET state=$4,phase=$5,safe_retry_evidence=NULL,
          available_at=clock_timestamp(),last_error_code=$6,completed_at=CASE WHEN $4='needs_review' THEN clock_timestamp() ELSE NULL END,
          verification_attempts_at_replay=CASE WHEN $4='verifying' THEN verification_attempts ELSE verification_attempts_at_replay END,
          ${CLEAR_LEASE} WHERE organization_id=$1 AND property_id=$2 AND action_id=$3`,
        [...this.ids(), id, heldCode ? 'needs_review' : phase === 'verify' ? 'verifying' : 'queued', phase, heldCode])
        await this.event(client, id, heldCode ? 'replay_held' : 'replayed', { reason, ...(heldCode ? { code: heldCode } : {}), ...(phase === 'verify' && !heldCode ? { verificationAttemptsAtReplay: Number(row.verification_attempts) } : {}) })
        return action((await this.row(client, id))!)
      }
      if (code) return write(code)
      const transition = await this.originalTransition(client, row, () => write(null))
      return transition.allowed ? transition.value : write(transition.code)
    })
  }
  async cancel(id: string, reason: string): Promise<WorkflowAction> {
    if (!ID.test(id) || !CODE.test(reason)) invalid()
    return this.tx('configure', async client => {
      const row = await this.row(client, id, true)
      if (!row) throw new WorkflowError('workflow_not_found', 'The workflow action does not exist.')
      if (row.dispatch_started || row.state === 'succeeded') throw new WorkflowError('workflow_cancel_refused', 'A possibly dispatched action requires verification and cannot be cancelled.')
      if (row.state === 'cancelled') return action(row)
      await client.query(`UPDATE atrium.outbox_messages SET state='cancelled',completed_at=clock_timestamp(),
        last_error_code=NULL,${CLEAR_LEASE} WHERE organization_id=$1 AND property_id=$2 AND action_id=$3`, [...this.ids(), id])
      await this.event(client, id, 'cancelled', { reason })
      return action((await this.row(client, id))!)
    })
  }
}
