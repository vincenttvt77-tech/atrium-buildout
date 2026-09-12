import { WorkflowError } from './model.ts'
import type { WorkflowAction, WorkflowState } from './model.ts'

export const queueFilters = Object.freeze({
  attention: ['needs_review'],
  active: ['queued', 'running', 'retry_wait', 'verifying'],
  complete: ['succeeded', 'cancelled'],
  all: ['queued', 'running', 'retry_wait', 'verifying', 'succeeded', 'needs_review', 'cancelled'],
} satisfies Record<string, WorkflowState[]>)

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const invalid = (): never => { throw new WorkflowError('workflow_invalid_input', 'Reload the work queue and choose a valid action.') }

/** Preserve the database timestamp's sub-millisecond ordering in the next cursor. */
function cursorTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
}

export function queueQuery(input: unknown): { states: WorkflowState[]; limit: number; before?: { createdAt: string; id: string } } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const query = input as Record<string, unknown>
  if (Object.keys(query).some(key => !['state', 'limit', 'beforeCreatedAt', 'beforeId'].includes(key))) return invalid()
  const filter = query.state ?? 'attention'
  if (typeof filter !== 'string' || !Object.hasOwn(queueFilters, filter)) return invalid()
  const requested = query.limit ?? '25'
  if (typeof requested !== 'string' || !/^[1-9]\d?$/.test(requested) || Number(requested) > 50) return invalid()
  const limit = Number(requested)
  const cursor = query.beforeCreatedAt !== undefined || query.beforeId !== undefined
  if (cursor && (!cursorTime(query.beforeCreatedAt) || !id(query.beforeId))) return invalid()
  return { states: [...queueFilters[filter as keyof typeof queueFilters]], limit,
    ...(cursor ? { before: { createdAt: query.beforeCreatedAt as string, id: query.beforeId as string } } : {}) }
}

export interface RecoveryCommand { action: 'replay' | 'cancel'; id: string; expectedRevision: string; reason: string }
export function recoveryCommand(input: unknown): RecoveryCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.isBuffer(input)) return invalid()
  const value = input as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'action,expectedRevision,id,reason'
    || !id(value.id) || !revision(value.expectedRevision) || typeof value.reason !== 'string') return invalid()
  const allowed = value.action === 'replay' ? ['provider_recovered', 'reviewed_request']
    : value.action === 'cancel' ? ['duplicate_request', 'no_longer_needed'] : []
  if (!allowed.includes(value.reason)) return invalid()
  return { action: value.action as RecoveryCommand['action'], id: value.id, expectedRevision: value.expectedRevision, reason: value.reason }
}

/** A deliberately small projection: inputs, caller data, lease tokens and provider bodies stay server-side. */
export function workflowSummary(action: WorkflowAction & { revision?: string }, canManage: boolean) {
  if (!revision(action.revision)) throw new WorkflowError('workflow_invalid_record', 'The work queue is temporarily unavailable.')
  return { id: action.id, kind: action.kind, connector: action.connector, state: action.state, phase: action.phase,
    createdAt: action.createdAt, updatedAt: action.updatedAt, availableAt: action.availableAt, completedAt: action.completedAt,
    lastErrorCode: action.lastErrorCode, dispatchAttempts: action.dispatchAttempts, verificationAttempts: action.verificationAttempts,
    maxAttempts: action.maxAttempts, dispatchStarted: action.dispatchStarted, revision: action.revision,
    canReplay: canManage && action.state !== 'running' && action.state !== 'succeeded',
    canCancel: canManage && !action.dispatchStarted && action.state !== 'succeeded' && action.state !== 'cancelled' }
}
