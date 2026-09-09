import type { LeadProfile } from './profile.ts'
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

const id = (identity: string, kind: string, due: Date) =>
  `fu-${identity}-${kind}-${due.toISOString().slice(0, 13)}`

/**
 * Derives every follow-up this profile should have. Idempotent: the ids are deterministic,
 * so re-running after another call adds what is new and leaves the rest alone.
 */
export function deriveFollowUps(p: LeadProfile, now: Date, fromCall: string, timeZone = DEFAULT_TIME_ZONE): FollowUp[] {
  const zone = validateTimeZone(timeZone)
  const duringContactHours = (at: Date) => withinHours(at, zone)
  const out: FollowUp[] = []
  // Withheld numbers are separate callers. Stripping "unknown" down to no digits
  // made their same-hour callbacks overwrite each other in the follow-up queue.
  const identity = p.phone === 'unknown'
    ? `anonymous-${encodeURIComponent(p.calls[0]?.callId ?? fromCall)}`
    : p.phone.replace(/\D/g, '')
  const mk = (kind: FollowUpKind, channel: FollowUp['channel'], dueAt: Date, reason: string): FollowUp => ({
    id: id(identity, kind, dueAt), phone: p.phone, kind, channel,
    dueAt: dueAt.toISOString(), reason, status: 'scheduled',
    createdAt: now.toISOString(), createdFromCall: fromCall, executable: false,
  })
  const who = p.name ?? 'the caller'

  for (const b of p.bookings) {
    if (b.status !== 'confirmed') continue
    const tour = new Date(b.startsAt)
    if (tour.getTime() < now.getTime()) {
      // The scheduled time passed; attendance has not been recorded.
      out.push(mk('post_tour', 'call', duringContactHours(new Date(tour.getTime() + 18 * HOUR)),
        `${who} was scheduled to tour${b.unitId ? ` residence ${b.unitId}` : ''} — confirm whether they attended before discussing next steps.`))
      continue
    }

    // Day-of confirmation, three hours before — "tour at five, call at two".
    const confirmAt = new Date(tour.getTime() - 3 * HOUR)
    if (confirmAt.getTime() > now.getTime() + HOUR) {
      out.push(mk('confirm_tour', 'call', duringContactHours(confirmAt),
        `Confirm ${who} is still coming at ${tour.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone })}${b.unitId ? ` to see ${b.unitId}` : ''}.`))
    }

    // Day-before reminder when the tour is far enough out to need one.
    if (tour.getTime() - now.getTime() > DAY + 2 * HOUR) {
      const remindAt = duringContactHours(new Date(tour.getTime() - DAY))
      out.push(mk('remind_tour', p.email ? 'email' : 'sms', remindAt,
        `Remind ${who} about tomorrow's tour.`))
    }

    if (!p.email) {
      out.push(mk('collect_email', 'call', duringContactHours(new Date(now.getTime() + 2 * HOUR)),
        `${who} booked a tour but gave no email — the confirmation has nowhere to go.`))
    }
  }

  // A current-call emergency outranks another ordinary escalation appended later.
  // Do not make historical emergency records urgent again on unrelated calls.
  const currentEmergency = p.escalations.findLast(e => e.trigger === 'emergency' && e.callId === fromCall)
  const escalated = currentEmergency ?? p.escalations.at(-1)
  if (escalated) {
    if (escalated.trigger === 'emergency') {
      if (!escalated.callId || escalated.callId === fromCall) {
        out.push(mk('callback', 'call', now,
          `Emergency reported by ${who}: ${escalated.detail}. Immediate staff review is required. No automatic notification has been sent; follow the building's emergency protocol.`))
      }
    } else {
      const urgent = /accommodation|eligibility/.test(escalated.trigger)
      out.push(mk('callback', 'call', duringContactHours(new Date(now.getTime() + (urgent ? 2 : 24) * HOUR)),
        `${who} raised something the agent could not handle: ${escalated.detail}. A person needs to call.`))
    }
  }

  const pricedOut = p.lossReasons.find((l) => l.kind === 'priced_out')
  if (pricedOut && p.bookings.length === 0) {
    out.push(mk('priced_out_watch', p.email ? 'email' : 'call', duringContactHours(new Date(now.getTime() + 14 * DAY)),
      `${who} was priced out (${pricedOut.detail}). Check whether anything in their range has opened, and tell them if so.`))
  }

  const qualified = [p.signals.budget, p.signals.bedrooms, p.signals.moveIn].filter(Boolean).length >= 2
  if (qualified && p.bookings.length === 0 && p.lossReasons.length === 0 && (p.email || p.name)) {
    out.push(mk('nurture', 'call', duringContactHours(new Date(now.getTime() + 2 * DAY)),
      `${who} was qualified and interested but did not book. Offer a tour again.`))
  }

  return out
}
