import type { DocumentStore } from '../store/documents.ts'
import type { TourCancellation } from '../calendar/types.ts'
import type { LeadProfile, LeadBooking } from './profile.ts'
import type { FollowUp } from './followups.ts'
import { normalisePhone, deriveStage } from './profile.ts'
import { bookingIdentity, deriveFollowUps, legacyFollowUpId, legacyInitialFollowUpId } from './followups.ts'
import { hashJson } from '../workflows/validation.ts'
import { checkedCancellation } from '../calendar/cancellation.ts'
import { bookingSlot } from '../calendar/slots.ts'

const tourKinds = new Set(['confirm_tour','remind_tour','post_tour','collect_email'])
export const cancellationProfileKey = (b: TourCancellation['booking']): string | null => {
  const phone = normalisePhone(b.prospectPhone)
  return phone !== 'unknown' ? `lead:${phone}` : b.interactionId ? `lead:anonymous:${b.interactionId}` : null
}
const indexKey = (profileKey: string) => 'tour-cancellation-lead:' + hashJson(profileKey)
interface CancellationIndex { format: 'tour-cancellation-lead-v1'; cancellations: TourCancellation[] }
function checkedIndex(value: CancellationIndex, key: string): CancellationIndex {
  if (!value || value.format !== 'tour-cancellation-lead-v1' || !Array.isArray(value.cancellations)
    || value.cancellations.some(row => cancellationProfileKey(checkedCancellation(row).booking) !== key)
    || new Set(value.cancellations.map(row => row.booking.externalId)).size !== value.cancellations.length) throw new Error('Stored cancellation ownership requires review')
  return value
}
export async function retainCancellation(store: DocumentStore, value: TourCancellation): Promise<void> {
  const c = checkedCancellation(value), key = cancellationProfileKey(c.booking)
  if (!key) return
  const initial: CancellationIndex = { format: 'tour-cancellation-lead-v1', cancellations: [c] }
  await store.update(indexKey(key), initial, raw => {
    const current = checkedIndex(raw, key), prior = current.cancellations.find(row => row.booking.externalId === c.booking.externalId)
    if (prior && hashJson(prior) !== hashJson(c)) throw new Error('Tour cancellation conflicts')
    return prior ? current : { ...current, cancellations: [...current.cancellations, c] }
  })
}
export function matchesCancelledBooking(b: LeadBooking, c: Pick<TourCancellation, 'booking' | 'interactionIds' | 'at'>, profile: LeadProfile): boolean {
  if (b.externalId) return b.externalId === c.booking.externalId
  // Legacy physical identity requires original call evidence; never guess a new caller's reservation.
  if (c.interactionIds.length && !c.interactionIds.includes(b.callId)) return false
  const call = profile.calls.find(row => row.callId === b.callId)
  if (!call || Date.parse(call.at) > Date.parse(c.at)) return false
  const slot = bookingSlot(c.booking)!
  const points = [{ slotId: slot.slotId, startsAt: slot.startsAt.toISOString(), unitId: c.booking.unitId },
    ...(c.booking.rescheduleHistory ?? []).flatMap(change => [change.from, change.to])]
  return points.some(point => bookingIdentity(b) === bookingIdentity(point))
}

/** Managed callers hold the profile writer's lock until projection and all follow-ups commit.
 * Read the index AFTER taking that lock: a cancellation that won first must be observed,
 * including when no profile existed at cancellation time. No new call/contact is fabricated.
 */
export async function applySavedCancellations(store: DocumentStore, key: string, profile: LeadProfile, timeZone: string): Promise<{ profile: LeadProfile; retired: number; review: number }> {
  const raw = await store.get<CancellationIndex>(indexKey(key))
  if (!raw) return { profile, retired: 0, review: 0 }
  const records = checkedIndex(raw, key).cancellations
  let next = profile, retired = 0, review = 0
  for (const c of records) {
    const candidates = next.bookings.filter(b => matchesCancelledBooking(b, c, next))
    if (candidates.length > 1) throw new Error('Cancelled tour profile identity is ambiguous')
    const target = candidates[0]
    if (!target) continue
    const updated = { ...target, externalId: c.booking.externalId, status: 'cancelled' as const,
      cancelledAt: c.at, cancellationRequestId: c.requestId }
    const previous = next
    next = await store.update<LeadProfile>(key, next, current => {
      if (hashJson(current) !== hashJson(previous)) throw new Error('Cancellation projection requires a locked profile')
      const result = { ...current, bookings: current.bookings.map(b => matchesCancelledBooking(b, c, current) ? { ...b, ...updated } : b) }
      return { ...result, stage: deriveStage(result, new Date(Math.max(Date.parse(current.lastSeenAt), Date.parse(c.at)))) }
    })
    const templates: Array<{ row: FollowUp; target: boolean }> = []
    for (const b of previous.bookings) {
      const versions = b === target ? [b, ...(c.booking.rescheduleHistory ?? []).flatMap(change => [
        { ...b, ...change.from, rescheduleRevision: change.revision - 1 }, { ...b, ...change.to, rescheduleRevision: change.revision }])] : [b]
      for (const version of versions) for (const now of [new Date(Date.parse(version.startsAt) - 3 * 86400000), new Date(Date.parse(version.startsAt) + 60000)]) {
        const p = { ...previous, bookings: [{ ...version, status: 'confirmed' as const }], escalations: [], lossReasons: [] }
        for (const row of deriveFollowUps(p, now, b.callId, timeZone)) if (row.source?.kind === 'booking') {
          templates.push({ row, target: b === target })
          const id = legacyInitialFollowUpId(p, row)
          if (id) templates.push({ row: { ...row, id }, target: b === target })
        }
      }
    }
    for (const rowKey of await store.list('followup:')) {
      const row = await store.get<FollowUp>(rowKey)
      if (!row || row.phone !== next.phone || !tourKinds.has(row.kind)) continue
      const source = row.source?.booking
      let matches = false, ambiguous = false
      if (source?.externalId) matches = source.externalId === c.booking.externalId
      else if (source) matches = row.source?.callId === target.callId && templates.some(t => t.target && t.row.kind === row.kind && bookingIdentity(t.row.source!.booking!) === bookingIdentity(source))
      else {
        const sameKind = templates.filter(t => t.row.kind === row.kind)
        const exact = sameKind.filter(t => t.row.id === row.id || legacyFollowUpId(previous, t.row) === row.id)
        const possible = exact.length ? exact : sameKind.filter(t => t.row.createdFromCall === row.createdFromCall || row.reconciliation?.candidateIds.includes(t.row.id))
        matches = possible.some(t => t.target)
        ambiguous = matches && (possible.some(t => !t.target) || !!row.reconciliation)
      }
      if (!matches) continue
      const superseded = { reason: 'tour_cancelled' as const, bookingExternalId: c.booking.externalId,
        revision: c.booking.revision ?? 0, requestId: c.requestId, at: c.at }
      await store.update<FollowUp>(rowKey, row, current => {
        if (ambiguous) return { ...current, reconciliation: { status: 'needs_review', code: 'legacy_followup_identity_ambiguous',
          candidateIds: [...new Set([...(current.reconciliation?.candidateIds ?? []), ...templates.filter(t => t.row.kind === row.kind).map(t => t.row.id)])].sort() } }
        return { ...current, status: current.status === 'scheduled' ? 'skipped' : current.status, superseded }
      })
      if (row.status === 'scheduled') { if (ambiguous) review++; else retired++ }
    }
  }
  return { profile: next, retired, review }
}
