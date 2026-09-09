import type {
  BookingRequest, BookingIntent, Booking, BookingState, CalendarPort, TourSlot,
} from './types.ts'
import { DEFAULT_TIME_ZONE, validateTimeZone } from '../calendar/time.ts'
import { TourChangeRequiredError } from '../leads/tour-change.ts'

export interface BookOptions {
  now: Date
  maxAttempts?: number
  /** Injected so the flow is deterministic under test. */
  makeIntentId: (req: BookingRequest) => string
}

/**
 * A retry must never produce a second tour on the calendar. Keying on prospect phone plus
 * slot means the same person asking for the same time twice resolves to one booking, which
 * is the duplicate protection SOW 13.3 requires.
 */
export function idempotencyKey(req: BookingRequest): string {
  return [req.propertyId, req.prospectPhone, req.slot.slotId].join('|')
}

export function recordIntent(
  req: BookingRequest, opts: BookOptions,
): BookingIntent {
  return {
    intentId: opts.makeIntentId(req),
    idempotencyKey: idempotencyKey(req),
    request: req,
    createdAt: opts.now,
  }
}

const sameSlot = (a: TourSlot, b: TourSlot) =>
  a.slotId === b.slotId && a.startsAt.getTime() === b.startsAt.getTime() && a.endsAt.getTime() === b.endsAt.getTime()

const normalizedUnit = (unit: string | null | undefined) => unit?.trim().toUpperCase() || null

async function alternativesFor(req: BookingRequest, calendar: CalendarPort): Promise<TourSlot[]> {
  return calendar
    .listSlots(req.propertyId, req.slot.startsAt, new Date(req.slot.startsAt.getTime() + 7 * 86_400_000), req.unitId)
    // A time that just conflicted must not immediately be proposed again, even if
    // the provider still reports general staff availability for that interval.
    .then((slots) => slots.filter((slot) => slot.slotId !== req.slot.slotId
      && slot.startsAt.getTime() !== req.slot.startsAt.getTime()))
    .catch(() => [] as TourSlot[])
}

/**
 * Books a tour and verifies it landed.
 *
 * The order here is the whole point: record locally, write externally, then re-read the
 * external system and compare. The agent may only say "confirmed" when the read-back
 * returns the same slot we asked for. Anything else is "being arranged", because telling a
 * prospect their Saturday tour is confirmed when it is not is how a building loses a lease
 * and its trust in the same afternoon.
 */
export async function bookTour(
  req: BookingRequest, calendar: CalendarPort, opts: BookOptions,
): Promise<Booking> {
  const intent = recordIntent(req, opts)
  const maxAttempts = opts.maxAttempts ?? 3

  let attempts = 0
  let lastError: string | null = null
  let externalId: string | null = null

  while (attempts < maxAttempts) {
    attempts++
    try {
      if (externalId === null) {
        const created = await calendar.createBooking(intent)
        externalId = created.externalId
      }

      const readBack = await calendar.readBooking(externalId)

      if (readBack === null) {
        lastError = 'read-back returned nothing'
        continue
      }

      if (readBack.externalId !== externalId || !sameSlot(readBack.slot, req.slot)
        || (readBack.unitId !== undefined && normalizedUnit(readBack.unitId) !== normalizedUnit(req.unitId))) {
        // The calendar gave us a different time than we asked for. Never paper over this.
        const alternatives = await alternativesFor(req, calendar)
        return {
          intent,
          state: { status: 'slot_taken', alternatives },
          updatedAt: opts.now,
        }
      }

      return {
        intent,
        state: {
          status: 'confirmed',
          externalId: readBack.externalId,
          verifiedAt: opts.now,
          slot: readBack.slot,
        },
        updatedAt: opts.now,
      }
    } catch (err) {
      if (err instanceof TourChangeRequiredError) throw err
      lastError = err instanceof Error ? err.message : String(err)
      // This is a safety pause, not calendar unavailability. Preserve it for the
      // caller-facing handler instead of retrying or offering another tour time.
      if (lastError === 'CALENDAR_INTERACTION_PAUSED') throw err
      if (/taken|conflict|unavailable|already booked/i.test(lastError)) {
        const alternatives = await alternativesFor(req, calendar)
        return { intent, state: { status: 'slot_taken', alternatives }, updatedAt: opts.now }
      }
    }
  }

  const state: BookingState = externalId !== null
    ? { status: 'arranging', externalId, attempts, lastError }
    : { status: 'failed', attempts, lastError: lastError ?? 'unknown', queuedForHuman: true }

  return { intent, state, updatedAt: opts.now }
}

/**
 * What the agent is allowed to say about a booking. Derived from state rather than chosen
 * by the model, so no amount of conversational pressure produces a false confirmation.
 */
export function sayableStatus(booking: Booking, timeZone = DEFAULT_TIME_ZONE): string {
  const zone = validateTimeZone(timeZone)
  const s = booking.state
  const name = booking.intent.request.prospectName
  switch (s.status) {
    case 'confirmed': {
      const when = s.slot.startsAt
      return `You're all set, ${name}. I've got you down for ${when.toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZone: zone,
      })}. Your tour is confirmed.`
    }
    case 'arranging':
      return `I haven't been able to verify that booking yet, ${name}, so it isn't confirmed. The leasing team will need to check it with you.`
    case 'slot_taken':
      return s.alternatives.length > 0
        ? `That time isn't available. I do have ${s.alternatives.slice(0, 3).map((a) => a.startsAt.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone })).join(', or ')}. Would any of those work?`
        : `That time isn't available, and I couldn't find another opening in the dates I checked. Would you like help from the leasing team?`
    case 'failed':
      return `I'm having trouble reaching the calendar right now, ${name}, so I couldn't confirm a tour. The leasing team will need to help arrange a time.`
  }
}
