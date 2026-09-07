import type { PropertyId, InteractionId } from '../domain/ids.ts'
import type { QualificationState } from '../leasing/qualification.ts'
import type { Escalation } from '../escalation/escalate.ts'
import type { Booking } from '../booking/types.ts'

/**
 * The shared operational record. Everything that happened on a call lands here, which is
 * what makes the owner dashboard possible and what SOW 4.2 means by auditability: every
 * action resolves to organization, property, person and workflow, with its trigger and
 * timestamp retained.
 */

export type LossReasonKind =
  | 'priced_out' | 'timing_mismatch' | 'no_availability' | 'bedroom_mismatch'
  | 'pets' | 'parking' | 'policy' | 'competitor' | 'application_friction'
  | 'feature_missing' | 'went_quiet' | 'not_qualified'

export interface LossReason {
  kind: LossReasonKind
  /** The specific, countable detail — "$800 over stated ceiling", not "too expensive". */
  detail: string
  /** The words the prospect actually said. SOW 6.2 requires evidence-linked conclusions. */
  evidence: string
  confidence: number
  at: Date
}

export type RecordEvent =
  | { kind: 'call_started'; at: Date; callerNumber: string | null }
  | { kind: 'call_ended'; at: Date; durationSeconds: number }
  | { kind: 'turn'; at: Date; speaker: 'caller' | 'agent'; text: string }
  | { kind: 'signal_captured'; at: Date; signal: string; value: string; excerpt: string; confidence: number }
  | { kind: 'quote_gate'; at: Date; allowed: boolean; captured: string[]; missing: string[] }
  | { kind: 'availability_checked'; at: Date; outcome: string; unitsOffered: string[] }
  | { kind: 'question_answered'; at: Date; question: string; topic: string; decision: string; sources: string[] }
  | { kind: 'question_refused'; at: Date; question: string; reason: string }
  | { kind: 'tour_booked'; at: Date; status: string; slot: string; unitId: string | null }
  | { kind: 'escalated'; at: Date; trigger: string; priority: string }
  | { kind: 'emergency'; at: Date; emergencyKind: string; instructionGiven: string }
  | { kind: 'loss_reason'; at: Date; reason: LossReason }

export interface InteractionRecord {
  interactionId: InteractionId
  propertyId: PropertyId
  channel: 'voice' | 'sms' | 'web'
  callerNumber: string | null
  prospectName: string | null
  startedAt: Date
  endedAt: Date | null
  events: RecordEvent[]
  qualification: QualificationState
  booking: Booking | null
  escalations: Escalation[]
  lossReason: LossReason | null
}

export interface RecordStore {
  create(record: InteractionRecord): Promise<void>
  get(id: InteractionId): Promise<InteractionRecord | null>
  append(id: InteractionId, event: RecordEvent): Promise<void>
  update(id: InteractionId, patch: Partial<InteractionRecord>): Promise<void>
  list(propertyId: PropertyId, limit?: number): Promise<InteractionRecord[]>
}

/**
 * In-process store. Sufficient for a demo where calls and dashboard views happen in the
 * same warm instance; loses data when the instance recycles. KvStore is the drop-in
 * replacement once a KV URL is configured — see src/record/kv.ts.
 */
export class MemoryStore implements RecordStore {
  private records = new Map<string, InteractionRecord>()

  async create(record: InteractionRecord): Promise<void> {
    this.records.set(record.interactionId, record)
  }

  async get(id: InteractionId): Promise<InteractionRecord | null> {
    return this.records.get(id) ?? null
  }

  async append(id: InteractionId, event: RecordEvent): Promise<void> {
    const r = this.records.get(id)
    if (!r) return
    r.events.push(event)
  }

  async update(id: InteractionId, patch: Partial<InteractionRecord>): Promise<void> {
    const r = this.records.get(id)
    if (!r) return
    this.records.set(id, { ...r, ...patch })
  }

  async list(propertyId: PropertyId, limit = 100): Promise<InteractionRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.propertyId === propertyId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit)
  }
}
