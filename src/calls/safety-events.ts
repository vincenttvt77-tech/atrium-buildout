import type { DocumentStore } from '../store/documents.ts'
import { primaryEmergency, type EmergencyKind, type EmergencySignal } from '../escalation/emergency.ts'

const PREFIX = 'call-safety:'
const KINDS: readonly EmergencyKind[] = ['gas', 'smoke_or_fire', 'carbon_monoxide', 'flooding', 'no_heat', 'injury', 'intruder', 'structural']
const LIFE_SAFETY: readonly EmergencyKind[] = ['gas', 'smoke_or_fire', 'carbon_monoxide', 'injury', 'intruder']

/** Independent of call completion: late safety evidence must survive a frozen projection. */
export interface CallSafetyEvent {
  version: 1
  id: string
  callId: string
  firstReportedAt: string
  signal: EmergencySignal
  phone: string | null
  name: string | null
  notificationStatus: 'not_sent'
  needsReview: true
}

function callIdentity(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /[\ud800-\udfff]/u.test(value)) throw new Error('Invalid call safety identity')
  return value
}

/** Bound optional provider text without making oversized contact fields block safety capture. */
function text(value: string | null | undefined, limit: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('Invalid call safety text')
  return [...value.replace(/[\ud800-\udfff]/gu, '\ufffd').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim()].slice(0, limit).join('') || null
}

function signalCopy(signal: EmergencySignal): EmergencySignal {
  if (!signal || !KINDS.includes(signal.kind) || typeof signal.callEmergencyServices !== 'boolean'
    || signal.callEmergencyServices !== LIFE_SAFETY.includes(signal.kind)) throw new Error('Invalid call safety signal')
  const matched = text(signal.matched, 1000)
  if (!matched) throw new Error('Invalid call safety signal')
  return { kind: signal.kind, matched, callEmergencyServices: signal.callEmergencyServices }
}

function validateStored(record: CallSafetyEvent, expectedCallId?: string): CallSafetyEvent {
  if (!record || record.version !== 1 || record.notificationStatus !== 'not_sent' || record.needsReview !== true)
    throw new Error('Invalid stored call safety event')
  const callId = callIdentity(record.callId)
  if ((expectedCallId !== undefined && callId !== expectedCallId) || record.id !== PREFIX + callId
    || typeof record.firstReportedAt !== 'string' || !Number.isFinite(Date.parse(record.firstReportedAt)))
    throw new Error('Invalid stored call safety event')
  const signal = signalCopy(record.signal)
  if (signal.matched !== record.signal.matched || text(record.phone, 64) !== record.phone || text(record.name, 120) !== record.name)
    throw new Error('Invalid stored call safety event')
  return { version: 1, id: record.id, callId, firstReportedAt: record.firstReportedAt, signal,
    phone: record.phone, name: record.name, notificationStatus: 'not_sent', needsReview: true }
}

/**
 * The supplied store owns the authorized property/tenant scope. A single CAS record per
 * call survives retries, cold starts and frozen call-state snapshots. This saves evidence;
 * it does not send a notification, create a lead or alter the calendar's emergency hold.
 * Transport must not acknowledge persistence when this operation rejects.
 */
export async function recordCallSafetyEvent(store: DocumentStore, input: {
  callId: string; signal: EmergencySignal; at: Date; phone?: string | null; name?: string | null
}): Promise<CallSafetyEvent> {
  const callId = callIdentity(input.callId)
  const signal = signalCopy(input.signal)
  const initial: CallSafetyEvent = {
    version: 1, id: PREFIX + callId, callId, firstReportedAt: input.at.toISOString(), signal,
    phone: text(input.phone, 64), name: text(input.name, 120), notificationStatus: 'not_sent', needsReview: true,
  }
  return store.update(initial.id, initial, stored => {
    const current = validateStored(stored, callId)
    return { ...current, signal: primaryEmergency([current.signal, signal])!,
      phone: current.phone ?? initial.phone, name: current.name ?? initial.name }
  })
}

/** Fail visibly on an unreadable incident; an empty successful list would hide safety work. */
export async function listCallSafetyEvents(store: DocumentStore): Promise<CallSafetyEvent[]> {
  const records: CallSafetyEvent[] = []
  for (const key of await store.list(PREFIX)) {
    const value = await store.get<CallSafetyEvent>(key)
    if (!value || value.id !== key) throw new Error('Stored call safety event is missing or invalid')
    records.push(validateStored(value))
  }
  return records.sort((a, b) => Date.parse(b.firstReportedAt) - Date.parse(a.firstReportedAt) || a.id.localeCompare(b.id))
}

/** Only expose this projection through the existing authorized operator response. */
export function safetyEventForOps(record: CallSafetyEvent) {
  const event = validateStored(record)
  return { id: event.id, kind: 'emergency' as const, durable: true as const, callId: event.callId,
    at: event.firstReportedAt, emergencyKind: event.signal.kind, matched: event.signal.matched,
    notificationStatus: event.notificationStatus, needsReview: event.needsReview, phone: event.phone, name: event.name }
}
