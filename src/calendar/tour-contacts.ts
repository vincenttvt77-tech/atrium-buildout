import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import type { DocumentStore } from '../store/documents.ts'
import type { CalendarState, SlotBooking } from './types.ts'
import { assertAuthorizedScope } from '../auth/authorization.ts'
import { validEmailAddress } from '../email/render.ts'
import { hashJson } from '../workflows/validation.ts'
import { bookingSlot } from './slots.ts'
import { findBooking } from './reschedule.ts'
import { heldEmergency } from './safety.ts'
import { bookingReviewProjectionPending } from './booking-review.ts'
import { CalendarActionError, requestIdentity } from './unit-blocks.ts'

interface Contact { name: string; email: string | null }
interface ContactChange {
  requestId: string; revision: number; actorId: string; at: string; reason: string
  previous: Contact; next: Contact
}
interface History {
  format: 'tour-contact-history-v1'; externalId: string; changes: ContactChange[]
}
interface Receipt {
  format: 'tour-contact-command-v1'; externalId: string; actorId: string
  manifestSha256: string; change: ContactChange
}
const fail = (code: string, message: string, status = 409): never => { throw new CalendarActionError(code, message, status) }
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !!v.trim() && !/[\u0000-\u001f\u007f]/.test(v)
const historyKey = (externalId: string) => 'tour-contact-history:' + hashJson(externalId)
const commandKey = (requestId: string) => 'tour-contact-command:' + hashJson(requestId)
const corrupt = (): never => fail('tour_contact_history_invalid', 'This tour’s contact history needs administrator review.')
const contact = (b: SlotBooking): Contact => ({ name: b.prospectName, email: b.prospectEmail })
const contactValue = (v: Contact | null | undefined) => !!v && typeof v.name === 'string' && v.name.length <= 200
  && (v.email === null || typeof v.email === 'string' && v.email.length <= 254)
const revision = (b: SlotBooking) => {
  const n = b.contactRevision ?? 0
  if (!Number.isSafeInteger(n) || n < 0 || n > 1000
    || (n === 0 ? b.contactReviewedByStaff !== undefined : b.contactReviewedByStaff !== true)) return corrupt()
  return n
}
function changeValid(c: ContactChange | null | undefined): c is ContactChange {
  return !!c && text(c.requestId, 128) && text(c.actorId, 128) && text(c.reason, 500)
    && typeof c.at === 'string' && Number.isFinite(Date.parse(c.at))
    && Number.isSafeInteger(c.revision) && c.revision >= 1 && c.revision <= 1000
    && contactValue(c.previous) && contactValue(c.next) && text(c.next.name, 200)
    && (c.next.email === null || validEmailAddress(c.next.email)) && c.reason.trim().length >= 3
}
export function parseTourContactCommand(input: unknown) {
  const v = input as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || Object.keys(v).sort().join(',') !== 'action,email,expectedSha256,externalId,name,reason,requestId'
    || v.action !== 'save' || !text(v.externalId, 1024) || !digest(v.expectedSha256)
    || !text(v.name, 200) || !text(v.reason, 500) || v.reason.trim().length < 3
    || !(v.email === null || typeof v.email === 'string' && validEmailAddress(v.email.trim()))) {
    return fail('tour_contact_input_invalid', 'Enter a name, a valid email (or clear it), and a reason for the correction.', 400)
  }
  return { action: 'save' as const, requestId: requestIdentity(v.requestId), externalId: v.externalId,
    expectedSha256: v.expectedSha256, name: v.name.trim(), email: v.email === null ? null : (v.email as string).trim(), reason: v.reason.trim() }
}
function editReason(state: CalendarState, b: SlotBooking, now: Date): string | null {
  const slot = bookingSlot(b)
  if (!b.startsAt || !b.endsAt || !slot) return 'This tour needs verified start and end times before changing its contact.'
  if (slot.startsAt <= now) return 'Contact changes are available for future tours. Past tour history is retained.'
  if (bookingReviewProjectionPending(state, b.externalId) || b.rescheduleHistory?.some(item => item.projection === 'pending')
    || b.interactionId && heldEmergency(state, b.interactionId)) return 'Resolve this tour’s pending review before changing its contact.'
  return null
}

/** Reservation contact only: no caller identity, archived call, profile or email writes. */
export function createTourContactService(runtime: ResolvedPropertyRuntime, now: () => Date = () => new Date()) {
  const actor = runtime.scope.actor
  assertAuthorizedScope(runtime.scope, 'operate')
  if (actor.kind !== 'user') return fail('tour_contact_staff_required', 'Staff sign-in is required.', 403)
  const stamp = () => { const value = now(); if (!Number.isFinite(value.getTime())) return fail('tour_contact_clock_invalid', 'The contact clock is unavailable.'); return value }
  const fingerprint = (b: SlotBooking) => hashJson({ organizationId: runtime.scope.organizationId,
    propertyId: runtime.scope.propertyId, configurationVersion: runtime.snapshot.version, booking: b })
  async function history(documents: DocumentStore, b: SlotBooking): Promise<History> {
    const n = revision(b), raw = await documents.get<History>(historyKey(b.externalId))
    if (!raw && n === 0) return { format: 'tour-contact-history-v1', externalId: b.externalId, changes: [] }
    if (!raw || raw.format !== 'tour-contact-history-v1' || raw.externalId !== b.externalId
      || n === 0 || !Array.isArray(raw.changes) || raw.changes.length !== n
      || raw.changes.some((c, i) => !changeValid(c) || c.revision !== i + 1
        || i > 0 && hashJson(c.previous) !== hashJson(raw.changes[i - 1]!.next))
      || new Set(raw.changes.map(c => c.requestId)).size !== n
      || hashJson(raw.changes.at(-1)?.next) !== hashJson(contact(b))) return corrupt()
    return raw
  }
  async function view(state: CalendarState, documents: DocumentStore, b: SlotBooking, beforeRevision?: number) {
    const saved = await history(documents, b), reason = editReason(state, b, stamp())
    const all = [...saved.changes].reverse().filter(c => beforeRevision === undefined || c.revision < beforeRevision)
    const page = all.slice(0, 20)
    return { externalId: b.externalId, expectedSha256: fingerprint(b), name: b.prospectName, email: b.prospectEmail,
      contactRevision: revision(b), reviewedByStaff: b.contactReviewedByStaff === true, startsAt: b.startsAt ?? null,
      endsAt: b.endsAt ?? null, unitId: b.unitId, canEdit: reason === null && saved.changes.length < 1000,
      reason: reason ?? (saved.changes.length >= 1000 ? 'This tour’s contact history requires administrator review.' : null),
      history: page, historyCount: saved.changes.length, nextBeforeRevision: all.length > page.length ? page.at(-1)!.revision : null }
  }
  return {
    async read(externalId: unknown, beforeRevision?: number) {
      if (beforeRevision !== undefined && (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1 || beforeRevision > 1001)) {
        return fail('tour_contact_input_invalid', 'Choose a valid contact history page.', 400)
      }
      return runtime.calendarStore.transaction(async unit => {
        const state = await unit.readCalendar()
        return view(state, unit.documents, findBooking(state, externalId), beforeRevision)
      })
    },
    async save(input: unknown) {
      const command = parseTourContactCommand(input), manifestSha256 = hashJson({ ...command, actorId: actor.userId })
      return runtime.calendarStore.transaction(async unit => {
        // Lock calendar before document receipts; this matches voice/contact and confirmation admission.
        const state = await unit.readCalendar()
        const prior = await unit.documents.get<Receipt>(commandKey(command.requestId))
        if (prior) {
          if (prior.format !== 'tour-contact-command-v1' || !changeValid(prior.change) || !digest(prior.manifestSha256)
            || prior.change.actorId !== prior.actorId) return corrupt()
          if (prior.externalId !== command.externalId || prior.actorId !== actor.userId || prior.change.requestId !== command.requestId
            || prior.manifestSha256 !== manifestSha256 || prior.change.reason !== command.reason
            || hashJson(prior.change.next) !== hashJson({ name: command.name, email: command.email })) return fail('tour_contact_request_conflict', 'This saved change belongs to a different request. Reload the tour.')
          const rows = state.bookings.filter(b => b.externalId === command.externalId)
          if (rows.length === 1) {
            const saved = await history(unit.documents, rows[0]!)
            if (!saved.changes[prior.change.revision - 1] || hashJson(saved.changes[prior.change.revision - 1]) !== hashJson(prior.change)) return corrupt()
          }
          return { replayed: true, change: prior.change, current: rows.length === 0 ? null
            : await view(state, unit.documents, findBooking(state, command.externalId)) }
        }
        const booking = findBooking(state, command.externalId), saved = await history(unit.documents, booking)
        if (fingerprint(booking) !== command.expectedSha256) return fail('tour_contact_changed', 'The tour changed in another session. Reload its current contact before editing.')
        const at = stamp(), reason = editReason(state, booking, at)
        if (reason) return fail('tour_contact_held', reason)
        if (saved.changes.length >= 1000) return corrupt()
        if (command.name === booking.prospectName && command.email === booking.prospectEmail) return fail('tour_contact_unchanged', 'The saved contact already matches. No change was needed.')
        const change: ContactChange = { requestId: command.requestId, revision: revision(booking) + 1,
          actorId: actor.userId, at: at.toISOString(), reason: command.reason, previous: contact(booking),
          next: { name: command.name, email: command.email } }
        const updated = await unit.calendar.mutate(current => {
          const row = findBooking(current, command.externalId)
          if (fingerprint(row) !== command.expectedSha256) return fail('tour_contact_changed', 'Reload this changed tour before editing.')
          return { ...current, bookings: current.bookings.map(b => b === row ? { ...b, prospectName: command.name,
            prospectEmail: command.email, contactRevision: change.revision, contactReviewedByStaff: true as const } : b) }
        })
        await unit.documents.set<History>(historyKey(booking.externalId), { ...saved, changes: [...saved.changes, change] })
        await unit.documents.set<Receipt>(commandKey(command.requestId), { format: 'tour-contact-command-v1', externalId: booking.externalId,
          actorId: actor.userId, manifestSha256, change })
        return { replayed: false, change, current: await view(updated, unit.documents, findBooking(updated, booking.externalId)) }
      })
    },
  }
}
