import type { LeadProfile } from './profile.ts'
import { nyWall, nyInstant } from '../time/ny.ts'

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
  | 'post_tour'         // after the tour, did they like it
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
 * Business-hours clamp in New York: nothing scheduled before 10am or after 6pm local.
 * Offsets come from Intl per instant, so a follow-up derived in September for a December
 * tour is not an hour off.
 */
function withinHours(t: Date): Date {
  const w = nyWall(t)
  if (w.hour >= 10 && w.hour < 18) return t
  if (w.hour < 10) return nyInstant(w.year, w.month, w.day, 10)
  const nextDay = nyWall(new Date(t.getTime() + DAY))
  return nyInstant(nextDay.year, nextDay.month, nextDay.day, 10)
}

const id = (phone: string, kind: string, due: Date) =>
  `fu-${phone.replace(/\D/g, '')}-${kind}-${due.toISOString().slice(0, 13)}`

/**
 * Derives every follow-up this profile should have. Idempotent: the ids are deterministic,
 * so re-running after another call adds what is new and leaves the rest alone.
 */
export function deriveFollowUps(p: LeadProfile, now: Date, fromCall: string): FollowUp[] {
  const out: FollowUp[] = []
  const mk = (kind: FollowUpKind, channel: FollowUp['channel'], dueAt: Date, reason: string): FollowUp => ({
    id: id(p.phone, kind, dueAt), phone: p.phone, kind, channel,
    dueAt: dueAt.toISOString(), reason, status: 'scheduled',
    createdAt: now.toISOString(), createdFromCall: fromCall, executable: false,
  })
  const who = p.name ?? 'the caller'

  for (const b of p.bookings) {
    if (b.status !== 'confirmed') continue
    const tour = new Date(b.startsAt)
    if (tour.getTime() < now.getTime()) {
      // Tour has happened: ask how it went, next business morning.
      out.push(mk('post_tour', 'call', withinHours(new Date(tour.getTime() + 18 * HOUR)),
        `${who} toured${b.unitId ? ` residence ${b.unitId}` : ''} — find out how it went and whether they want to apply.`))
      continue
    }

    // Day-of confirmation, three hours before — "tour at five, call at two".
    const confirmAt = new Date(tour.getTime() - 3 * HOUR)
    if (confirmAt.getTime() > now.getTime() + HOUR) {
      out.push(mk('confirm_tour', 'call', withinHours(confirmAt),
        `Confirm ${who} is still coming at ${tour.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}${b.unitId ? ` to see ${b.unitId}` : ''}.`))
    }

    // Day-before reminder when the tour is far enough out to need one.
    if (tour.getTime() - now.getTime() > DAY + 2 * HOUR) {
      const remindAt = withinHours(new Date(tour.getTime() - DAY))
      out.push(mk('remind_tour', p.email ? 'email' : 'sms', remindAt,
        `Remind ${who} about tomorrow's tour.`))
    }

    if (!p.email) {
      out.push(mk('collect_email', 'call', withinHours(new Date(now.getTime() + 2 * HOUR)),
        `${who} booked a tour but gave no email — the confirmation has nowhere to go.`))
    }
  }

  const escalated = p.escalations.at(-1)
  if (escalated) {
    const urgent = /emergency|accommodation|eligibility/.test(escalated.trigger)
    out.push(mk('callback', 'call', withinHours(new Date(now.getTime() + (urgent ? 2 : 24) * HOUR)),
      `${who} raised something the agent could not handle: ${escalated.detail}. A person needs to call.`))
  }

  const pricedOut = p.lossReasons.find((l) => l.kind === 'priced_out')
  if (pricedOut && p.bookings.length === 0) {
    out.push(mk('priced_out_watch', p.email ? 'email' : 'call', withinHours(new Date(now.getTime() + 14 * DAY)),
      `${who} was priced out (${pricedOut.detail}). Check whether anything in their range has opened, and tell them if so.`))
  }

  const qualified = [p.signals.budget, p.signals.bedrooms, p.signals.moveIn].filter(Boolean).length >= 2
  if (qualified && p.bookings.length === 0 && p.lossReasons.length === 0 && (p.email || p.name)) {
    out.push(mk('nurture', 'call', withinHours(new Date(now.getTime() + 2 * DAY)),
      `${who} was qualified and interested but did not book. Offer a tour again.`))
  }

  return out
}
