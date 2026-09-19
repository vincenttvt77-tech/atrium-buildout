import type { EmergencySignal } from '../../escalation/emergency.ts'
import type { AttemptRecord, EmergencyContact } from './policy.ts'
import type { AlertMessage, AlertResult } from './transport.ts'

/** What an escalation and its attempts look like in storage, as a port. */

export interface EmergencyScope {
  readonly organizationId: string
  readonly propertyId: string
}

export type EscalationStatus = 'open' | 'acknowledged' | 'exhausted'

export interface EscalationRecord extends EmergencyScope {
  readonly id: string
  readonly signal: EmergencySignal
  readonly unitLabel: string | null
  readonly callerNumber: string | null
  readonly instruction: string
  readonly instructionSource: 'property' | 'default'
  readonly openedAtMs: number
  readonly status: EscalationStatus
  readonly acknowledgedAtMs: number | null
  readonly acknowledgedBy: string | null
}

export interface StoredAttempt extends AttemptRecord {
  readonly escalationId: string
  readonly contactName: string
  readonly channel: AlertMessage['channel']
  readonly address: string
  readonly subject: string
  readonly body: string
  readonly detail: string
  readonly reference: string | null
  /** False for a stand-in transport. A screen must not present a recorded alert as a sent one. */
  readonly delivered: boolean
}

export interface EmergencyStore {
  contacts(scope: EmergencyScope): Promise<EmergencyContact[]>
  open(record: Omit<EscalationRecord, 'status' | 'acknowledgedAtMs' | 'acknowledgedBy'>): Promise<EscalationRecord>
  get(id: string): Promise<EscalationRecord | null>
  attempts(id: string): Promise<StoredAttempt[]>
  recordAttempt(attempt: StoredAttempt): Promise<void>
  setStatus(id: string, status: EscalationStatus): Promise<void>
  /** False when it was already acknowledged, so a second confirmation cannot rewrite the first. */
  acknowledge(id: string, by: string, atMs: number): Promise<boolean>
  listOpen(scope: EmergencyScope, limit: number): Promise<EscalationRecord[]>
}

export interface AttemptOutcomeInput {
  readonly message: AlertMessage
  readonly result: AlertResult
  readonly delivers: boolean
}
