import type { DocumentStore } from '../store/documents.ts'
import type { Evidence } from '../leads/profile.ts'

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
  booking: { slotId: string; startsAt: string; unitId: string | null; status: 'arranging' } | null
  needsReview: true
  notificationStatus: 'not_sent'
}

const PREFIX = 'booking-review:'
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)
function bounded(value: string | null | undefined, length: number): string | null {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length) || null : null
}
function validate(record: BookingReview, callId: string): BookingReview {
  if (!record || record.version !== 1 || record.id !== PREFIX + callId || record.callId !== callId
    || !validId(callId) || record.kind !== 'booking_review' || record.durable !== true
    || record.needsReview !== true || record.notificationStatus !== 'not_sent'
    || !Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 0
    || !Number.isFinite(Date.parse(record.at)) || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error('Invalid booking review record')
  }
  return record
}

export async function recordBookingReview(store: DocumentStore, input: {
  callId: string; now: Date; phone?: string; name: string | null; email: string | null
  callbackPhone?: Evidence<string>
  work?: { revision: number }
  booking: { slotId: string; startsAt: string; unitId: string | null; status: string } | null
}): Promise<BookingReview> {
  if (!validId(input.callId)) throw new Error('Invalid booking review identity')
  const at = input.now.toISOString()
  const initial: BookingReview = { version: 1, id: PREFIX + input.callId, kind: 'booking_review', durable: true,
    callId: input.callId, at, updatedAt: at, sourceRevision: input.work?.revision ?? 0, phone: bounded(input.phone, 64),
    name: bounded(input.name, 120), email: bounded(input.email, 254),
    callbackPhone: input.callbackPhone ? structuredClone(input.callbackPhone) : null,
    booking: input.booking ? { slotId: input.booking.slotId, startsAt: input.booking.startsAt,
      unitId: input.booking.unitId, status: 'arranging' } : null,
    needsReview: true, notificationStatus: 'not_sent' }
  return store.update(initial.id, initial, stored => {
    const current = validate(stored, input.callId)
    if (current.sourceRevision > initial.sourceRevision) return current
    const callbackPhone = initial.callbackPhone && (!current.callbackPhone || initial.callbackPhone.at >= current.callbackPhone.at)
      ? initial.callbackPhone : current.callbackPhone
    return { ...current, sourceRevision: initial.sourceRevision, updatedAt: at > current.updatedAt ? at : current.updatedAt,
      phone: current.phone ?? initial.phone, name: initial.name ?? current.name, email: initial.email ?? current.email,
      callbackPhone, booking: current.booking ?? initial.booking }
  })
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
