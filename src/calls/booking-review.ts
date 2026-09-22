import type { DocumentStore } from '../store/documents.ts'
import type { Evidence } from '../leads/profile.ts'
import type { CalendarBookingReviewResolution } from '../calendar/types.ts'
import { validateBookingReviewAttempt, validateBookingReviewResolution } from '../calendar/booking-review.ts'
import { CalendarActionError } from '../calendar/unit-blocks.ts'
import { canonicalJson } from '../workflows/validation.ts'

/** Separate from finished-call projection so an uncertain booking never hides staff work. */
export interface BookingReview {
  version: 1
  id: string
  kind: 'booking_review'
  durable: true
  callId: string
  at: string
  updatedAt: string
  sourceRevision: number
  phone: string | null
  name: string | null
  email: string | null
  callbackPhone: Evidence<string> | null
  booking: { slotId: string; startsAt: string; endsAt?: string; externalId?: string; unitId: string | null; status: 'arranging' } | null
  needsReview: boolean
  notificationStatus: 'not_sent'
  /** Immutable staff observation; the calendar holds authoritative projection completion. */
  resolution?: CalendarBookingReviewResolution
}

const PREFIX = 'booking-review:'
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
function bounded(value: string | null | undefined, length: number): string | null {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length) || null : null
}
const fail = (code: string, message: string): never => { throw new CalendarActionError(code, message, 409) }
const resolutionIdentity = (value: CalendarBookingReviewResolution): string => {
  const { projection: _projection, ...receipt } = validateBookingReviewResolution(value)
  return canonicalJson(receipt)
}
function validate(record: BookingReview, callId: string): BookingReview {
  if (!record || record.version !== 1 || record.id !== PREFIX + callId || record.callId !== callId
    || !validId(callId) || record.kind !== 'booking_review' || record.durable !== true
    || typeof record.needsReview !== 'boolean' || record.notificationStatus !== 'not_sent'
    || !Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 0
    || !instant(record.at) || !instant(record.updatedAt) || record.updatedAt < record.at
    || ![record.phone, record.name, record.email].every(value => value === null || typeof value === 'string')) {
    throw new Error('Invalid booking review record')
  }
  const booking = record.booking
  if (booking !== null && (!booking || booking.status !== 'arranging' || typeof booking.slotId !== 'string'
    || !/^slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(booking.slotId) || !instant(booking.startsAt)
    || booking.startsAt !== `${booking.slotId.slice(5)}:00.000Z`
    || (booking.unitId !== null && (typeof booking.unitId !== 'string' || !booking.unitId.trim() || booking.unitId.length > 128))
    || (booking.endsAt !== undefined && (!instant(booking.endsAt) || booking.endsAt <= booking.startsAt))
    || (booking.externalId !== undefined && (typeof booking.externalId !== 'string' || !booking.externalId.trim()
      || booking.externalId.length > 1024 || /[\u0000-\u001f\u007f]/.test(booking.externalId))))) {
    throw new Error('Invalid booking review attempt')
  }
  if (record.callbackPhone !== null && (!record.callbackPhone || typeof record.callbackPhone.value !== 'string'
    || !record.callbackPhone.value.trim() || record.callbackPhone.callId !== callId
    || typeof record.callbackPhone.excerpt !== 'string' || !instant(record.callbackPhone.at)
    || !Number.isFinite(record.callbackPhone.confidence) || record.callbackPhone.confidence < 0 || record.callbackPhone.confidence > 1)) {
    throw new Error('Invalid booking review callback evidence')
  }
  if (record.resolution !== undefined) {
    const resolution = validateBookingReviewResolution(record.resolution)
    if (record.needsReview || resolution.callId !== callId || resolution.sourceRevision !== record.sourceRevision
      || !booking || canonicalJson(validateBookingReviewAttempt({ ...booking, externalId: booking.externalId!, endsAt: booking.endsAt! }))
        !== canonicalJson(resolution.attempt)) throw new Error('Invalid booking review resolution')
  } else if (!record.needsReview) throw new Error('A closed booking review needs a durable resolution')
  return record
}

function mergeAttempt(current: BookingReview['booking'], incoming: BookingReview['booking']): BookingReview['booking'] {
  if (!current) return incoming
  if (!incoming) return current
  if (current.slotId !== incoming.slotId || current.startsAt !== incoming.startsAt
    || current.unitId?.trim().toUpperCase() !== incoming.unitId?.trim().toUpperCase()
    || (current.externalId !== undefined && incoming.externalId !== undefined && current.externalId !== incoming.externalId)
    || (current.endsAt !== undefined && incoming.endsAt !== undefined && current.endsAt !== incoming.endsAt)) {
    return fail('booking_review_attempt_conflict', 'This call has conflicting booking evidence. Staff must inspect it before resolving the review.')
  }
  return { ...current, ...(incoming.endsAt !== undefined ? { endsAt: incoming.endsAt } : {}),
    ...(incoming.externalId !== undefined ? { externalId: incoming.externalId } : {}) }
}

export async function recordBookingReview(store: DocumentStore, input: {
  callId: string; now: Date; phone?: string; name: string | null; email: string | null
  callbackPhone?: Evidence<string>
  work?: { revision: number }
  booking: { slotId: string; startsAt: string; endsAt?: string; externalId?: string; unitId: string | null; status: string } | null
}): Promise<BookingReview> {
  if (!validId(input.callId)) throw new Error('Invalid booking review identity')
  const at = input.now.toISOString()
  const initial: BookingReview = { version: 1, id: PREFIX + input.callId, kind: 'booking_review', durable: true,
    callId: input.callId, at, updatedAt: at, sourceRevision: input.work?.revision ?? 0, phone: bounded(input.phone, 64),
    name: bounded(input.name, 120), email: bounded(input.email, 254),
    callbackPhone: input.callbackPhone ? structuredClone(input.callbackPhone) : null,
    booking: input.booking ? { slotId: input.booking.slotId, startsAt: input.booking.startsAt,
      ...(input.booking.endsAt !== undefined ? { endsAt: input.booking.endsAt } : {}),
      ...(input.booking.externalId !== undefined ? { externalId: input.booking.externalId } : {}),
      unitId: input.booking.unitId, status: 'arranging' } : null,
    needsReview: true, notificationStatus: 'not_sent' }
  validate(initial, input.callId)
  return store.update(initial.id, initial, stored => {
    const current = validate(stored, input.callId)
    // The resolution is a permanent tombstone. Even a delayed caller projection
    // with a higher lifecycle revision cannot reopen it or change its evidence.
    if (current.resolution || current.sourceRevision > initial.sourceRevision) return current
    const callbackPhone = initial.callbackPhone && (!current.callbackPhone || initial.callbackPhone.at >= current.callbackPhone.at)
      ? initial.callbackPhone : current.callbackPhone
    return { ...current, sourceRevision: initial.sourceRevision, updatedAt: at > current.updatedAt ? at : current.updatedAt,
      phone: current.phone ?? initial.phone, name: initial.name ?? current.name, email: initial.email ?? current.email,
      callbackPhone, booking: mergeAttempt(current.booking, initial.booking) }
  })
}

export async function getBookingReview(store: DocumentStore, callId: string): Promise<BookingReview | null> {
  if (!validId(callId)) throw new Error('Invalid booking review identity')
  const value = await store.get<BookingReview>(PREFIX + callId)
  return value === null ? null : validate(value, callId)
}

/** Close only an existing exact-version review with already-persisted calendar evidence. */
export async function resolveBookingReviewRecord(store: DocumentStore, input: {
  callId: string; sourceRevision: number; resolution: CalendarBookingReviewResolution; now: Date
}): Promise<BookingReview> {
  if (!validId(input.callId) || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0) {
    return fail('booking_review_revision_conflict', 'Reload this review before resolving it.')
  }
  const resolution = validateBookingReviewResolution(input.resolution), at = input.now.toISOString()
  if (resolution.callId !== input.callId || resolution.sourceRevision !== input.sourceRevision) {
    return fail('booking_review_receipt_conflict', 'The saved calendar review does not match this call revision.')
  }
  const result = await store.update<BookingReview | null>(PREFIX + input.callId, null, stored => {
    if (!stored) return fail('booking_review_missing', 'This saved review is unavailable. Reload before proceeding.')
    const current = validate(stored, input.callId)
    if (current.resolution) {
      if (resolutionIdentity(current.resolution) !== resolutionIdentity(resolution)) {
        return fail('booking_review_receipt_conflict', 'This review was resolved with different calendar evidence. Refresh before proceeding.')
      }
      if (current.resolution.projection === 'complete' || resolution.projection === 'pending') return current
      return { ...current, resolution, updatedAt: at > current.updatedAt ? at : current.updatedAt }
    }
    if (current.sourceRevision !== input.sourceRevision) return fail('booking_review_revision_conflict', 'This review changed in another request. Reload it before continuing.')
    if (!current.booking || canonicalJson(validateBookingReviewAttempt({ ...current.booking,
      externalId: current.booking.externalId!, endsAt: current.booking.endsAt! })) !== canonicalJson(resolution.attempt)) {
      return fail('booking_review_attempt_conflict', 'The calendar evidence does not match the saved booking attempt.')
    }
    return validate({ ...current, needsReview: false, resolution, updatedAt: at > current.updatedAt ? at : current.updatedAt }, input.callId)
  })
  return result!
}

export async function listBookingReviews(store: DocumentStore): Promise<BookingReview[]> {
  const records: BookingReview[] = []
  for (const key of await store.list(PREFIX)) {
    const value = await store.get<BookingReview>(key)
    if (!value || value.id !== key) throw new Error('Saved booking review is unavailable')
    records.push(validate(value, key.slice(PREFIX.length)))
  }
  return records.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}
