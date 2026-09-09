import { createHash } from 'node:crypto'
import { canonicalJson } from '../workflows/validation.ts'
import { validateTimeZone } from '../calendar/time.ts'

export type CallPhase = 'open' | 'ending' | 'frozen' | 'complete' | 'needs_review'
export type CallProvenance =
  | { tenantId: string; timeZone: string }
  | { organizationId: string; propertyId: string; channelBindingId: string; channelBindingVersion: number; configurationVersion: number; timeZone: string }
export interface CallToolIdentity { id: string; name: string; argsHash: string }
export interface CallToolIntent extends CallToolIdentity {
  token: string
  acceptedAt: string
  dispatchStartedAt: string | null
  completedAt: string | null
  status: 'admitted' | 'dispatch_started' | 'complete' | 'blocked' | 'needs_review'
  result: string | null
}
export interface CallEndMetadata {
  eventKey: string
  endedAt?: string | null
  startedAt?: string | null
  reportedPhone?: string | null
  durationSeconds?: number | null
}
export interface AcceptedCallEnd {
  eventKey: string
  receivedAt: string
  endedAt: string
  startedAt: string | null
  reportedPhone: string | null
  durationSeconds: number | null
}
/** Stored under CallState.work; it intentionally does not contain working call data. */
export interface CallLifecycle {
  version: 1
  phase: CallPhase
  revision: number
  createdAt: string
  updatedAt: string
  provenance: CallProvenance | null
  end: AcceptedCallEnd | null
  intents: CallToolIntent[]
  frozenRevision: number | null
  completedAt: string | null
}
export interface CallAdmission { token: string; toolIds: string[] }
export interface CallToolResult { toolId: string; result: string; outcome: 'complete' | 'blocked' | 'needs_review' }
export type CallLifecycleErrorCode = 'call_work_invalid' | 'call_work_limit' | 'call_work_busy' | 'call_closed'
  | 'call_tool_identity_conflict' | 'call_admission_stale' | 'call_event_identity_conflict'
  | 'call_provenance_conflict' | 'call_work_unresolved' | 'call_revision_conflict'
export class CallLifecycleError extends Error {
  readonly code: CallLifecycleErrorCode
  constructor(code: CallLifecycleErrorCode) { super(code); this.name = 'CallLifecycleError'; this.code = code }
}
export const CALL_WORK_LIMITS = Object.freeze({ batch: 20, intents: 256, argsBytes: 65_536, resultBytes: 32_768 })
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
const HASH = /^[a-f0-9]{64}$/
const PHASES: CallPhase[] = ['open', 'ending', 'frozen', 'complete', 'needs_review']
function fail(code: CallLifecycleErrorCode = 'call_work_invalid'): never { throw new CallLifecycleError(code) }
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const id = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function detached<T>(value: T): T {
  try { return JSON.parse(canonicalJson(value)) as T } catch { return fail() }
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) fail()
  return parsed.toISOString()
}
function exactKeys(value: unknown, required: string[], optional: string[] = []): void {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail()
}
function command<T>(value: T, required: string[], optional: string[] = []): T {
  const copy = detached(value)
  exactKeys(copy, required, optional)
  return copy
}
function provenance(value: CallProvenance): CallProvenance {
  const copy = detached(value)
  if (!object(copy)) fail()
  try { validateTimeZone(copy.timeZone) } catch { fail() }
  if ('tenantId' in copy) {
    exactKeys(copy, ['tenantId', 'timeZone'])
    if (!id(copy.tenantId)) fail()
  } else {
    exactKeys(copy, ['organizationId', 'propertyId', 'channelBindingId', 'channelBindingVersion', 'configurationVersion', 'timeZone'])
    if (![copy.organizationId, copy.propertyId, copy.channelBindingId].every(id)
      || !integer(copy.channelBindingVersion, 1) || !integer(copy.configurationVersion, 1)) fail()
  }
  return copy
}
function matchProvenance(work: CallLifecycle, value?: CallProvenance): void {
  const incoming = value === undefined ? null : provenance(value)
  if (canonicalJson(work.provenance) !== canonicalJson(incoming)) fail('call_provenance_conflict')
}
const known = (intent: CallToolIntent) => intent.status === 'complete' || intent.status === 'blocked'
function copyWork(value: CallLifecycle): CallLifecycle {
  const work = detached(value)
  if (!object(work)) fail()
  exactKeys(work, ['version', 'phase', 'revision', 'createdAt', 'updatedAt', 'provenance', 'end', 'intents', 'frozenRevision', 'completedAt'])
  if (work.version !== 1 || !PHASES.includes(work.phase) || !integer(work.revision)
    || !Array.isArray(work.intents) || work.intents.length > CALL_WORK_LIMITS.intents) fail()
  timestamp(work.createdAt); timestamp(work.updatedAt)
  if (work.provenance !== null) provenance(work.provenance)
  if (work.end !== null) {
    exactKeys(work.end, ['eventKey', 'receivedAt', 'endedAt', 'startedAt', 'reportedPhone', 'durationSeconds'])
    endMetadata(work.end)
    timestamp(work.end.receivedAt); timestamp(work.end.endedAt)
  }
  const seen = new Set<string>()
  for (const intent of work.intents) {
    if (!object(intent)) fail()
    exactKeys(intent, ['id', 'name', 'argsHash', 'token', 'acceptedAt', 'dispatchStartedAt', 'completedAt', 'status', 'result'])
    identity(intent)
    if (seen.has(intent.id) || !id(intent.token)) fail()
    seen.add(intent.id); timestamp(intent.acceptedAt)
    if (!['admitted', 'dispatch_started', 'complete', 'blocked', 'needs_review'].includes(intent.status)) fail()
    if (intent.dispatchStartedAt !== null) timestamp(intent.dispatchStartedAt)
    if (intent.completedAt !== null) timestamp(intent.completedAt)
    if (intent.result !== null) resultText(intent.result)
    if ((intent.status === 'admitted' && (intent.dispatchStartedAt !== null || intent.completedAt !== null || intent.result !== null))
      || (intent.status === 'dispatch_started' && (intent.dispatchStartedAt === null || intent.completedAt !== null || intent.result !== null))
      || (known(intent) && (intent.completedAt === null || intent.result === null))
      || (intent.status === 'blocked' && intent.dispatchStartedAt !== null)
      || (intent.status === 'needs_review' && (intent.completedAt !== null || intent.result === null))) fail()
  }
  const frozen = work.phase === 'frozen' || work.phase === 'complete'
  if ((frozen && (work.end === null || !work.intents.every(known)))
    || (frozen !== (work.frozenRevision !== null))
    || (work.frozenRevision !== null && (!integer(work.frozenRevision, 1) || work.frozenRevision > work.revision))
    || ((work.phase === 'complete') !== (work.completedAt !== null))
    || ((work.phase === 'needs_review') !== work.intents.some(intent => intent.status === 'needs_review'))
    || (work.phase === 'frozen' && work.frozenRevision !== work.revision)
    || (work.phase === 'complete' && work.revision !== work.frozenRevision! + 1)
    || (work.phase === 'open' && work.end !== null)
    || (work.phase === 'ending' && work.end === null)) fail()
  if (work.completedAt !== null) timestamp(work.completedAt)
  return work
}
function change(work: CallLifecycle, now: string): CallLifecycle {
  if (work.revision >= Number.MAX_SAFE_INTEGER) fail('call_work_limit')
  work.revision++
  work.updatedAt = timestamp(now)
  return detached(work)
}
function identity(value: CallToolIdentity): void {
  if (!object(value) || !id(value.id) || typeof value.name !== 'string' || !NAME.test(value.name)
    || typeof value.argsHash !== 'string' || !HASH.test(value.argsHash)) fail()
}
function resultText(value: unknown): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > CALL_WORK_LIMITS.resultBytes) fail('call_work_limit')
  detached(value)
}
/** Call before hashing model arguments; a digest alone cannot prove input was bounded. */
export function hashCallToolArgs(args: unknown): string {
  let encoded: string
  try { encoded = canonicalJson(args) } catch { return fail() }
  if (!object(args)) fail()
  if (Buffer.byteLength(encoded, 'utf8') > CALL_WORK_LIMITS.argsBytes) fail('call_work_limit')
  return createHash('sha256').update(encoded, 'utf8').digest('hex')
}
export function initializeCallLifecycle(input: { now: string; provenance?: CallProvenance }): CallLifecycle {
  const request = command(input, ['now'], ['provenance']), at = timestamp(request.now)
  return { version: 1, phase: 'open', revision: 0, createdAt: at, updatedAt: at,
    provenance: request.provenance === undefined ? null : provenance(request.provenance), end: null, intents: [], frozenRevision: null, completedAt: null }
}
export function admitToolBatch(value: CallLifecycle, input: { token: string; tools: CallToolIdentity[]; now: string; provenance?: CallProvenance }): {
  work: CallLifecycle; status: 'admitted' | 'cached'; admission: CallAdmission | null; results: CallToolResult[]
} {
  const work = copyWork(value), request = command(input, ['token', 'tools', 'now'], ['provenance'])
  matchProvenance(work, request.provenance); timestamp(request.now)
  if (!id(request.token) || !Array.isArray(request.tools) || !request.tools.length) fail()
  if (request.tools.length > CALL_WORK_LIMITS.batch) fail('call_work_limit')
  const ids = new Set<string>(), fresh: CallToolIdentity[] = [], results: CallToolResult[] = []
  let busy = false
  for (const tool of request.tools) {
    exactKeys(tool, ['id', 'name', 'argsHash']); identity(tool)
    if (ids.has(tool.id)) fail('call_tool_identity_conflict')
    ids.add(tool.id)
    const existing = work.intents.find(intent => intent.id === tool.id)
    if (!existing) { fresh.push(tool); continue }
    if (existing.name !== tool.name || existing.argsHash !== tool.argsHash) fail('call_tool_identity_conflict')
    if (!known(existing)) busy = true
    else results.push({ toolId: tool.id, result: existing.result!, outcome: existing.status as 'complete' | 'blocked' })
  }
  if (busy) fail('call_work_busy')
  // Finished duplicates remain replayable after closure; new work never does.
  if (!fresh.length) return { work, status: 'cached', admission: null, results }
  if (work.phase !== 'open') fail('call_closed')
  if (work.intents.length + fresh.length > CALL_WORK_LIMITS.intents) fail('call_work_limit')
  if (work.intents.some(intent => intent.token === request.token)) fail('call_tool_identity_conflict')
  const at = timestamp(request.now)
  work.intents.push(...fresh.map(tool => ({ ...tool, token: request.token, acceptedAt: at,
    dispatchStartedAt: null, completedAt: null, status: 'admitted' as const, result: null })))
  return { work: change(work, at), status: 'admitted', admission: { token: request.token, toolIds: fresh.map(tool => tool.id) }, results }
}
export function markToolDispatch(value: CallLifecycle, input: { token: string; toolId: string; now: string }): CallLifecycle {
  const work = copyWork(value), request = command(input, ['token', 'toolId', 'now'])
  const at = timestamp(request.now)
  if (!id(request.token) || !id(request.toolId)) fail()
  if (work.phase === 'needs_review') fail('call_work_unresolved')
  const intent = work.intents.find(item => item.id === request.toolId && item.token === request.token)
  if (!intent || intent.status !== 'admitted' || work.phase === 'frozen' || work.phase === 'complete') fail('call_admission_stale')
  intent.dispatchStartedAt = at; intent.status = 'dispatch_started'
  return change(work, at)
}
export function completeToolBatch(value: CallLifecycle, input: { token: string; results: CallToolResult[]; now: string }): CallLifecycle {
  const work = copyWork(value), request = command(input, ['token', 'results', 'now']), at = timestamp(request.now)
  if (!id(request.token) || !Array.isArray(request.results) || !request.results.length) fail()
  if (request.results.length > CALL_WORK_LIMITS.batch) fail('call_work_limit')
  if (work.phase === 'frozen' || work.phase === 'complete') fail('call_admission_stale')
  const ids = new Set<string>()
  for (const result of request.results) {
    exactKeys(result, ['toolId', 'result', 'outcome']); resultText(result.result)
    if (!id(result.toolId) || ids.has(result.toolId) || !['complete', 'blocked', 'needs_review'].includes(result.outcome)) fail()
    ids.add(result.toolId)
    const intent = work.intents.find(item => item.id === result.toolId && item.token === request.token)
    if (!intent || known(intent)) fail('call_admission_stale')
    // 'blocked' is a known no-effect result only before dispatch. A possible write
    // must be verified (complete) or retained for review; never silently cancelled.
    if (result.outcome === 'blocked' && intent.dispatchStartedAt !== null) fail('call_work_unresolved')
    intent.status = result.outcome; intent.result = result.result
    intent.completedAt = result.outcome === 'needs_review' ? null : at
  }
  work.phase = work.intents.some(intent => intent.status === 'needs_review') ? 'needs_review' : work.end ? 'ending' : 'open'
  return change(work, at)
}
function endMetadata(value: CallEndMetadata): Omit<AcceptedCallEnd, 'receivedAt' | 'endedAt'> & { endedAt: string | null } {
  if (!object(value) || !id(value.eventKey)) fail()
  const startedAt = value.startedAt == null ? null : timestamp(value.startedAt)
  const endedAt = value.endedAt == null ? null : timestamp(value.endedAt)
  const phone = value.reportedPhone === 'unknown' || value.reportedPhone == null ? null : value.reportedPhone
  if (phone !== null && (typeof phone !== 'string' || !/^\+?[0-9]{7,15}$/.test(phone))) fail()
  if (startedAt && endedAt && startedAt > endedAt) fail()
  const duration = value.durationSeconds ?? null
  if (duration !== null && (!integer(duration) || duration > 604_800)) fail()
  return { eventKey: value.eventKey, startedAt, endedAt, reportedPhone: phone, durationSeconds: duration }
}
export function requestCallEnd(value: CallLifecycle, input: { now: string; metadata: CallEndMetadata; provenance?: CallProvenance }): CallLifecycle {
  const work = copyWork(value), request = command(input, ['now', 'metadata'], ['provenance']), at = timestamp(request.now)
  matchProvenance(work, request.provenance)
  exactKeys(request.metadata, ['eventKey'], ['endedAt', 'startedAt', 'reportedPhone', 'durationSeconds'])
  const metadata = endMetadata(request.metadata)
  if (work.end) {
    if (metadata.eventKey !== work.end.eventKey) fail('call_event_identity_conflict')
    for (const key of ['endedAt', 'startedAt', 'reportedPhone', 'durationSeconds'] as const) {
      if (metadata[key] !== null && work.end[key] !== null && metadata[key] !== work.end[key]) fail('call_event_identity_conflict')
    }
    return work
  }
  if (work.phase === 'frozen' || work.phase === 'complete') fail('call_closed')
  work.end = { ...metadata, receivedAt: at, endedAt: metadata.endedAt ?? at }
  if (work.phase !== 'needs_review') work.phase = 'ending'
  return change(work, at)
}
/** The store must freeze the working state and insert its receipt/action in this same transaction. */
export function freezeCall(value: CallLifecycle, input: { now: string }): CallLifecycle {
  const work = copyWork(value), request = command(input, ['now'])
  timestamp(request.now)
  if (work.phase === 'frozen' || work.phase === 'complete') return work
  if (!work.end || work.phase !== 'ending' || !work.intents.every(known)) fail('call_work_unresolved')
  work.phase = 'frozen'
  work.frozenRevision = work.revision + 1
  return change(work, request.now)
}
/** Projection and this marker must commit together; a revision from another snapshot cannot complete it. */
export function completeCall(value: CallLifecycle, input: { now: string; frozenRevision: number }): CallLifecycle {
  const work = copyWork(value), request = command(input, ['now', 'frozenRevision']), at = timestamp(request.now)
  if (!integer(request.frozenRevision, 1) || work.frozenRevision !== request.frozenRevision) fail('call_revision_conflict')
  if (work.phase === 'complete') return work
  if (work.phase !== 'frozen') fail('call_work_unresolved')
  work.phase = 'complete'; work.completedAt = at
  return change(work, at)
}
