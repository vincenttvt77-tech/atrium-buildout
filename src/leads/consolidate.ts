import type { DocumentStore } from '../store/documents.ts'
import type { QualificationState } from '../leasing/qualification.ts'
import type { LossReason } from '../record/store.ts'
import { emptyProfile, deriveStage, normalisePhone, pinnedName } from './profile.ts'
import type { LeadProfile, CallSummary } from './profile.ts'
import { deriveFollowUps } from './followups.ts'
import type { FollowUp } from './followups.ts'

/**
 * Folds one finished call into the caller's profile, then re-derives their follow-ups.
 *
 * Runs on Vapi's end-of-call-report, the one moment the whole call is known. Everything
 * the tools recorded during the call — captured signals with their excerpts, the booking,
 * the loss reason, any escalation — lands on the profile keyed by the caller's number, so
 * the second call starts from what the first one learned.
 */

export interface CallOutcome {
  callId: string
  phone: string
  at: Date
  durationSeconds: number | null
  qualification: QualificationState
  name: string | null
  email: string | null
  unitsDiscussed: string[]
  booking: { slotId: string; startsAt: string; unitId: string | null; status: 'confirmed' | 'arranging' | 'failed' } | null
  lossReason: LossReason | null
  escalation: { trigger: string; detail: string } | null
  toolsCalled: string[]
}

export const profileKey = (phone: string) => `lead:${normalisePhone(phone)}`
export const followUpKey = (id: string) => `followup:${id}`

function outcomeLine(o: CallOutcome): string {
  if (o.escalation) return `Escalated: ${o.escalation.detail}`
  if (o.booking?.status === 'confirmed') return `Booked a tour${o.booking.unitId ? ` of ${o.booking.unitId}` : ''}`
  if (o.lossReason) return `Lost — ${o.lossReason.kind.replace(/_/g, ' ')}: ${o.lossReason.detail}`
  if (o.unitsDiscussed.length) return `Discussed ${o.unitsDiscussed.join(', ')}`
  return 'Enquired'
}

export async function consolidateCall(
  store: DocumentStore, o: CallOutcome,
): Promise<{ profile: LeadProfile; followUps: FollowUp[] }> {
  const phone = normalisePhone(o.phone)
  const at = o.at.toISOString()

  const key = phone === 'unknown' ? `lead:anonymous:${o.callId}` : profileKey(phone)
  const profile = await store.update<LeadProfile>(key, emptyProfile(phone, o.at), (p) => {
    // A human correction on the profile outranks anything a later call extracts; a name
    // the caller gave outranks a null; a later extraction outranks an earlier one.
    if (p.calls.some((c) => c.callId === o.callId)) return p
    const newest = at >= p.lastSeenAt
    const next: LeadProfile = { ...p, signals: { ...p.signals }, lastSeenAt: newest ? at : p.lastSeenAt, firstSeenAt: at < p.firstSeenAt ? at : p.firstSeenAt }
    const pinned = pinnedName(p.notes)
    if (pinned) next.name = pinned
    else if (newest && o.name) next.name = o.name
    if (newest && o.email) next.email = o.email

    const q = o.qualification
    const ev = <T,>(value: T, excerpt: string, confidence: number) =>
      ({ value, excerpt, callId: o.callId, at, confidence })
    if (q.budget && newest) next.signals.budget = ev(q.budget.value.maxMonthly, q.budget.excerpt, q.budget.confidence)
    if (q.bedrooms && newest) next.signals.bedrooms = ev(q.bedrooms.value.min, q.bedrooms.excerpt, q.bedrooms.confidence)
    if (q.moveInTiming && newest) next.signals.moveIn = ev(
      { earliest: q.moveInTiming.value.earliest.toISOString(),
        latest: q.moveInTiming.value.latest?.toISOString() ?? null,
        said: q.moveInTiming.excerpt },
      q.moveInTiming.excerpt, q.moveInTiming.confidence)

    next.unitsDiscussed = [...new Set([...p.unitsDiscussed, ...o.unitsDiscussed])]

    if (o.booking) {
      const existing = p.bookings.find((b) => b.slotId === o.booking!.slotId)
      if (!existing) next.bookings = [...p.bookings, { ...o.booking, callId: o.callId }]
      else if (existing.status !== 'confirmed' || o.booking.status === 'confirmed') next.bookings = p.bookings.map((b) => b === existing ? { ...o.booking!, callId: o.callId } : b)
    }
    if (o.lossReason) next.lossReasons = [...p.lossReasons, { ...o.lossReason, callId: o.callId }]
    if (o.escalation) next.escalations = [...p.escalations, { ...o.escalation, callId: o.callId, at }]

    const summary: CallSummary = {
      callId: o.callId, at, durationSeconds: o.durationSeconds,
      outcome: outcomeLine(o), toolsCalled: o.toolsCalled,
    }
    next.calls = p.calls.some((c) => c.callId === o.callId)
      ? p.calls.map((c) => (c.callId === o.callId ? summary : c))
      : [...p.calls, summary]

    next.stage = deriveStage(next, o.at)
    return next
  })

  // Deterministic ids make this a no-op for follow-ups that already exist, and a done or
  // skipped one is never reopened by a later call.
  // A retried report may arrive hours or days later. Its work is still due relative to
  // the original call, including retries after a partially failed follow-up write.
  const recordedAt = profile.calls.find((c) => c.callId === o.callId)!.at
  const derived = deriveFollowUps(profile, new Date(recordedAt), o.callId)
  const followUps: FollowUp[] = []
  for (const f of derived) {
    const stored = await store.update<FollowUp>(followUpKey(f.id), f, (cur) => cur.status === 'scheduled' ? f : cur)
    followUps.push(stored)
  }
  return { profile, followUps }
}

export async function listProfiles(store: DocumentStore): Promise<LeadProfile[]> {
  const keys = await store.list('lead:')
  const out: LeadProfile[] = []
  for (const k of keys) {
    const p = await store.get<LeadProfile>(k)
    if (p) out.push({ ...p, stage: deriveStage(p, new Date()) })
  }
  return out.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

export async function listFollowUps(store: DocumentStore): Promise<FollowUp[]> {
  const keys = await store.list('followup:')
  const out: FollowUp[] = []
  for (const k of keys) {
    const f = await store.get<FollowUp>(k)
    if (f) out.push(f)
  }
  return out.sort((a, b) => a.dueAt.localeCompare(b.dueAt))
}
