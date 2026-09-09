import type { DocumentStore } from '../store/documents.ts'
import type { QualificationState } from '../leasing/qualification.ts'
import type { LossReason } from '../record/store.ts'
import { emptyProfile, deriveStage, normalisePhone, pinnedName } from './profile.ts'
import type { LeadProfile, CallSummary } from './profile.ts'
import { bookingIdentity, deriveFollowUps, legacyFollowUpId } from './followups.ts'
import type { FollowUp } from './followups.ts'
import { DEFAULT_TIME_ZONE, validateTimeZone } from '../calendar/time.ts'
import { resolveRescheduledBooking, reconcileRescheduledTour } from './reschedule.ts'
import type { RescheduleProjectionInput } from './reschedule.ts'

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
  booking: Omit<import('./profile.ts').LeadBooking, 'callId'> | null
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
  store: DocumentStore, o: CallOutcome, timeZone = DEFAULT_TIME_ZONE,
): Promise<{ profile: LeadProfile; followUps: FollowUp[] }> {
  const zone = validateTimeZone(timeZone)
  const phone = normalisePhone(o.phone)
  const at = o.at.toISOString()
  let reschedule: RescheduleProjectionInput | null = null
  if (o.booking) {
    const resolved = await resolveRescheduledBooking(store, phone, o.booking, o.callId)
    o = { ...o, booking: resolved.booking }
    reschedule = resolved.projection
  }

  const key = phone === 'unknown' ? `lead:anonymous:${o.callId}` : profileKey(phone)
  let profile = await store.update<LeadProfile>(key, emptyProfile(phone, o.at), (p) => {
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
    if (q.budget && newest) {
      next.signals.budgetRange = ev({ minMonthly: q.budget.value.minMonthly ?? null,
        maxMonthly: q.budget.value.maxMonthly }, q.budget.excerpt, q.budget.confidence)
      if (q.budget.value.maxMonthly !== null) next.signals.budget = ev(q.budget.value.maxMonthly, q.budget.excerpt, q.budget.confidence)
      else delete next.signals.budget
    }
    if (q.bedrooms && newest) next.signals.bedrooms = ev(q.bedrooms.value.min, q.bedrooms.excerpt, q.bedrooms.confidence)
    if (q.moveInTiming && newest) next.signals.moveIn = ev(
      { earliest: q.moveInTiming.value.earliest.toISOString(),
        latest: q.moveInTiming.value.latest?.toISOString() ?? null,
        said: q.moveInTiming.excerpt },
      q.moveInTiming.excerpt, q.moveInTiming.confidence)

    next.unitsDiscussed = [...new Set([...p.unitsDiscussed, ...o.unitsDiscussed])]

    if (o.booking) {
      const existing = p.bookings.find((b) => (b.externalId && o.booking!.externalId ? b.externalId === o.booking!.externalId
        : bookingIdentity(b) === bookingIdentity(o.booking!) || b.rescheduledFrom?.some(prior => bookingIdentity(prior) === bookingIdentity(o.booking!))))
      if (!existing) next.bookings = [...p.bookings, { ...o.booking, callId: o.callId }]
      else if ((o.booking.rescheduleRevision ?? 0) > (existing.rescheduleRevision ?? 0)) {
        next.bookings = p.bookings.map(b => b === existing ? { ...existing, ...o.booking!, callId: existing.callId } : b)
      }
      else if (existing.rescheduleRevision) { /* A delayed original result cannot restore the old slot. */ }
      else if (existing.status !== 'confirmed') {
        const priorAt = p.calls.find(c => c.callId === existing.callId)?.at
        if (o.booking.status === 'confirmed' || !priorAt || at >= priorAt) {
          next.bookings = p.bookings.map((b) => b === existing ? { ...o.booking!, callId: o.callId } : b)
        }
      }
      else if (o.booking.externalId && !existing.externalId) {
        next.bookings = p.bookings.map(b => b === existing ? { ...b, externalId: o.booking!.externalId! } : b)
      }
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

  if (reschedule) {
    const result = await reconcileRescheduledTour(store, reschedule)
    if (result.status !== 'complete') throw new Error('Tour reschedule projection requires staff review')
    profile = (await store.get<LeadProfile>(key))!
  }

  // A retried report may arrive hours or days later. Its work is still due relative to
  // the original call, including retries after a partially failed follow-up write.
  const recordedAt = profile.calls.find((c) => c.callId === o.callId)!.at
  const derived = deriveFollowUps(profile, new Date(recordedAt), o.callId, zone)
  const followUps = await reconcileFollowUps(store, profile, derived, zone)
  return { profile, followUps }
}

/**
 * Saved work is immutable to automatic re-derivation, including scheduled staff edits.
 * Reuse unambiguous v1 work in place. An old hour bucket shared by several intents is
 * retained with explicit review metadata; guessing a mapping would duplicate or lose
 * the operator's original decision. No deletion, ID rewrite or outbound action occurs.
 */
async function reconcileFollowUps(store: DocumentStore, profile: LeadProfile, derived: FollowUp[], timeZone: string): Promise<FollowUp[]> {
  if (!derived.length) return []
  const callIds = new Set(profile.calls.map(call => call.callId))
  const existing = (await listFollowUps(store)).filter(f => f.phone === profile.phone
    && (profile.phone !== 'unknown' || callIds.has(f.createdFromCall)))
  const result = new Map<string, FollowUp>()
  const missing: FollowUp[] = []
  for (const f of derived) {
    const current = existing.find(row => row.id === f.id || (row.source?.key && row.source.key === f.source?.key))
    if (current) result.set(current.id, current)
    else missing.push(f)
  }
  const legacy = existing.filter(row => !row.source && !row.id.startsWith('fu-v2-'))
  // A replay of an older event must still account for newer known bookings when
  // deciding whether a legacy hour bucket has one possible owner. These candidates
  // are for reconciliation only; the older event cannot create their missing work.
  const latestCall = profile.calls.reduce((latest, call) => call.at > latest.at ? call : latest, profile.calls[0]!)
  const possible = new Map(derived.map(f => [f.id, f]))
  if (latestCall) for (const f of deriveFollowUps(profile, new Date(latestCall.at), latestCall.callId, timeZone)) {
    if (f.source?.kind === 'booking') possible.set(f.id, f)
  }
  const missingIds = new Set(missing.map(f => f.id))
  const matches = new Map<string, FollowUp[]>()
  for (const row of legacy) {
    const candidates = [...possible.values()].filter(f => row.kind === f.kind && (
      row.reconciliation?.candidateIds.includes(f.id)
      || (f.source?.kind === 'call' ? row.createdFromCall === f.source.callId
        : row.id === legacyFollowUpId(profile, f) || row.createdFromCall === f.source?.callId
          // Earlier collect-email rows could be rescheduled by every subsequent call.
          // A second booking makes that legacy relationship ambiguous, never guessed.
          || (f.kind === 'collect_email' && callIds.has(row.createdFromCall)))
    ))
    if (candidates.some(f => missingIds.has(f.id))) matches.set(row.id, candidates)
  }
  const matchCount = (f: FollowUp) => [...matches.values()].filter(rows => rows.some(row => row.id === f.id)).length
  const covered = new Set<string>()
  for (const row of legacy) {
    const candidates = matches.get(row.id)
    if (!candidates) continue
    candidates.forEach(f => covered.add(f.id))
    const ambiguous = row.reconciliation?.status === 'needs_review' || candidates.length !== 1 || matchCount(candidates[0]!) !== 1
    const stored = await store.update<FollowUp>(followUpKey(row.id), row, current => {
      if (current.source) return current
      if (!ambiguous) return { ...current, source: candidates[0]!.source! }
      return { ...current, reconciliation: {
        status: 'needs_review', code: 'legacy_followup_identity_ambiguous',
        candidateIds: [...new Set([...(current.reconciliation?.candidateIds ?? []), ...candidates.map(f => f.id)])].sort(),
      } }
    })
    result.set(stored.id, stored)
  }
  for (const f of missing) {
    if (covered.has(f.id)) continue
    // update keeps the first persisted value even when another projection wins a race.
    const stored = await store.update<FollowUp>(followUpKey(f.id), f, current => current)
    result.set(stored.id, stored)
  }
  return [...result.values()]
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
