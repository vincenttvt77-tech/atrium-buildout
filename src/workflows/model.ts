/** Provider-neutral durable work. A persisted intent is never a confirmed external result. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type WorkflowState = 'queued' | 'running' | 'retry_wait' | 'verifying' | 'succeeded' | 'needs_review' | 'cancelled'
export type WorkflowPhase = 'dispatch' | 'verify'
export type WorkflowOrigin =
  | { kind: 'user'; userId: string; credentialVersion: number }
  | { kind: 'channel'; bindingId: string; bindingVersion: number; provider: string; externalId: string }

export interface WorkflowAction {
  id: string
  receiptId: string
  organizationId: string
  propertyId: string
  configurationVersion: number
  requestId: string
  origin: WorkflowOrigin
  kind: string
  connector: string
  /** Scoped and stable through retries, lease recovery and operator replay. */
  operationKey: string
  input: JsonObject
  inputSha256: string
  state: WorkflowState
  phase: WorkflowPhase
  dispatchAttempts: number
  verificationAttempts: number
  /** Lifetime verification count at the last configure-authorized replay; initially zero. */
  verificationAttemptsAtReplay: number
  maxAttempts: number
  availableAt: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  lastErrorCode: string | null
  /** Durable before network IO; stays true even when the process never reaches the provider. */
  dispatchStarted: boolean
  providerReference: string | null
  evidence: JsonObject | null
  /** Opaque current-row concurrency token. PostgreSQL always returns this; older test adapters may omit it. */
  revision?: string
}

export interface WorkflowClaim {
  action: WorkflowAction
  token: string
  workerId: string
  acquiredAt: string
  expiresAt: string
}

export interface NewWorkflowAction {
  kind: string
  connector: string
  operationKey: string
  input: JsonObject
  maxAttempts?: number
}
export interface WorkflowReceiptInput {
  source: string
  eventId: string
  payload: JsonObject
  actions: NewWorkflowAction[]
}
export interface WorkflowReceiptResult {
  receiptId: string
  duplicate: boolean
  actions: WorkflowAction[]
}

/** A reason code contains no provider response body, caller words or credentials. */
export type ClaimDecision =
  | { status: 'ready'; claim: WorkflowClaim }
  | { status: 'stale' }
  | { status: 'held'; code: string }

export type WorkflowSettlement =
  | { state: 'succeeded'; evidence: JsonObject; providerReference: string }
  | { state: 'verifying'; code: string; delayMs: number; providerReference?: string }
  | { state: 'retry_wait'; code: string; delayMs: number; retryEvidence: 'rejected_before_effect' | 'authoritative_absence_idempotent' }
  | { state: 'needs_review'; code: string }

/**
 * Every method uses property authorization and a database transaction. Claims use
 * database time; all transitions fence on token AND unexpired deadline. Before a
 * dispatch and after read-back, implementations recheck the original actor's current
 * authority and the original configuration against the active property publication.
 * Connector methods are never called from inside these transactions.
 */
export interface WorkflowRepository {
  accept(input: WorkflowReceiptInput): Promise<WorkflowReceiptResult>
  get(id: string): Promise<WorkflowAction | null>
  list(options?: { states?: WorkflowState[]; limit?: number; before?: { createdAt: string; id: string } }): Promise<WorkflowAction[]>
  claim(options: { workerId: string; leaseMs: number }): Promise<WorkflowClaim | null>
  /** Recheck authorization, enforce attempt bound, then persist dispatchStarted/verify phase before IO. */
  startDispatch(claim: WorkflowClaim): Promise<ClaimDecision>
  /** Recheck authorization and increment bounded verification attempts before read-back IO. */
  startVerification(claim: WorkflowClaim): Promise<ClaimDecision>
  /** True means the requested transition committed. False includes a lost/expired lease or a persisted authority/config hold instead; never report the requested success then. */
  settle(claim: WorkflowClaim, result: WorkflowSettlement): Promise<boolean>
  /** Replay retains intent/key and resumes verification whenever dispatch could have happened. */
  replay(id: string, reason: string, expectedRevision?: string): Promise<WorkflowAction>
  /** Cannot cancel a possibly dispatched action without reconciling its external result. */
  cancel(id: string, reason: string, expectedRevision?: string): Promise<WorkflowAction>
}

export type DispatchResult =
  | { status: 'accepted'; providerReference?: string }
  /** Only a verified rejection before any provider effect; ambiguous errors must be unknown. */
  | { status: 'rejected'; code: string; retryable: boolean }
  | { status: 'unknown'; code: string }

export type VerificationResult =
  | { status: 'matched'; operationKey: string; inputSha256: string; providerReference: string; evidence: JsonObject }
  | { status: 'not_found'; authoritative: boolean }
  | { status: 'mismatch'; code: string }
  | { status: 'unknown'; code: string }

export interface WorkflowConnector {
  id: string
  /** True only when the real provider enforces this stable key for the complete operation. */
  idempotentWrites: boolean
  dispatch(action: WorkflowAction, signal: AbortSignal): Promise<DispatchResult>
  verify(action: WorkflowAction, signal: AbortSignal): Promise<VerificationResult>
}

export class WorkflowError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'WorkflowError'; this.code = code }
}
