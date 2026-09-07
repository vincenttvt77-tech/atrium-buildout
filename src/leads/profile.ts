import type { LossReason } from '../record/store.ts'

/**
 * One person, across every call they ever make.
 *
 * Keyed by phone number because that is the one identifier a caller cannot fail to give.
 * A prospect who calls three times over a month is one lead with three calls, not three
 * leads — the second call should start from what the first one learned. SOW 4.2 calls this
 * "one person across a portfolio"; SOW 6.3 calls the contents the prospect intelligence
 * record. Every extracted field keeps the words that justified it.
 */

export interface Evidence<T> {
  value: T
  excerpt: string
  callId: string
  at: string
  confidence: number
}

export type LeadStage =
  | 'new'            // called, told us little
  | 'qualified'      // two of timing / bedrooms / budget captured
  | 'tour_scheduled' // a confirmed booking exists
  | 'toured'         // the tour time has passed
  | 'lost'           // a loss reason was recorded and nothing booked
  | 'escalated'      // waiting on a human

export interface CallSummary {
  callId: string
  at: string
  durationSeconds: number | null
  /** What happened, in a phrase the dashboard can show. */
  outcome: string
  toolsCalled: string[]
}

export interface LeadBooking {
  slotId: string
  startsAt: string
  unitId: string | null
  status: 'confirmed' | 'arranging' | 'failed'
  callId: string
}

/**
 * A human pins the caller's name by leaving a note "name: Vincent T." — with or without
 * the timestamp the API stamps on the front. It outranks every later extraction, and
 * the last such note wins.
 */
export function pinnedName(notes: string[]): string | null {
  for (let i = notes.length - 1; i >= 0; i--) {
    const m = /^(?:\S+\s+)?name:\s*(.+)$/i.exec(notes[i] ?? '')
    if (m?.[1]?.trim()) return m[1].trim()
  }
  return null
}

export interface LeadProfile {
  phone: string
  name: string | null
  email: string | null
  firstSeenAt: string
  lastSeenAt: string
  stage: LeadStage
  calls: CallSummary[]
  signals: {
    budget?: Evidence<number>
    bedrooms?: Evidence<number>
    moveIn?: Evidence<{ earliest: string; latest: string | null; said: string }>
    pets?: Evidence<string>
    parking?: Evidence<string>
  }
  unitsDiscussed: string[]
  bookings: LeadBooking[]
  lossReasons: (LossReason & { callId: string })[]
  escalations: { trigger: string; detail: string; callId: string; at: string }[]
  /** Free-text notes a human adds from the dashboard. */
  notes: string[]
}

export function emptyProfile(phone: string, now: Date): LeadProfile {
  return {
    phone, name: null, email: null,
    firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(),
    stage: 'new', calls: [], signals: {}, unitsDiscussed: [],
    bookings: [], lossReasons: [], escalations: [], notes: [],
  }
}

/**
 * Stage is derived, never set by hand, so it cannot drift from the facts underneath it.
 * A profile with a confirmed booking is tour_scheduled whatever anyone typed.
 */
export function deriveStage(p: LeadProfile, now: Date): LeadStage {
  const confirmed = p.bookings.filter((b) => b.status === 'confirmed')
  if (confirmed.some((b) => Date.parse(b.startsAt) < now.getTime())) return 'toured'
  if (confirmed.length > 0) return 'tour_scheduled'
  if (p.escalations.length > 0) return 'escalated'
  if (p.lossReasons.length > 0) return 'lost'
  const core = [p.signals.budget, p.signals.bedrooms, p.signals.moveIn].filter(Boolean).length
  return core >= 2 ? 'qualified' : 'new'
}

/** Normalise so +1 (516) 990-9252, 5169909252 and +15169909252 are one person. */
export function normalisePhone(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return digits ? `+${digits}` : 'unknown'
}
