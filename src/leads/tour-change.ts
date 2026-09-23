import { createHash } from 'node:crypto'
import type { DocumentStore } from '../store/documents.ts'
import type { CalendarState, CalendarStore } from '../calendar/types.ts'
import { normalisePhone } from './profile.ts'

export interface TourChangeRequest {
  version: 1
  id: string
  callId: string
  firstRequestedAt: string
  lastUpdatedAt: string
  /** Last new caller evidence, separate from staff review time. Older records fall back conservatively. */
  lastRequestedAt?: string
  revision: number
  status: 'pending' | 'reviewed' | 'resolved'
  reason: 'caller_requested' | 'existing_future_tour'
  excerpts: string[]
  /** Bounded delivery identities preserve replay semantics when older displayed excerpts roll off. */
  excerptHashes?: string[]
  phone: string | null
  name: string | null
  email: string | null
  identityVerified: false
  notificationStatus: 'not_sent'
  review?: { at: string; actorId: string; note: string }
  /** Historical staff decisions survive later caller evidence reopening the request. */
  resolutions?: TourChangeResolution[]
}

export interface TourChangeResolution {
  requestId: string
  requestRevision: number
  actorId: string
  at: string
  note: string
  outcome: 'rescheduled' | 'cancelled' | 'no_change'
  source: { externalId: string; operationId: string; at: string; sha256: string;
    startsAt: string; endsAt: string; unitId: string | null } | null
  /** Staff attests the association; caller ID itself remains unverified. */
  association: 'staff_verified' | 'staff_decision'
  notification: 'not_sent_by_resolution'
}

export class TourChangeRequestError extends Error {
  readonly code: 'tour_change_invalid' | 'tour_change_not_found' | 'tour_change_conflict'
  constructor(code: TourChangeRequestError['code']) { super(code); this.code = code }
}

/** Known no-write result, never an uncertain calendar dispatch. No reservation details. */
export class TourChangeRequiredError extends Error {
  readonly reason: TourChangeRequest['reason']
  constructor(reason: TourChangeRequest['reason']) { super('TOUR_CHANGE_REQUIRED'); this.reason = reason }
}

const PREFIX = 'tour-change:'
const MAX_EXCERPT_IDENTITIES = 256
const excerptHash = (text: string) => createHash('sha256').update(text).digest('hex')
const identity = (value: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u0020\u007f-\u009f\ud800-\udfff]/u.test(value)) throw new TourChangeRequestError('tour_change_invalid')
  return value
}
export const tourChangeRequestKey = (callId: string) => PREFIX + createHash('sha256').update(identity(callId)).digest('hex')
const bounded = (value: unknown, limit: number): string | null => typeof value === 'string'
  ? [...value.replace(/[\ud800-\udfff]/gu, '\ufffd').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()].slice(0, limit).join('') || null : null

/** A phone is a collision guard and callback claim, never proof of identity. */
export function tourProspectPhone(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\+?[\d ()+.-]{7,25}$/.test(value.trim())) return null
  const phone = normalisePhone(value)
  return /^\+\d{7,15}$/.test(phone) ? phone : null
}

/** Detect an actual requested change; hypothetical policy questions do not stop intake. */
export function tourChangeExcerpt(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.slice(0, 16_000).replace(/[’‘]/g, "'")
  const existingTour = /\b(?:my|our)\s+(?:existing |booked |scheduled )?(?:tour|showing|appointment|visit|reservation|booking)\b|\b(?:i|we)\b.{0,40}\b(?:booked|scheduled|reserved)\b.{0,30}\b(?:tour|showing|appointment|visit)\b/i.test(text)
  for (const sentence of text.split(/[.!?;\n]/)) {
    if (/^\s*if\b|\bif\s+(?:i|we)\s+(?:book|schedule|decide|need|want)\b|\b(?:hypothetically|policy|policies)\b/i.test(sentence)
      || /\b(?:don't|do not|not|never|no need to)\s+(?:want to |need to |wish to |trying to )?(?:reschedule|change|move|cancel)\b/i.test(sentence)) continue
    const action = /\b(?:reschedul(?:e|ing)|rebook|mov(?:e|ing)|chang(?:e|ing)|cancel(?:ling|ing)?)\b/i
    const tour = /\b(?:tour|showing|appointment|visit|reservation|booking)\b/i
    const personal = /\b(?:my|our|i|we|me|us)\b/i
    const request = /\b(?:need|want|would like|can|could|please|have to|like to|calling to)\b/i
    if (action.test(sentence) && tour.test(sentence) && (personal.test(sentence) || request.test(sentence))) return bounded(text, 1000)
    if (existingTour && action.test(sentence) && /\b(?:it|that)\b/i.test(sentence) && request.test(sentence)) return bounded(text, 1000)
    if (/\b(?:can't|cannot|won't|will not|unable to)\s+(?:make|attend)\b/i.test(sentence) && tour.test(sentence) && personal.test(sentence)) return bounded(text, 1000)
  }
  return null
}

export function tourChangeHold(state: CalendarState, callId: string): boolean {
  const holds = state.tourChangeHolds ?? []
  if (!Array.isArray(holds) || holds.some(hold => !hold || typeof hold.interactionId !== 'string'
    || !hold.interactionId || !Number.isFinite(Date.parse(hold.recordedAt)))) throw new TourChangeRequestError('tour_change_invalid')
  return holds.some(hold => hold.interactionId === callId)
}

/** Orders change requests against new bookings in the same calendar CAS. Never expires silently. */
export async function holdTourChange(store: CalendarStore, callId: string, at: Date): Promise<void> {
  identity(callId)
  if (!Number.isFinite(at.getTime())) throw new TourChangeRequestError('tour_change_invalid')
  await store.mutate(state => {
    if (tourChangeHold(state, callId)) return state
    if ((state.tourChangeHolds?.length ?? 0) >= 10_000) throw new TourChangeRequestError('tour_change_conflict')
    return { ...state, tourChangeHolds: [...(state.tourChangeHolds ?? []), { interactionId: callId, recordedAt: at.toISOString() }] }
  })
}

export function checkedTourChangeRequest(record: TourChangeRequest): TourChangeRequest {
  if (!record || record.version !== 1 || record.id !== tourChangeRequestKey(record.callId)
    || !Number.isSafeInteger(record.revision) || record.revision < 0 || record.identityVerified !== false
    || record.notificationStatus !== 'not_sent' || !['pending', 'reviewed', 'resolved'].includes(record.status)
    || !['caller_requested', 'existing_future_tour'].includes(record.reason)
    || !Number.isFinite(Date.parse(record.firstRequestedAt)) || !Number.isFinite(Date.parse(record.lastUpdatedAt))
    || (record.lastRequestedAt !== undefined && (!Number.isFinite(Date.parse(record.lastRequestedAt))
      || Date.parse(record.lastRequestedAt) < Date.parse(record.firstRequestedAt) || Date.parse(record.lastRequestedAt) > Date.parse(record.lastUpdatedAt)))
    || !Array.isArray(record.excerpts) || record.excerpts.length > 8
    || record.excerpts.some(text => typeof text !== 'string' || !text || [...text].length > 1000)
    || (record.excerptHashes !== undefined && (!Array.isArray(record.excerptHashes)
      || record.excerptHashes.length > MAX_EXCERPT_IDENTITIES
      || record.excerptHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
      || new Set(record.excerptHashes).size !== record.excerptHashes.length
      || record.excerpts.some(text => !record.excerptHashes!.includes(excerptHash(text)))))
    || (record.phone !== null && tourProspectPhone(record.phone) !== record.phone)
    || bounded(record.name, 120) !== record.name || bounded(record.email, 254) !== record.email
    || (record.status === 'reviewed' && (!record.review || !Number.isFinite(Date.parse(record.review.at))
      || !record.review.actorId || typeof record.review.note !== 'string' || record.review.note.length > 1000))) throw new TourChangeRequestError('tour_change_invalid')
  if (record.resolutions !== undefined) {
    if (!Array.isArray(record.resolutions) || record.resolutions.length > 100
      || new Set(record.resolutions.map(r => r?.requestId)).size !== record.resolutions.length) throw new TourChangeRequestError('tour_change_invalid')
    let revision = -1
    for (const r of record.resolutions) {
      if (!r || typeof r.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(r.requestId)
        || !Number.isSafeInteger(r.requestRevision) || r.requestRevision <= revision || r.requestRevision >= record.revision
        || !r.actorId || bounded(r.actorId, 256) !== r.actorId || !Number.isFinite(Date.parse(r.at))
        || Date.parse(r.at) < Date.parse(record.firstRequestedAt) || Date.parse(r.at) > Date.parse(record.lastUpdatedAt)
        || typeof r.note !== 'string' || r.note.trim() !== r.note || r.note.length < 3 || r.note.length > 1000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(r.note)
        || !['rescheduled','cancelled','no_change'].includes(r.outcome) || r.notification !== 'not_sent_by_resolution'
        || r.association !== (r.outcome === 'no_change' ? 'staff_decision' : 'staff_verified')) throw new TourChangeRequestError('tour_change_invalid')
      const s = r.source
      if (r.outcome === 'no_change' ? s !== null : !s || typeof s.externalId !== 'string' || !s.externalId || s.externalId.length > 1024
        || typeof s.operationId !== 'string' || !s.operationId || s.operationId.length > 128 || !/^[a-f0-9]{64}$/.test(s.sha256)
        || !Number.isFinite(Date.parse(s.at)) || !Number.isFinite(Date.parse(s.startsAt)) || !Number.isFinite(Date.parse(s.endsAt))
        || Date.parse(s.endsAt) <= Date.parse(s.startsAt) || (s.unitId !== null && (typeof s.unitId !== 'string' || !s.unitId || s.unitId.length > 80))) throw new TourChangeRequestError('tour_change_invalid')
      revision = r.requestRevision
    }
  }
  if (record.status === 'resolved' && record.resolutions?.at(-1)?.requestRevision !== record.revision - 1) throw new TourChangeRequestError('tour_change_invalid')
  return record
}

/** Independent of call-state freezing: acknowledgement follows this durable write. */
export async function recordTourChangeRequest(store: DocumentStore, input: {
  callId: string; at: Date; reason: TourChangeRequest['reason']; excerpt?: string
  phone?: string | null; name?: string | null; email?: string | null
}): Promise<TourChangeRequest> {
  const id = tourChangeRequestKey(input.callId), at = input.at.toISOString()
  const excerpt = bounded(input.excerpt, 1000)
  const initial: TourChangeRequest = { version: 1, id, callId: input.callId, firstRequestedAt: at, lastUpdatedAt: at, lastRequestedAt: at,
    revision: 0, status: 'pending', reason: input.reason, excerpts: excerpt ? [excerpt] : [],
    excerptHashes: excerpt ? [excerptHash(excerpt)] : [],
    phone: tourProspectPhone(input.phone), name: bounded(input.name, 120), email: bounded(input.email, 254),
    identityVerified: false, notificationStatus: 'not_sent' }
  return store.update(id, initial, current => {
    checkedTourChangeRequest(current)
    if (current.id !== id) throw new TourChangeRequestError('tour_change_invalid')
    // Exact redelivery cannot undo a staff review or reset original event provenance.
    const knownHashes = current.excerptHashes ?? current.excerpts.map(excerptHash)
    const hash = excerpt ? excerptHash(excerpt) : null
    const newEvidence = hash !== null && !knownHashes.includes(hash)
    // Never silently acknowledge discarded new instructions, or forget delivery
    // identity and turn a replay into another request after staff reviewed it.
    if (newEvidence && knownHashes.length >= MAX_EXCERPT_IDENTITIES) throw new TourChangeRequestError('tour_change_conflict')
    const excerpts = newEvidence ? (current.excerpts.length < 8 ? [...current.excerpts, excerpt!]
      : [current.excerpts[0]!, ...current.excerpts.slice(-6), excerpt!]) : current.excerpts
    const next = { ...current, excerpts, ...(newEvidence ? { excerptHashes: [...knownHashes, hash!] } : {}), phone: initial.phone ?? current.phone,
      name: initial.name ?? current.name, email: initial.email ?? current.email }
    if (JSON.stringify(next) === JSON.stringify(current)) return current
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TourChangeRequestError('tour_change_conflict')
    // New caller evidence needs another review; unchanged provider retries do not.
    // A delayed event must not discard new instructions or move their review boundary backwards.
    const updatedAt = new Date(Math.max(input.at.getTime(), Date.parse(current.lastUpdatedAt), Date.parse(current.firstRequestedAt))).toISOString()
    return { ...next, status: 'pending', revision: current.revision + 1, lastUpdatedAt: updatedAt, lastRequestedAt: updatedAt }
  })
}

export async function listTourChangeRequests(store: DocumentStore): Promise<TourChangeRequest[]> {
  const keys = await store.list(PREFIX)
  const records: TourChangeRequest[] = []
  for (const key of keys) {
    const value = await store.get<TourChangeRequest>(key)
    if (value) { checkedTourChangeRequest(value); if (value.id !== key) throw new TourChangeRequestError('tour_change_invalid'); records.push(value) }
  }
  return records.sort((a, b) => b.firstRequestedAt.localeCompare(a.firstRequestedAt))
}

/** Staff review is a workflow acknowledgement, not a tour move or notification. */
export async function reviewTourChangeRequest(store: DocumentStore, input: {
  id: string; expectedRevision: number; at: Date; actorId: string; note?: string
}): Promise<TourChangeRequest> {
  if (!/^tour-change:[a-f0-9]{64}$/.test(input.id) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || !Number.isFinite(input.at.getTime()) || !bounded(input.actorId, 256)
    || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000))) throw new TourChangeRequestError('tour_change_invalid')
  const existing = await store.get<TourChangeRequest>(input.id)
  if (!existing) throw new TourChangeRequestError('tour_change_not_found')
  return store.update(input.id, existing, current => {
    checkedTourChangeRequest(current)
    if (current.id !== input.id) throw new TourChangeRequestError('tour_change_invalid')
    const note = bounded(input.note, 1000) ?? ''
    if (current.status === 'reviewed' && current.revision === input.expectedRevision + 1
      && current.review?.actorId === input.actorId && current.review.note === note) return current
    if (current.status === 'resolved' || current.revision !== input.expectedRevision || current.revision >= Number.MAX_SAFE_INTEGER) throw new TourChangeRequestError('tour_change_conflict')
    if (input.at.getTime() < Math.max(Date.parse(current.lastUpdatedAt), Date.parse(current.firstRequestedAt))) throw new TourChangeRequestError('tour_change_conflict')
    return { ...current, status: 'reviewed', revision: current.revision + 1, lastUpdatedAt: input.at.toISOString(),
      review: { at: input.at.toISOString(), actorId: input.actorId, note } }
  })
}

export const TOUR_CHANGE_SAVED = 'Your request is saved for staff review. No tour has been changed or cancelled, no new tour booked, and no notification sent. Staff must verify your identity and confirm the change.'
export const TOUR_CHANGE_UNSAVED = 'I could not verify that your request was saved. I have not changed or cancelled a tour or booked another one. Please contact the leasing team directly; no notification was sent.'
