import type { DocumentStore } from '../store/documents.ts'
import { consolidateCall, type CallOutcome } from './consolidate.ts'
import { propertyTimeZone } from '../config/property.ts'
import { validateTimeZone } from '../calendar/time.ts'

type StoredOutcome = Omit<CallOutcome, 'at'> & { at: string }
export interface CallReceiptScope {
  organizationId: string
  propertyId: string
  channelBindingId: string
  configurationVersion: number
  timeZone: string
}
export interface CallReceipt {
  version: 1
  callId: string
  status: 'pending' | 'complete'
  attempts: number
  receivedAt: string
  updatedAt: string
  completedAt: string | null
  lastErrorCode: 'consolidation_failed' | null
  /** Server-resolved once before projection; retained so retries keep the same local schedule. */
  timeZone?: string
  /** Server-resolved routing metadata, never copied from provider tool arguments. */
  scope?: Omit<CallReceiptScope, 'timeZone'>
  outcome: StoredOutcome | null
}

export const receiptKey = (callId: string) => `call-receipt:${callId}`

function validateScope(scope: CallReceiptScope | undefined, store: DocumentStore): void {
  if (!scope) {
    if (store.describe().kind === 'postgres') throw new Error('A property scope is required for database call receipts')
    return
  }
  if (![scope.organizationId, scope.propertyId, scope.channelBindingId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    || !Number.isSafeInteger(scope.configurationVersion) || scope.configurationVersion < 1) throw new Error('Invalid call receipt scope')
  validateTimeZone(scope.timeZone)
}

function matchScope(receipt: CallReceipt, expected: CallReceiptScope | undefined): void {
  if (!expected) {
    if (receipt.scope) throw new Error('A scoped call receipt requires its current property authority')
    return
  }
  if (!receipt.scope || receipt.scope.organizationId !== expected.organizationId
    || receipt.scope.propertyId !== expected.propertyId || receipt.scope.channelBindingId !== expected.channelBindingId
    || !receipt.timeZone) throw new Error('Call receipt routing does not match the current property authority')
}

function restore(outcome: StoredOutcome): CallOutcome {
  const qualification = structuredClone(outcome.qualification)
  if (qualification.moveInTiming) {
    qualification.moveInTiming.value.earliest = new Date(qualification.moveInTiming.value.earliest)
    if (qualification.moveInTiming.value.latest) qualification.moveInTiming.value.latest = new Date(qualification.moveInTiming.value.latest)
  }
  return { ...outcome, at: new Date(outcome.at), qualification }
}

/**
 * Accept a finished call before projection writes. A durable receipt makes interrupted
 * profile/follow-up work discoverable and replayable with the original event timestamp.
 * Transport must not acknowledge success when this rejects. A queue worker can call the
 * same replay function; this module does not claim to schedule one.
 */
export async function receiveFinishedCall(store: DocumentStore, outcome: CallOutcome, now = new Date(), scope?: CallReceiptScope): Promise<CallReceipt> {
  validateScope(scope, store)
  const at = now.toISOString()
  const initial: CallReceipt = {
    version: 1, callId: outcome.callId, status: 'pending', attempts: 0,
    receivedAt: at, updatedAt: at, completedAt: null, lastErrorCode: null,
    outcome: { ...outcome, at: outcome.at.toISOString() },
    ...(scope ? { timeZone: scope.timeZone, scope: { organizationId: scope.organizationId, propertyId: scope.propertyId,
      channelBindingId: scope.channelBindingId, configurationVersion: scope.configurationVersion } } : {}),
  }
  await store.update(receiptKey(outcome.callId), initial, current => { matchScope(current, scope); return current })
  return replayFinishedCall(store, outcome.callId, now, scope)
}

/** Idempotent projections let a duplicate delivery safely finish a partially applied job. */
export async function replayFinishedCall(store: DocumentStore, callId: string, now = new Date(), scope?: CallReceiptScope): Promise<CallReceipt> {
  validateScope(scope, store)
  const key = receiptKey(callId)
  const receipt = await store.get<CallReceipt>(key)
  if (!receipt || receipt.version !== 1 || receipt.callId !== callId) throw new Error('Finished-call receipt is missing or invalid')
  matchScope(receipt, scope)
  if (receipt.status === 'complete') return receipt
  if (!receipt.outcome) throw new Error('Pending finished-call receipt has no outcome')
  const at = now.toISOString()
  try {
    // Scoped receipts retain the property timezone accepted with the event. Only the
    // explicit legacy adapter can resolve an old receipt through the bundled property.
    const timeZone = receipt.timeZone === undefined ? propertyTimeZone() : validateTimeZone(receipt.timeZone)
    const attempt = await store.update(key, receipt, current => current.status === 'complete' ? current : {
      ...current, timeZone: current.timeZone ?? timeZone, attempts: current.attempts + 1, updatedAt: at,
    })
    if (attempt.status === 'complete') return attempt
    await consolidateCall(store, restore(receipt.outcome), validateTimeZone(attempt.timeZone))
    // Keep a compact completion receipt, not another permanent copy of prospect details.
    return await store.update<CallReceipt>(key, receipt, current => ({ ...current, status: 'complete', completedAt: at, updatedAt: at, lastErrorCode: null, outcome: null }))
  } catch (error) {
    await store.update<CallReceipt>(key, receipt, current => current.status === 'complete' ? current : { ...current, updatedAt: at, lastErrorCode: 'consolidation_failed' }).catch(() => undefined)
    throw error
  }
}
