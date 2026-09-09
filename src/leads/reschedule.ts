import { createHash } from 'node:crypto'
import type { DocumentStore } from '../store/documents.ts'
import type { BookingReschedule, CalendarState, SlotBooking } from '../calendar/types.ts'
import type { LeadBooking, LeadProfile } from './profile.ts'
import { normalisePhone } from './profile.ts'
import { bookingIdentity, deriveFollowUps, legacyFollowUpId } from './followups.ts'
import type { FollowUp } from './followups.ts'
import { validateTimeZone } from '../calendar/time.ts'

const PREFIX = 'tour-reschedule:'
const TOUR_REMINDERS = new Set(['confirm_tour', 'remind_tour', 'post_tour'])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const documentKey = (externalId: string) => PREFIX + hash(externalId)
interface RescheduleIndex {
  version: 1
  booking: SlotBooking
  change: BookingReschedule
}
export interface RescheduleProjectionResult {
  status: 'complete' | 'needs_review'
  profileKey: string | null
  reason?: 'profile_missing' | 'booking_identity_ambiguous' | 'booking_missing'
  updatedFollowUpIds: string[]
}
export interface RescheduleProjectionInput { booking: SlotBooking; change: BookingReschedule }
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)
}
const instant = (value: string) => { if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('Invalid tour reschedule instant'); return value }
function checked(input: RescheduleProjectionInput): RescheduleProjectionInput {
  const { booking, change } = input
  if (!booking || !change || !validText(booking.externalId) || !validText(change.requestId) || !validText(change.actorId)
    || !Number.isSafeInteger(change.revision) || change.revision < 1) throw new Error('Invalid tour reschedule identity')
  validateTimeZone(change.timeZone); instant(change.at)
  for (const point of [change.from, change.to]) {
    if (!point || !validText(point.slotId) || (point.unitId !== null && !validText(point.unitId))) throw new Error('Invalid tour reschedule interval')
    instant(point.startsAt); instant(point.endsAt)
    if (point.endsAt <= point.startsAt) throw new Error('Invalid tour reschedule interval')
  }
  if (booking.externalId.length > 1024 || typeof booking.prospectPhone !== 'string' || booking.prospectPhone.length > 64
    || (booking.interactionId !== undefined && !validText(booking.interactionId))) throw new Error('Invalid tour reschedule contact')
  return JSON.parse(JSON.stringify({ booking, change }))
}
const signature = (change: BookingReschedule) => JSON.stringify([change.requestId, change.revision, change.at, change.actorId, change.timeZone,
  change.from.slotId, change.from.startsAt, change.from.endsAt, change.from.unitId,
  change.to.slotId, change.to.startsAt, change.to.endsAt, change.to.unitId])
function validateIndex(value: RescheduleIndex): RescheduleIndex {
  if (!value || value.version !== 1) throw new Error('Invalid stored tour reschedule')
  checked(value)
  return value
}
function history(index: RescheduleIndex): BookingReschedule[] {
  const changes = [...(index.booking.rescheduleHistory ?? []), index.change]
  return [...new Map(changes.filter(change => change.revision <= index.change.revision).map(change => [change.revision, change])).values()]
    .sort((a, b) => a.revision - b.revision)
}
function matches(booking: Pick<LeadBooking, 'slotId' | 'startsAt' | 'unitId' | 'externalId' | 'rescheduledFrom'>, index: RescheduleIndex): boolean {
  if (booking.externalId) return booking.externalId === index.booking.externalId
  return history(index).some(change => bookingIdentity(booking) === bookingIdentity(change.from) || bookingIdentity(booking) === bookingIdentity(change.to))
}
function moved<T extends Pick<LeadBooking, 'slotId' | 'startsAt' | 'unitId'>>(booking: T, index: RescheduleIndex): T & Pick<LeadBooking, 'externalId' | 'rescheduleRevision' | 'rescheduledAt' | 'endsAt' | 'rescheduledFrom'> {
  return { ...booking, ...index.change.to, externalId: index.booking.externalId, rescheduleRevision: index.change.revision,
    rescheduledAt: index.change.at,
    rescheduledFrom: history(index).map(change => ({ slotId: change.from.slotId, startsAt: change.from.startsAt, unitId: change.from.unitId })) }
}
async function retainIndex(store: DocumentStore, input: RescheduleProjectionInput): Promise<RescheduleIndex> {
  const value = checked(input), initial: RescheduleIndex = { version: 1, ...value }
  return store.update(documentKey(value.booking.externalId), initial, raw => {
    const current = validateIndex(raw)
    if (current.booking.externalId !== value.booking.externalId || normalisePhone(current.booking.prospectPhone) !== normalisePhone(value.booking.prospectPhone)
      || current.booking.interactionId !== value.booking.interactionId) throw new Error('Tour reschedule ownership changed')
    if (current.change.revision === value.change.revision) {
      if (signature(current.change) !== signature(value.change)) throw new Error('Tour reschedule operation conflicts')
      return current
    }
    if (current.change.revision > value.change.revision) return current
    if (value.change.revision !== current.change.revision + 1
      || bookingIdentity(current.change.to) !== bookingIdentity(value.change.from)) throw new Error('Tour reschedule revision conflicts')
    return { ...initial, booking: { ...initial.booking,
      rescheduleHistory: [...history(current), value.change] } }
  })
}

/** Apply the saved calendar decision before a delayed call can project its old interval. */
export async function resolveRescheduledBooking<T extends Pick<LeadBooking, 'slotId' | 'startsAt' | 'unitId' | 'externalId'>>(store: DocumentStore, phone: string, booking: T, callId?: string): Promise<{ booking: T; projection: RescheduleProjectionInput | null }> {
  const indexes: RescheduleIndex[] = []
  if (booking.externalId) {
    const value = await store.get<RescheduleIndex>(documentKey(booking.externalId))
    if (value) indexes.push(validateIndex(value))
  } else {
    for (const key of await store.list(PREFIX)) {
      const value = await store.get<RescheduleIndex>(key)
      if (!value) throw new Error('Stored tour reschedule is missing')
      indexes.push(validateIndex(value))
    }
  }
  const candidates = indexes.filter(index => normalisePhone(index.booking.prospectPhone) === normalisePhone(phone)
    && (normalisePhone(phone) !== 'unknown' || (callId && index.booking.interactionId === callId)) && matches(booking, index))
  if (candidates.length > 1) throw new Error('Tour reschedule identity requires review')
  const index = candidates[0]
  return index ? { booking: moved(booking, index), projection: { booking: index.booking, change: index.change } } : { booking, projection: null }
}

const followUpKey = (id: string) => `followup:${id}`
function oldSourceMatches(row: FollowUp, prior: LeadBooking, externalId: string): boolean {
  const source = row.source?.booking
  return source ? (source.externalId ? source.externalId === externalId && (source.revision ?? 0) < (prior.rescheduleRevision ?? 0) + 1
    : bookingIdentity(source) === bookingIdentity(prior)) : false
}

/**
 * No external IO. PostgreSQL callers supply the calendar's transaction-bound documents;
 * KV callers retain the calendar's pending marker until this idempotent projection lands.
 */
export async function reconcileRescheduledTour(store: DocumentStore, input: RescheduleProjectionInput): Promise<RescheduleProjectionResult> {
  const index = await retainIndex(store, input), phone = normalisePhone(index.booking.prospectPhone)
  const key = phone !== 'unknown' ? `lead:${phone}` : index.booking.interactionId ? `lead:anonymous:${index.booking.interactionId}` : null
  const existing = key ? await store.get<LeadProfile>(key) : null
  if (!existing) return { status: 'needs_review', profileKey: key, reason: 'profile_missing', updatedFollowUpIds: [] }
  const candidates = existing.bookings.filter(booking => matches(booking, index))
  if (candidates.length !== 1) return { status: 'needs_review', profileKey: key,
    reason: candidates.length ? 'booking_identity_ambiguous' : 'booking_missing', updatedFollowUpIds: [] }
  const previous = candidates[0]!
  let accepted = true
  const profile = await store.update<LeadProfile>(key!, existing, current => {
    accepted = true
    const candidates = current.bookings.filter(booking => matches(booking, index))
    if (candidates.length !== 1) { accepted = false; return current }
    const target = candidates[0]!
    if ((target.rescheduleRevision ?? 0) > index.change.revision) return current
    return { ...current, bookings: current.bookings.map(booking => booking === target ? { ...moved(booking, index), status: 'confirmed' as const } : booking) }
  })
  if (!accepted) return { status: 'needs_review', profileKey: key, reason: 'booking_identity_ambiguous', updatedFollowUpIds: [] }
  const current = profile.bookings.find(booking => booking.externalId === index.booking.externalId)!
  if ((current.rescheduleRevision ?? 0) > index.change.revision) return { status: 'complete', profileKey: key, updatedFollowUpIds: [] }
  const updatedFollowUpIds = new Set<string>()
  const newProfile = { ...profile, bookings: [current], escalations: [], lossReasons: [] }
  const derived = deriveFollowUps(newProfile, new Date(index.change.at), current.callId, index.change.timeZone).filter(row => row.source?.kind === 'booking')
  const superseded = { reason: 'tour_rescheduled' as const, bookingExternalId: index.booking.externalId,
    revision: index.change.revision, requestId: index.change.requestId, at: index.change.at }
  const rows: FollowUp[] = []
  for (const key of await store.list('followup:')) {
    const row = await store.get<FollowUp>(key)
    if (row && row.phone === profile.phone) rows.push(row)
  }
  const priorBookings = history(index).map(change => {
    const { rescheduledAt: _at, ...prior } = previous
    return { ...prior, ...change.from, externalId: index.booking.externalId, rescheduleRevision: change.revision - 1 }
  })
  // Cover even missing old IDs: a stale in-flight KV projection must encounter a
  // tombstone instead of recreating an active reminder after this operation completes.
  const oldTemplates = new Map<string, FollowUp>()
  const possible = new Map<string, { row: FollowUp; prior: boolean }>()
  for (const candidate of [...priorBookings.map(booking => ({ booking, prior: true })),
    ...profile.bookings.filter(booking => booking.externalId !== index.booking.externalId).map(booking => ({ booking, prior: false }))]) {
    const oldProfile = { ...newProfile, bookings: [candidate.booking] }
    const start = Date.parse(candidate.booking.startsAt)
    for (const now of [new Date(start - 3 * 86400000), new Date(start + 60000)]) {
      for (const row of deriveFollowUps(oldProfile, now, candidate.booking.callId, index.change.timeZone)) {
        if (row.source?.kind !== 'booking') continue
        possible.set(JSON.stringify([row.id, candidate.prior]), { row, prior: candidate.prior })
        if (candidate.prior && TOUR_REMINDERS.has(row.kind)) oldTemplates.set(row.id, row)
      }
    }
  }
  const legacyPriorIds = new Set<string>(), ambiguousKinds = new Set<string>()
  for (const row of rows.filter(row => !row.source)) {
    const sameKind = [...possible.values()].filter(candidate => candidate.row.kind === row.kind)
    const exact = sameKind.filter(candidate => row.id === candidate.row.id || row.id === legacyFollowUpId(profile, candidate.row))
    const candidates = exact.length ? exact : sameKind.filter(candidate => candidate.row.createdFromCall === row.createdFromCall
      || row.reconciliation?.candidateIds.includes(candidate.row.id))
    if (!candidates.some(candidate => candidate.prior)) continue
    if (!row.reconciliation && candidates.every(candidate => candidate.prior)) {
      legacyPriorIds.add(row.id)
      continue
    }
    // A call may contain several tours. Preserve ambiguous staff work instead of
    // attributing every source-less reminder to whichever reservation moved first.
    ambiguousKinds.add(row.kind)
    await store.update<FollowUp>(followUpKey(row.id), row, latest => latest.source ? latest : ({ ...latest,
      reconciliation: { status: 'needs_review', code: 'legacy_followup_identity_ambiguous',
        candidateIds: [...new Set([...(latest.reconciliation?.candidateIds ?? []), ...candidates.map(candidate => candidate.row.id)])].sort() } }))
    updatedFollowUpIds.add(row.id)
  }
  const priorRow = (row: FollowUp) => legacyPriorIds.has(row.id)
    || priorBookings.some(prior => oldSourceMatches(row, prior, index.booking.externalId))
  for (const row of rows) if (TOUR_REMINDERS.has(row.kind) && priorRow(row)) oldTemplates.set(row.id, row)
  for (const template of oldTemplates.values()) {
    await store.update<FollowUp>(followUpKey(template.id), { ...template, status: 'skipped', superseded }, latest => {
      if (latest.status !== 'scheduled') return latest
      return { ...latest, status: 'skipped', superseded }
    })
    updatedFollowUpIds.add(template.id)
  }
  for (const next of derived) {
    if (next.kind === 'collect_email') {
      const existingCollection = rows.filter(row => row.kind === 'collect_email' && (row.source?.key === next.source?.key
        || priorRow(row)))
      if (existingCollection.length) {
        // Contact collection is not another tour reminder. Preserve all human state
        // and original deadline while reconciling its deterministic source identity.
        for (const row of existingCollection) {
          await store.update<FollowUp>(followUpKey(row.id), row, latest => ({ ...latest, source: next.source! }))
          updatedFollowUpIds.add(row.id)
        }
        continue
      }
      if (ambiguousKinds.has(next.kind)) continue
    }
    await store.update<FollowUp>(followUpKey(next.id), next, latest => latest)
    updatedFollowUpIds.add(next.id)
  }
  return { status: 'complete', profileKey: key, updatedFollowUpIds: [...updatedFollowUpIds] }
}

/** Keep unresolved KV projection visible and old tour reminders out of the active queue. */
export function pendingRescheduleVisibility(state: CalendarState, followUps: FollowUp[]) {
  const rescheduleProjectionPending = state.bookings.flatMap(booking => (booking.rescheduleHistory ?? [])
    .filter(change => change.projection === 'pending').map(change => ({ externalId: booking.externalId, requestId: change.requestId,
      revision: change.revision, prospectPhone: booking.prospectPhone, unitId: booking.unitId, from: change.from, to: change.to })))
  const heldFollowUps = followUps.filter(row => row.status === 'scheduled' && TOUR_REMINDERS.has(row.kind)
    && rescheduleProjectionPending.some(pending => normalisePhone(row.phone) === normalisePhone(pending.prospectPhone)
      && row.source?.booking && (row.source.booking.externalId === pending.externalId || bookingIdentity(row.source.booking) === bookingIdentity(pending.from))))
  const held = new Set(heldFollowUps.map(row => row.id))
  return { rescheduleProjectionPending, heldFollowUps, followUps: followUps.filter(row => !held.has(row.id)) }
}
