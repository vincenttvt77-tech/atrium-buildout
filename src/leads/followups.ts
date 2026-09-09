import type { LeadProfile } from './profile.ts'
import { createHash } from 'node:crypto'
import { DEFAULT_TIME_ZONE, localInstant, validateTimeZone, wallTime } from '../calendar/time.ts'

/**
 * What the building should do next about this person, and when.
 *
 * These are scheduled intentions, not actions. Outbound calling is not enabled — it needs
 * A2P registration and a TCPA review that have not happened — so every follow-up carries
 * executable: false and the dashboard says so. The point for now is that the system shows
 * it knows what to do: a tour booked for tomorrow at five produces a confirmation call at
 * two, without anyone asking it to. SOW 6.2 calls this condition-based follow-up.
 */

export type FollowUpKind =
  | 'confirm_tour'      // day-of, before the tour
  | 'remind_tour'       // day before
  | 'post_tour'         // after the scheduled time, verify attendance before next steps
  | 'priced_out_watch'  // tell them when something in budget opens
  | 'nurture'           // qualified, gave contact, did not book
  | 'callback'          // asked for a person, or was escalated
  | 'collect_email'     // booked but no email, so the confirmation cannot go

export interface FollowUp {
  id: string
  phone: string
  kind: FollowUpKind
  channel: 'call' | 'sms' | 'email'
  dueAt: string
  reason: string
  status: 'scheduled' | 'done' | 'skipped'
  createdAt: string
  createdFromCall: string
  /** Always false until outbound is enabled. The dashboard renders this honestly. */
  executable: false
  /** Stable intent identity; legacy rows keep their IDs when this is reconciled. */
  source?: FollowUpSource
  /** Original work is retained when an old hour-based ID cannot be mapped safely. */
  reconciliation?: { status: 'needs_review'; code: 'legacy_followup_identity_ambiguous'; candidateIds: string[] }
  /** Retained history, never an executable reminder for the old tour time. */
  superseded?: { reason: 'tour_rescheduled'; bookingExternalId: string; revision: number; requestId: string; at: string }
}

export interface FollowUpSource {
  version: 2
  kind: 'call' | 'booking'
  key: string
  callId: string
  at: string
  booking?: { slotId: string; startsAt: string; unitId: string | null; externalId?: string; revision?: number }
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * Legacy follow-up contact window: nothing scheduled before 10am or after 6pm building time.
 * Offsets come from Intl per instant, so a follow-up derived in September for a December
 * tour is not an hour off.
 */
function withinHours(t: Date, timeZone: string): Date {
  const w = wallTime(t, timeZone)
  if (w.hour >= 10 && w.hour < 18) return t
  return localInstant(w.year, w.month, w.day + (w.hour < 10 ? 0 : 1), 10, 0, timeZone)
}

const identity = (p: LeadProfile, fromCall: string) => p.phone === 'unknown'
  ? `anonymous-${encodeURIComponent(p.calls[0]?.callId ?? fromCall)}` : p.phone.replace(/\D/g, '')

/** Only for explicit reconciliation of stored v1 rows; new IDs never use due-hour buckets. */
export const legacyFollowUpId = (p: LeadProfile, f: FollowUp): string =>
  `fu-${identity(p, f.createdFromCall)}-${f.kind}-${f.dueAt.slice(0, 13)}`

export function bookingIdentity(b: { slotId: string; startsAt: string; unitId: string | null }): string {
  return JSON.stringify([b.slotId, new Date(b.startsAt).toISOString(), b.unitId?.trim().toUpperCase() || null])
}

const validAt = (value: unknown, fallback: Date): Date => {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : fallback
  return Number.isFinite(parsed.getTime()) ? parsed : fallback
}

/**
 * Derives every follow-up this profile should have. Idempotent: the ids are deterministic,
 * so re-running after another call adds what is new and leaves the rest alone.
 */
export function deriveFollowUps(p: LeadProfile, now: Date, fromCall: string, timeZone = DEFAULT_TIME_ZONE): FollowUp[] {
  const zone = validateTimeZone(timeZone)
  const duringContactHours = (at: Date) => withinHours(at, zone)
  const out: FollowUp[] = []
  const eventAt = validAt(p.calls.find(c => c.callId === fromCall)?.at, now)
  const callSource = { kind: 'call' as const, callId: fromCall, at: eventAt.toISOString() }
  const mk = (kind: FollowUpKind, channel: FollowUp['channel'], dueAt: Date, reason: string,
    origin: Omit<FollowUpSource, 'version' | 'key'> = callSource): FollowUp => {
    const key = createHash('sha256').update(JSON.stringify([identity(p, fromCall), kind, origin.kind,
      origin.booking ? (origin.booking.externalId && origin.booking.revision
        ? JSON.stringify([origin.booking.externalId, origin.booking.revision]) : bookingIdentity(origin.booking)) : origin.callId])).digest('hex')
    return {
      id: `fu-v2-${key}`, phone: p.phone, kind, channel,
      dueAt: dueAt.toISOString(), reason, status: 'scheduled',
      createdAt: now.toISOString(), createdFromCall: origin.callId, executable: false,
      source: { version: 2, ...origin, key },
    }
  }
  const who = p.name ?? 'the caller'

  for (const b of p.bookings) {
    if (b.status !== 'confirmed') continue
    const bookedAt = validAt(p.calls.find(c => c.callId === b.callId)?.at, eventAt)
    // An older report must not manufacture work for a booking learned on a newer call.
    if (bookedAt.getTime() > eventAt.getTime()) continue
    const bookingSource = { kind: 'booking' as const, callId: b.callId, at: bookedAt.toISOString(),
      booking: { slotId: b.slotId, startsAt: new Date(b.startsAt).toISOString(), unitId: b.unitId?.trim().toUpperCase() || null,
        ...(b.externalId ? { externalId: b.externalId } : {}), ...(b.rescheduleRevision ? { revision: b.rescheduleRevision } : {}) } }
    const tour = new Date(b.startsAt)
    // A delayed original call must not create pre-tour work that was already too
    // late when staff moved this reservation. Keep the original call timestamp intact.
    const referenceNow = new Date(Math.max(now.getTime(), validAt(b.rescheduledAt, now).getTime()))
    // Persist future attendance-check work at booking time: no later call or
    // clock-driven re-derivation is required to make this intention appear.
    out.push(mk('post_tour', 'call', duringContactHours(new Date(tour.getTime() + 18 * HOUR)),
      `${who} was scheduled to tour${b.unitId ? ` residence ${b.unitId}` : ''} — confirm whether they attended before discussing next steps.`, bookingSource))
    if (tour.getTime() < referenceNow.getTime()) {
      // The scheduled time passed; attendance has not been recorded.
      continue
    }

    // Day-of confirmation, three hours before — "tour at five, call at two".
    const confirmAt = duringContactHours(new Date(tour.getTime() - 3 * HOUR))
    if (confirmAt.getTime() > referenceNow.getTime() + HOUR && confirmAt.getTime() < tour.getTime()) {
      out.push(mk('confirm_tour', 'call', confirmAt,
        `Confirm ${who} is still coming at ${tour.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone })}${b.unitId ? ` to see ${b.unitId}` : ''}.`, bookingSource))
    }

    // Day-before reminder when the tour is far enough out to need one.
    if (tour.getTime() - referenceNow.getTime() > DAY + 2 * HOUR) {
      const remindAt = duringContactHours(new Date(tour.getTime() - DAY))
      if (remindAt.getTime() > referenceNow.getTime() && remindAt.getTime() < tour.getTime()) {
        out.push(mk('remind_tour', p.email ? 'email' : 'sms', remindAt,
          `Remind ${who} about tomorrow's tour.`, bookingSource))
      }
    }

    if (!p.email) {
      out.push(mk('collect_email', 'call', duringContactHours(new Date(bookedAt.getTime() + 2 * HOUR)),
        `${who} booked a tour but gave no email — the confirmation has nowhere to go.`, bookingSource))
    }
  }

  // A current-call emergency outranks another ordinary escalation appended later.
  // Do not make historical emergency records urgent again on unrelated calls.
  const currentEscalations = p.escalations.filter(e => e.callId === fromCall || (!e.callId && p.calls.length === 0))
  const currentEmergency = currentEscalations.findLast(e => e.trigger === 'emergency')
  // Tour changes have their own durable staff request. Keep unrelated human
  // review work, including emergencies, even if a tour-change signal came last.
  const escalated = currentEmergency ?? currentEscalations.findLast(e => e.trigger !== 'tour_change')
  if (escalated) {
    if (escalated.trigger === 'emergency') {
      if (!escalated.callId || escalated.callId === fromCall) {
        out.push(mk('callback', 'call', eventAt,
          `Emergency reported by ${who}: ${escalated.detail}. Immediate staff review is required. No automatic notification has been sent; follow the building's emergency protocol.`))
      }
    } else {
      const urgent = /accommodation|eligibility/.test(escalated.trigger)
      out.push(mk('callback', 'call', duringContactHours(new Date(eventAt.getTime() + (urgent ? 2 : 24) * HOUR)),
        `${who} raised something the agent could not handle: ${escalated.detail}. A person needs to call.`))
    }
  }

  const pricedOut = p.lossReasons.findLast((l) => l.kind === 'priced_out' && l.callId === fromCall)
  if (pricedOut && p.bookings.length === 0) {
    out.push(mk('priced_out_watch', p.email ? 'email' : 'call', duringContactHours(new Date(eventAt.getTime() + 14 * DAY)),
      `${who} was priced out (${pricedOut.detail}). Check whether anything in their range has opened, and tell them if so.`))
  }

  const coreSignals = [p.signals.budgetRange ?? p.signals.budget, p.signals.bedrooms, p.signals.moveIn].filter(Boolean)
  const qualified = coreSignals.length >= 2 && coreSignals.some(signal => signal?.callId === fromCall)
  if (qualified && p.bookings.length === 0 && p.lossReasons.length === 0 && (p.email || p.name)) {
    out.push(mk('nurture', 'call', duringContactHours(new Date(eventAt.getTime() + 2 * DAY)),
      `${who} was qualified and interested but did not book. Offer a tour again.`))
  }

  return out
}
