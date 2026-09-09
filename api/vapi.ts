import rawProperty from '../data/property.json' with { type: 'json' }
import rawUnits from '../data/inventory.json' with { type: 'json' }
import rawInventorySource from '../data/inventory-source.json' with { type: 'json' }
import rawPlans from '../data/floorplans.json' with { type: 'json' }
import rawArticles from '../data/knowledge.json' with { type: 'json' }
import { loadInventory } from '../src/inventory/load.ts'
import type { InventorySnapshot } from '../src/inventory/types.ts'
import type { KnowledgeArticle } from '../src/knowledge/article.ts'
import { emptyQualification, type QualificationState } from '../src/leasing/qualification.ts'
import {
  checkEmergency, checkAvailability, answerQuestion, captureSignal, captureLossReason,
  type ToolContext,
} from '../src/conversation/tools.ts'
import { authorizeOps, constantTimeEquals } from '../src/ops/session.ts'
import { fetchCalls } from '../src/ops/vapi-calls.ts'
import { calendarStoreFromEnv } from '../src/calendar/store.ts'
import { heldEmergency, holdEmergency, CalendarInteractionPausedError } from '../src/calendar/safety.ts'
import { generateSlots } from '../src/calendar/slots.ts'
import { defaultSettings, effectiveOptions } from '../src/calendar/settings.ts'
import { parseCalendarDate, addCalendarDays } from '../src/calendar/range.ts'
import { DEFAULT_TIME_ZONE, localDate, validateTimeZone, wallTime } from '../src/calendar/time.ts'
import { propertyTimeZone } from '../src/config/property.ts'
import { storeBackedCalendar } from '../src/calendar/port.ts'
import { documentStoreFromEnv, type DocumentStore } from '../src/store/documents.ts'
import { normalisePhone } from '../src/leads/profile.ts'
import { reconcile } from '../src/leasing/captured.ts'
import { receiveFinishedCall, type CallReceiptScope } from '../src/leads/inbox.ts'
import { randomUUID } from 'node:crypto'
import type { LossReason } from '../src/record/store.ts'
import { bookTour } from '../src/booking/book.ts'
import type { CalendarPort, TourSlot } from '../src/booking/types.ts'
import { sayableStatus } from '../src/booking/book.ts'
import { propertyId, interactionId } from '../src/domain/ids.ts'
import { currentTenantId, withTenant } from '../src/tenancy/context.ts'
import { webhookTenant } from '../src/tenancy/webhook.ts'
import { detectEmergency, primaryEmergency, safetyInstruction, type EmergencySignal } from '../src/escalation/emergency.ts'
import { isPostgresRuntime, resolveOpsRuntime, resolveVerifiedChannelRuntime, runWithPropertyRuntime,
  currentPropertyRuntime, runtimeForRequest, readRuntimeError, RuntimeRequestError, type ResolvedPropertyRuntime } from '../src/application/runtime.ts'
import { webhookAssistantId } from '../src/tenancy/webhook.ts'
import { initializeCallLifecycle, admitToolBatch, markToolDispatch, completeToolBatch,
  requestCallEnd, freezeCall, completeCall, hashCallToolArgs, CallLifecycleError,
  type CallLifecycle, type CallProvenance, type CallToolResult } from '../src/calls/lifecycle.ts'
import { recordCallSafetyEvent, listCallSafetyEvents, safetyEventForOps } from '../src/calls/safety-events.ts'
import { holdTourChange, recordTourChangeRequest, tourChangeExcerpt, TourChangeRequiredError,
  TOUR_CHANGE_SAVED, TOUR_CHANGE_UNSAVED, type TourChangeRequest } from '../src/leads/tour-change.ts'

/**
 * Vapi tool-call webhook.
 *
 * Vapi hosts the model and the voice; this endpoint is where every consequential decision
 * is actually made. The model can only affect the world through these tools, and each tool
 * applies its guard before returning — so the prompt is a style guide, not a security
 * boundary.
 */

/**
 * Property data is bundled at build time rather than read from disk.
 *
 * Serverless filesystems are a source of deployment-only surprises — the file that is
 * plainly there locally is not necessarily traced into the function. Bundling means what
 * ran in the tests is byte-for-byte what runs in production. The cost is that an inventory
 * change needs a redeploy, which is the right trade until a real PMS is the source.
 */

let cache: {
  inventory: InventorySnapshot
  articles: KnowledgeArticle[]
  property: Record<string, unknown>
} | null = null

function load(now: Date, runtime?: ResolvedPropertyRuntime) {
  if (runtime) return runtime.snapshot
  // These files are immutable for the life of a deployment. A cache refresh cannot
  // refresh their source date; an updated catalogue requires a new published bundle.
  if (cache) return cache

  const { snapshot, problems } = loadInventory(
    rawUnits as unknown[], rawPlans as unknown[], new Date(rawInventorySource.catalogAsOf),
    'data/inventory.json', rawInventorySource, now)
  if (problems.length > 0) console.warn('[inventory] excluded records:', problems)

  const articles = (rawArticles as unknown as Record<string, unknown>[]).map((a) => ({
    ...a,
    approvedAt: a.approvedAt ? new Date(a.approvedAt as string) : null,
    reviewBy: new Date(a.reviewBy as string),
  }) as unknown as KnowledgeArticle)

  cache = { inventory: snapshot, articles, property: rawProperty as Record<string, unknown> }
  return cache
}

/*
 * Per-call conversation state, in the document store rather than a module-level Map.
 *
 * Vapi sends each tool call as its own request, and on serverless each request may land
 * on a different instance. A Map meant capture_signal could run on one instance and
 * check_availability on another that had never seen it — the second call found an empty
 * qualification. Keyed by call id; consolidated into the caller's profile at end of call.
 */
interface CallState {
  routing?: { organizationId: string; propertyId: string; channelBindingId: string }
  qualification: QualificationState
  phone?: string
  /** A compact receipt prevents repeated finished-call reports from recreating a caller. */
  completedAt?: string
  work?: CallLifecycle
  name: string | null
  email: string | null
  unitsDiscussed: string[]
  booking: { slotId: string; startsAt: string; unitId: string | null; status: 'confirmed' | 'arranging' | 'failed'; externalId?: string } | null
  lossReason: LossReason | null
  escalation: { trigger: string; detail: string } | null
  emergency: EmergencySignal | null
  tourChangeRequested?: boolean
  toolsCalled: string[]
}

const documents = documentStoreFromEnv()
const callKey = (id: string) => `call:${id}`

function routingIdentity() {
  const runtime = currentPropertyRuntime()
  if (!runtime) return undefined
  if (runtime.scope.actor.kind !== 'channel') throw new Error('Call state requires a verified channel scope')
  return { organizationId: runtime.scope.organizationId, propertyId: runtime.scope.propertyId,
    channelBindingId: runtime.scope.actor.bindingId }
}

function receiptScope(runtime?: ResolvedPropertyRuntime): CallReceiptScope | undefined {
  if (!runtime) return undefined
  const routing = routingIdentity()
  if (!routing) throw new Error('Call routing authority is missing')
  return { ...routing, configurationVersion: runtime.snapshot.version, timeZone: runtime.snapshot.timeZone }
}

function callProvenance(runtime?: ResolvedPropertyRuntime): CallProvenance | undefined {
  if (!runtime) {
    try { return { tenantId: currentTenantId(), timeZone: propertyTimeZone(rawProperty) } }
    catch { return undefined } // Individual scheduling boundaries report bad legacy calendar configuration.
  }
  const actor = runtime.scope.actor
  if (actor.kind !== 'channel') throw new Error('Call work requires verified channel authority')
  return { organizationId: runtime.scope.organizationId, propertyId: runtime.scope.propertyId,
    channelBindingId: actor.bindingId, channelBindingVersion: actor.bindingVersion,
    configurationVersion: runtime.snapshot.version, timeZone: runtime.snapshot.timeZone }
}

function lifecycleRoute(state: CallState, proposed?: CallProvenance): { provenance?: CallProvenance } {
  const stored = state.work?.provenance
  const provenance = proposed ?? (stored && 'tenantId' in stored && stored.tenantId === currentTenantId() ? stored : undefined)
  return provenance ? { provenance } : {}
}

/** Accept only actual ISO calendar instants; malformed optional provider dates remain missing. */
function reportInstant(value: unknown): number {
  if (typeof value !== 'string') return NaN
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts) return NaN
  const [, year, month, day, hour, minute, second, offset] = parts
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (offset !== 'Z' && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59))) return NaN
  return Date.parse(value)
}

function lifecycleResponse(res: any, error: CallLifecycleError, toolIds: unknown[] = []): void {
  const busy = ['call_work_busy', 'call_work_unresolved', 'call_admission_stale'].includes(error.code)
  const conflict = ['call_tool_identity_conflict', 'call_event_identity_conflict', 'call_provenance_conflict', 'call_revision_conflict'].includes(error.code)
  if (busy) res.setHeader('retry-after', '2')
  const result = error.code === 'call_closed' ? 'This call has already ended. No action was taken.'
    : busy ? 'This call has unfinished work that must be resolved before another action can run. Do not claim it succeeded.'
      : 'The call or tool identity does not match the accepted request. No new action was taken.'
  res.status(error.code === 'call_closed' ? 200 : busy ? 503 : conflict ? 409 : 400).json({
    code: error.code, ...(busy ? { retryable: true } : {}),
    ...(toolIds.length ? { results: toolIds.map(toolCallId => ({ toolCallId, result })) } : { error: result }),
  })
}

const freshCall = (): CallState => ({
  ...(routingIdentity() ? { routing: routingIdentity()! } : {}),
  qualification: emptyQualification(), name: null, email: null, unitsDiscussed: [],
  booking: null, lossReason: null, escalation: null, emergency: null, toolsCalled: [],
})

/** Dates inside QualificationState do not survive JSON; rehydrate them. */
function reviveCall(raw: CallState | null): CallState {
  if (!raw) return freshCall()
  const expected = routingIdentity()
  if (expected && (!raw.routing || Object.entries(expected).some(([key, value]) => raw.routing?.[key as keyof typeof expected] !== value))) {
    throw new RuntimeRequestError(409, 'call_routing_conflict', 'This call is already assigned to another connection and cannot be reassigned.')
  }
  const q = raw.qualification as unknown as Record<string, unknown>
  for (const k of ['moveInTiming', 'budget', 'bedrooms', 'pets', 'parking', 'source'] as const) {
    const v = q[k] as { at?: string | Date; value?: Record<string, unknown> } | undefined
    if (v?.at) v.at = new Date(v.at)
    if (k === 'moveInTiming' && v?.value) {
      if (v.value.earliest) v.value.earliest = new Date(v.value.earliest as string)
      if (v.value.latest) v.value.latest = new Date(v.value.latest as string)
    }
  }
  return { ...freshCall(), ...raw, qualification: raw.qualification }
}

async function getCall(callId: string): Promise<CallState> {
  return reviveCall(await documents.get<CallState>(callKey(callId)))
}

async function saveCall(callId: string, state: CallState, before: CallState,
  completion?: { token: string; results: CallToolResult[] }): Promise<CallState> {
  return documents.update<CallState>(callKey(callId), freshCall(), (raw) => {
    const current = reviveCall(raw)
    if (current.completedAt || current.work?.phase === 'frozen') {
      if (completion) throw new CallLifecycleError('call_admission_stale')
      return current
    }
    const qualification = { ...current.qualification }
    for (const key of ['moveInTiming', 'budget', 'bedrooms', 'pets', 'parking', 'source'] as const) {
      const incoming = state.qualification[key]
      if (incoming) Object.assign(qualification, { [key]: reconcile(current.qualification[key] as never, incoming as never) })
    }
    const next = { ...current, qualification,
      unitsDiscussed: [...new Set([...current.unitsDiscussed, ...state.unitsDiscussed])],
      toolsCalled: [...current.toolsCalled, ...state.toolsCalled.slice(before.toolsCalled.length)],
    }
    if (current.tourChangeRequested || state.tourChangeRequested) next.tourChangeRequested = true
    for (const key of ['name', 'email', 'phone', 'booking', 'lossReason'] as const) {
      if (JSON.stringify(state[key]) !== JSON.stringify(before[key])) Object.assign(next, { [key]: state[key] })
    }
    // A stale tool request must not replace a concurrently recorded emergency with
    // an ordinary policy escalation or silently clear the pause on leasing actions.
    next.emergency = primaryEmergency([current.emergency, state.emergency].filter((e): e is EmergencySignal => Boolean(e)))
    next.escalation = next.emergency ? { trigger: 'emergency', detail: `${next.emergency.kind}: "${next.emergency.matched}"` }
      : current.escalation?.trigger === 'emergency' ? current.escalation
      : state.escalation?.trigger === 'emergency' ? state.escalation
        : JSON.stringify(state.escalation) !== JSON.stringify(before.escalation) ? state.escalation : current.escalation
    if (next.tourChangeRequested && next.escalation?.trigger !== 'emergency') {
      next.escalation = state.escalation?.trigger === 'tour_change' ? state.escalation
        : current.escalation?.trigger === 'tour_change' ? current.escalation
          : { trigger: 'tour_change', detail: 'Tour change requires staff review. No tour was changed and no notification was sent.' }
    }
    if (completion) {
      if (!current.work) throw new CallLifecycleError('call_admission_stale')
      next.work = completeToolBatch(current.work, { ...completion, now: new Date().toISOString() })
    }
    return next
  })
}

async function finishEndedCall(callId: string, state: CallState, now: Date, runtime?: ResolvedPropertyRuntime): Promise<void> {
  const work = state.work
  if (!work || (work.phase !== 'ending' && work.phase !== 'frozen')
    || work.intents.some(intent => intent.status !== 'complete' && intent.status !== 'blocked')) return
  if (runtime) await runtime.documents.transaction(store => projectFrozenCall(store, callId, now, runtime))
  else await projectFrozenCall(documents, callId, now)
}

/** Only document operations run here; the PostgreSQL caller owns one atomic unit. */
async function projectFrozenCall(store: DocumentStore, callId: string, now: Date, runtime?: ResolvedPropertyRuntime): Promise<CallState> {
  const frozen = reviveCall(await store.update<CallState>(callKey(callId), freshCall(), raw => {
    const current = reviveCall(raw)
    if (current.completedAt) return current
    if (!current.work) throw new CallLifecycleError('call_work_unresolved')
    return { ...current, work: freezeCall(current.work, { now: now.toISOString() }) }
  }))
  if (frozen.completedAt) return frozen
  const work = frozen.work!, end = work.end!
  const phone = normalisePhone(frozen.phone ?? end.reportedPhone ?? 'unknown')
  await receiveFinishedCall(store, {
    callId, phone, at: new Date(end.endedAt), durationSeconds: end.durationSeconds,
    qualification: frozen.qualification, name: frozen.name, email: frozen.email,
    unitsDiscussed: frozen.unitsDiscussed, booking: frozen.booking, lossReason: frozen.lossReason,
    escalation: frozen.escalation, toolsCalled: frozen.toolsCalled,
  }, now, receiptScope(runtime))
  return store.update<CallState>(callKey(callId), frozen, raw => {
    const current = reviveCall(raw)
    if (!current.work) throw new CallLifecycleError('call_revision_conflict')
    const completed = completeCall(current.work, { now: now.toISOString(), frozenRevision: work.frozenRevision! })
    return { ...freshCall(), phone, completedAt: end.endedAt, work: completed,
      ...(current.tourChangeRequested ? { tourChangeRequested: true } : {}) }
  })
}

/*
 * The tour calendar the phone line books against. It is the same store the operations
 * dashboard edits, so a block set there is a time the agent will not offer here — which is
 * the test that proves it reads a calendar rather than inventing one.
 */
const calendarStore = calendarStoreFromEnv()
const TOUR_CAPACITY = defaultSettings().capacity
const demoCalendar = (now: Date, timeZone: string) => storeBackedCalendar(calendarStore, () => now, { capacity: TOUR_CAPACITY, unitIds: rawUnits.map(u => u.unitId), timeZone })
const callCalendar = (now: Date, timeZone: string, runtime?: ResolvedPropertyRuntime) => runtime ? runtime.calendar(now) : demoCalendar(now, timeZone)

const CALENDAR_CONFIGURATION_UNAVAILABLE = "The building's tour calendar needs staff attention, so I can't verify or book a time right now. Offer help from the leasing team; do not suggest that a different date will fix this."

/** Resolve at the scheduling boundary so a bad calendar setting cannot suppress safety guidance. */
function tourTimeZone(property: Record<string, unknown>, callId: string): string | null {
  try { return propertyTimeZone(property) }
  catch {
    logEvent(callId, { kind: 'configuration_error', errorCode: 'property_timezone_invalid' })
    return null
  }
}

/**
 * Which open times to put in front of the model.
 *
 * The first six slots in date order are six half-hours on the same morning, so the caller
 * heard "I can do Tuesday" from a calendar that was wide open. A caller who named a day
 * gets that day; otherwise the next three days with something open, a morning and an
 * afternoon time on each, and a note that other days are open too.
 */
const VALID_WALL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const wallMinutes = (date: Date, timeZone: string) => { const wall = wallTime(date, timeZone); return wall.hour * 60 + wall.minute }

export function pickSlotsToOffer(open: TourSlot[], preferredDate?: string, timeZone = DEFAULT_TIME_ZONE, preferredTime?: string): { offered: TourSlot[]; daysOpen: number } {
  const zone = validateTimeZone(timeZone)
  if (preferredTime !== undefined && (typeof preferredTime !== 'string' || !VALID_WALL_TIME.test(preferredTime) || !preferredDate)) throw new Error('Use preferredTime as HH:mm with a preferredDate.')
  const wantedMinutes = preferredTime === undefined ? null : Number(preferredTime.slice(0, 2)) * 60 + Number(preferredTime.slice(3))
  const nearest = (slots: TourSlot[]) => wantedMinutes === null ? slots : [...slots].sort((a, b) =>
    Math.abs(wallMinutes(a.startsAt, zone) - wantedMinutes) - Math.abs(wallMinutes(b.startsAt, zone) - wantedMinutes)
      || a.startsAt.getTime() - b.startsAt.getTime())
  const byDay = new Map<string, TourSlot[]>()
  for (const s of open) { const d = localDate(s.startsAt, zone); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(s) }
  const wanted = preferredDate && /^\d{4}-\d{2}-\d{2}$/.test(preferredDate) ? byDay.get(preferredDate) : undefined
  if (wanted?.length) return { offered: nearest(wanted).slice(0, 6), daysOpen: byDay.size }
  const offered: TourSlot[] = []
  for (const [, slots] of [...byDay.entries()].slice(0, 3)) {
    if (wantedMinutes !== null) { offered.push(...nearest(slots).slice(0, 2)); continue }
    const morning = slots.find((s) => wallTime(s.startsAt, zone).hour < 13)
    const afternoon = slots.find((s) => wallTime(s.startsAt, zone).hour >= 13)
    for (const s of [morning, afternoon]) if (s && !offered.includes(s)) offered.push(s)
    if (!morning && !afternoon) offered.push(slots[0]!)
  }
  return { offered, daysOpen: byDay.size }
}

const fmtSlot = (s: TourSlot, timeZone: string) =>
  s.startsAt.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone,
  })

/**
 * Call history from Vapi, read at most once every twenty seconds per instance.
 *
 * Every open dashboard tab polls this function every few seconds, and each poll used to be
 * its own request to Vapi's API — a handful of tabs was enough to be rate-limited, and the
 * page then said the connection was "not answering". One read per instance per twenty
 * seconds is plenty for a page that refreshes itself, the last good list is kept when a
 * refresh fails so the page never goes empty, and the reason is written to the log.
 */
const HISTORY_TTL_MS = 20_000
type HistoryState = {
  cache: { at: number; calls: ReturnType<typeof normaliseCallList>; configured: boolean } | null
  failure: { at: number; reason: string; configured: boolean } | null
}
const tenantHistory = new Map<string, HistoryState>()
type NormalisedCalls = Awaited<ReturnType<typeof fetchCalls>> extends infer R ? R extends { ok: true; calls: infer C } ? C : never : never
const normaliseCallList = (c: NormalisedCalls) => c

async function callHistory(assistantIds?: string[], runtime?: ResolvedPropertyRuntime): Promise<{ calls: NormalisedCalls; error: string | null; configured: boolean; stale: boolean }> {
  if (assistantIds?.length === 0) return { calls: [], error: null, configured: false, stale: false }
  const cacheKey = JSON.stringify([runtime ? [runtime.scope.organizationId, runtime.scope.propertyId, runtime.bindingFingerprint] : currentTenantId(), assistantIds?.slice().sort() ?? null])
  if (!tenantHistory.has(cacheKey)) tenantHistory.set(cacheKey, { cache: null, failure: null })
  if (tenantHistory.size > 200) tenantHistory.delete(tenantHistory.keys().next().value!)
  const scoped = tenantHistory.get(cacheKey)!
  let historyCache = scoped.cache
  const historyFailure = scoped.failure
  const now = Date.now()
  if (historyCache && now - historyCache.at < HISTORY_TTL_MS) {
    return { calls: historyCache.calls, error: null, configured: true, stale: false }
  }
  // A refusal is remembered for the same twenty seconds: a wrong key answered "401" to
  // every five-second poll from every open tab, which helps nobody.
  if (historyFailure && now - historyFailure.at < HISTORY_TTL_MS) {
    return { calls: historyCache?.calls ?? [], error: historyFailure.reason, configured: historyFailure.configured, stale: Boolean(historyCache) }
  }
  const result = await fetchCalls({ limit: 20, ...(assistantIds ? { assistantIds } : {}) })
  if (result.ok) {
    scoped.failure = null
    scoped.cache = { at: now, calls: result.calls, configured: true }
    return { calls: result.calls, error: null, configured: true, stale: false }
  }
  scoped.failure = { at: now, reason: result.reason, configured: result.configured }
  console.warn('[vapi-history]', JSON.stringify({ reason: result.reason, configured: result.configured, cached: Boolean(historyCache) }))
  if (historyCache) {
    // Do not hammer a service that just said no: treat the failed read as a fresh one.
    scoped.cache = historyCache = { ...historyCache, at: now }
    return { calls: historyCache.calls, error: result.reason, configured: true, stale: true }
  }
  return { calls: [], error: result.reason, configured: result.configured, stale: false }
}

/** Everything that happened, for the dashboard. */
export const eventLog: Array<Record<string, unknown>> = []
const tenantEvents = new Map<string, Array<Record<string, unknown>>>([['legacy', eventLog]])
function scopedEvents(): Array<Record<string, unknown>> {
  const runtime = currentPropertyRuntime()
  const tenantId = runtime ? JSON.stringify(['property', runtime.scope.organizationId, runtime.scope.propertyId]) : currentTenantId()
  if (!tenantEvents.has(tenantId)) tenantEvents.set(tenantId, [])
  return tenantEvents.get(tenantId)!
}

function diagnosticScope() {
  const runtime = currentPropertyRuntime()
  return runtime ? { organizationId: runtime.scope.organizationId, propertyId: runtime.scope.propertyId }
    : { tenantId: currentTenantId() }
}

function logEvent(callId: string, e: Record<string, unknown>) {
  const events = scopedEvents()
  events.push({ ...e, callId, at: new Date().toISOString() })
  if (events.length > 2000) events.splice(0, events.length - 2000)
}

function parseToolArgs(raw: unknown): Record<string, unknown> | null {
  try {
    const args: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : null
  } catch { return null }
}

/** Screen string values recursively, including evidence and malformed nested fields. */
function emergencyInArgs(args: Record<string, unknown> | null, raw: unknown): EmergencySignal[] {
  if (args) {
    const pending: unknown[] = [args]
    const signals: EmergencySignal[] = []
    let visited = 0
    while (pending.length) {
      if (++visited > 10_000) throw new Error('Tool arguments exceed the screening limit')
      const value = pending.pop()
      if (typeof value === 'string') signals.push(...detectEmergency(value))
      else if (value && typeof value === 'object') pending.push(...Object.values(value))
    }
    return signals
  }
  // A truncated JSON string or accidental array must not allow an earlier booking
  // to run. This text is screened, never evaluated or treated as valid tool args.
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? ''
  return detectEmergency(text.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))))
}

function callEmergency(state: CallState): EmergencySignal | null {
  // Older call records held only the escalation detail. They still suspend leasing.
  return state.emergency ?? (state.escalation?.trigger === 'emergency'
    ? primaryEmergency(detectEmergency(state.escalation.detail)) : null)
}

/** Same screening bound as emergencies, including malformed or misnamed tool payloads. */
function tourChangeInArgs(args: Record<string, unknown> | null, raw: unknown): string | null {
  const pending: unknown[] = [args ?? raw]
  let visited = 0, found: string | null = null
  while (pending.length) {
    if (++visited > 10_000) throw new Error('Tool arguments exceed the screening limit')
    const value = pending.pop()
    if (typeof value === 'string') found ??= tourChangeExcerpt(value.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))))
    else if (value && typeof value === 'object') pending.push(...Object.values(value))
  }
  return found
}

class TourChangePersistenceError extends Error {
  constructor() { super('Tour change request persistence could not be verified') }
}

/** A separate durable staff record survives ordinary call freezing and late provider events. */
async function rememberTourChange(callId: string, reason: TourChangeRequest['reason'], excerpt: string | undefined,
  contact?: { phone?: string | null; name?: string | null; email?: string | null }): Promise<CallState> {
  try {
    await holdTourChange(calendarStore, callId, new Date())
    const current = await getCall(callId)
    await recordTourChangeRequest(documents, { callId, reason, at: new Date(), ...(excerpt ? { excerpt } : {}),
      phone: contact?.phone ?? current.phone ?? null, name: contact?.name ?? current.name, email: contact?.email ?? current.email })
    return await documents.update<CallState>(callKey(callId), freshCall(), raw => {
      const stored = reviveCall(raw)
      if (stored.completedAt || stored.work?.phase === 'frozen') return stored
      return { ...stored, tourChangeRequested: true,
        escalation: stored.escalation?.trigger === 'emergency' ? stored.escalation
          : { trigger: 'tour_change', detail: `Tour change requires staff review. No tour was changed and no notification was sent.${excerpt ? ` Caller: ${[...excerpt].slice(0, 1000).join('')}` : ''}` } }
    })
  } catch { throw new TourChangePersistenceError() }
}

/** Recording a report does not deliver a notification or dispatch a responder. */
async function rememberEmergency(callId: string, signal: EmergencySignal, toolsCalled: string[] = []): Promise<{
  state: CallState | null; hold: EmergencySignal | null; incident: boolean;
}> {
  let saved: CallState | null = null
  let hold: EmergencySignal | null = null
  let incident = false
  // Admission shares the calendar's atomic update. A conversation read alone cannot
  // prevent a concurrent booking with stale state. Record the pause before acknowledging.
  try { hold = await holdEmergency(calendarStore, callId, signal, new Date()) }
  catch { logEvent(callId, { kind: 'emergency_hold_failed', notificationStatus: 'not_sent' }) }
  try {
    saved = await documents.update<CallState>(callKey(callId), freshCall(), (raw) => {
      const current = reviveCall(raw)
      if (current.completedAt || current.work?.phase === 'frozen') return current
      const selected = primaryEmergency([callEmergency(current), signal].filter((e): e is EmergencySignal => Boolean(e)))!
      return { ...current, emergency: selected,
        escalation: { trigger: 'emergency', detail: `${selected.kind}: "${selected.matched}"` },
        toolsCalled: [...current.toolsCalled, ...toolsCalled],
      }
    })
  } catch {
    // A storage outage must not replace urgent safety guidance with a callback offer.
    // The independent calendar guard can preserve the pause if this projection fails.
    logEvent(callId, { kind: 'emergency_record_failed', notificationStatus: 'not_sent' })
  }
  try {
    // Safety reports remain independently visible even after the ordinary call
    // snapshot is frozen or complete. This does not send a staff notification.
    const selected = primaryEmergency([hold, saved && callEmergency(saved), signal].filter((value): value is EmergencySignal => Boolean(value)))!
    await recordCallSafetyEvent(documents, { callId, signal: selected, at: new Date(),
      ...(saved?.phone ? { phone: saved.phone } : {}), ...(saved?.name ? { name: saved.name } : {}) })
    incident = true
  } catch { logEvent(callId, { kind: 'emergency_incident_failed', notificationStatus: 'not_sent' }) }
  if (!saved?.completedAt) {
    logEvent(callId, { kind: 'emergency', emergencyKind: signal.kind, matched: signal.matched,
      persisted: saved !== null, bookingHoldPersisted: hold !== null, incidentPersisted: incident, notificationStatus: 'not_sent' })
    logEvent(callId, { kind: 'escalated', trigger: 'emergency', detail: `${signal.kind}: "${signal.matched}"`,
      persisted: saved !== null, notificationStatus: 'not_sent' })
  }
  return { state: saved, hold, incident }
}

function emergencyToolResponse(signal: EmergencySignal | null, name: string): string {
  const instruction = signal ? safetyInstruction(signal)
    : 'An emergency was reported during this call. If anyone is in immediate danger, call 911 from a safe location. Contact the building emergency line directly. I have not contacted emergency services or building staff.'
  return name === 'answer_question' ? instruction
    : `${instruction} Leasing actions are paused for this call. This requested action was not taken.`
}

/**
 * Runs one tool against the call's state, mutating it. The caller loads the state once
 * per webhook request, runs every tool in that request in order, and saves once.
 */
async function runTool(
  name: string, args: Record<string, unknown>, callId: string, now: Date, state: CallState,
  runtime?: ResolvedPropertyRuntime,
  execution?: { beforeBooking(): Promise<void>; bookingUncertain: boolean },
): Promise<string> {
  const { inventory, articles, property } = load(now, runtime)
  const unitIds = runtime ? inventory.units.map(unit => unit.unitId) : rawUnits.map(unit => unit.unitId)
  state.toolsCalled.push(name)

  const ctx: ToolContext = {
    propertyId: propertyId(runtime ? runtime.scope.propertyId : String(property.id ?? 'prop-demo')),
    interactionId: interactionId(callId),
    inventory,
    articles,
    qualification: state.qualification,
    jurisdiction: runtime ? runtime.snapshot.jurisdiction : 'NY',
    confidenceThreshold: 0.7,
    now,
  }

  switch (name) {
    case 'capture_contact': {
      if (args.requestType !== undefined && args.requestType !== 'tour_change') return 'Invalid request type. Use tour_change only for an actual request to change an existing tour.'
      if (typeof args.excerpt !== 'string' || !args.excerpt.trim()) return 'Ask for the caller’s contact details before recording them.'
      if (args.email !== undefined && (typeof args.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email))) return 'That email address is incomplete. Ask them to spell it once.'
      if (args.phone !== undefined && (typeof args.phone !== 'string' || !/^\+?[\d ()+.-]{7,25}$/.test(args.phone))) return 'That callback number is incomplete. Ask them to repeat it once.'
      if (typeof args.name === 'string' && args.name.trim()) state.name = args.name.trim().slice(0, 120)
      if (typeof args.email === 'string') state.email = args.email.trim().slice(0, 254)
      if (typeof args.phone === 'string') state.phone = normalisePhone(args.phone)
      logEvent(callId, { kind: 'contact_captured', name: state.name, email: state.email, excerpt: args.excerpt.slice(0, 1000) })
      if (state.tourChangeRequested || args.requestType === 'tour_change') {
        const saved = await rememberTourChange(callId, 'caller_requested', args.excerpt, state)
        state.tourChangeRequested = true
        state.escalation = saved.escalation
        return TOUR_CHANGE_SAVED
      }
      return 'Contact details saved for the leasing team. Nothing has been sent. Continue helping them.'
    }
    case 'capture_signal': {
      const r = captureSignal(args as never, ctx)
      if (r.qualificationPatch) state.qualification = r.qualificationPatch
      logEvent(callId, r.record)
      return r.say
    }

    case 'check_availability': {
      if ((args.sortBy !== undefined && args.sortBy !== 'price_desc')
        || (args.includeOutsideMoveIn !== undefined && typeof args.includeOutsideMoveIn !== 'boolean')
        || (args.ignoreBudget !== undefined && typeof args.ignoreBudget !== 'boolean')) {
        return 'Invalid availability search options. Use sortBy as price_desc and use true or false for includeOutsideMoveIn and ignoreBudget. Broaden timing or price only when the caller requests it.'
      }
      // Under exactOptionalPropertyTypes an absent key and an explicit `undefined` are
      // different types, so only include what the model actually sent.
      const r = checkAvailability(ctx, {
        ...(args.unitId ? { unitId: String(args.unitId) } : {}),
        ...(args.reason ? { reason: String(args.reason) } : {}),
        ...(args.moveIn ? { moveIn: String(args.moveIn) } : {}),
        ...(args.bedrooms ? { bedrooms: String(args.bedrooms) } : {}),
        ...(args.budget ? { budget: String(args.budget) } : {}),
        ...(args.sortBy === 'price_desc' ? { sortBy: 'price_desc' as const } : {}),
        ...(typeof args.includeOutsideMoveIn === 'boolean' ? { includeOutsideMoveIn: args.includeOutsideMoveIn } : {}),
        ...(typeof args.ignoreBudget === 'boolean' ? { ignoreBudget: args.ignoreBudget } : {}),
      })
      if (r.qualificationPatch) state.qualification = r.qualificationPatch
      logEvent(callId, r.record)
      const offered = (r.record.unitsOffered as string[] | undefined) ?? []
      state.unitsDiscussed = [...new Set([...state.unitsDiscussed, ...offered])]
      return r.say
    }

    case 'answer_question': {
      if (state.tourChangeRequested && tourChangeExcerpt(args.question)) return TOUR_CHANGE_SAVED
      const r = answerQuestion(args as never, ctx)
      logEvent(callId, r.record)
      if (r.escalate) {
        logEvent(callId, { kind: 'escalated', trigger: r.escalate.trigger, detail: r.escalate.detail })
        state.escalation = r.escalate
      }
      if (r.emergency) state.emergency = r.emergency
      return r.say
    }

    case 'list_tour_slots': {
      if (state.tourChangeRequested) return TOUR_CHANGE_SAVED
      const timeZone = tourTimeZone(property, callId)
      if (!timeZone) return CALENDAR_CONFIGURATION_UNAVAILABLE
      const preferredDate = args.preferredDate ? String(args.preferredDate) : undefined
      if (args.preferredTime !== undefined && (typeof args.preferredTime !== 'string' || !VALID_WALL_TIME.test(args.preferredTime))) {
        return 'That time is invalid. Use preferredTime as a 24-hour HH:mm time in the building’s timezone, such as 16:00 for 4 PM.'
      }
      const preferredTime = args.preferredTime as string | undefined
      if (preferredTime !== undefined && !preferredDate) return 'Ask which date the caller wants, then pass preferredDate as YYYY-MM-DD together with preferredTime as HH:mm.'
      let from = now, to: Date
      try {
        if (preferredDate) {
          from = parseCalendarDate(preferredDate, timeZone)
          if (preferredDate < localDate(now, timeZone)) return 'That date is in the past. Ask which future date works for the caller.'
        }
        to = parseCalendarDate(addCalendarDays(localDate(from, timeZone), 15), timeZone)
      } catch { return 'That date is invalid. Ask for a real date and call list_tour_slots using YYYY-MM-DD.' }
      const requestedUnit = args.unitId ? String(args.unitId).trim().toUpperCase() : null
      const unitId = requestedUnit ? unitIds.find(id => id.toUpperCase() === requestedUnit) ?? null : null
      if (requestedUnit && !unitId) return 'That residence is not in the building inventory. Confirm a residence returned by check_availability, or omit unitId for a general building tour.'
      const slots = await callCalendar(now, timeZone, runtime).listSlots(ctx.propertyId, from, to, unitId)
      const { offered, daysOpen } = pickSlotsToOffer(slots, preferredDate, timeZone, preferredTime)
      logEvent(callId, { kind: 'slots_listed', count: offered.length, daysOpen })
      if (offered.length === 0) {
        const window = effectiveOptions(await calendarStore.read(), { ...runtime?.tourSettings, timeZone }).bookingWindowDays
        return `No bookable tour times were found in this requested date range.${window == null ? '' : ` This building accepts bookings up to ${window} days ahead.`} Ask for another date or offer a leasing-team callback. Do not say the whole calendar is full.`
      }
      const preferredClosed = preferredDate && !offered.some(s => localDate(s.startsAt, timeZone) === preferredDate)
      const timeMissing = preferredTime && !preferredClosed && !offered.some(s => {
        const minutes = wallMinutes(s.startsAt, timeZone)
        return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` === preferredTime
      })
      const explanation = preferredClosed ? `No times are open on ${preferredDate}; these are alternatives on other dates. `
        : timeMissing ? `No tour starts at ${preferredTime} on ${preferredDate}; these are the nearest available times on that date. ` : ''
      const more = daysOpen > 3 ? ` Other days are open too — ask which date works and call this again with preferredDate as YYYY-MM-DD.` : ''
      return `${explanation}Real open tour times${unitId ? ` for residence ${unitId}` : ''} in the building's local time — offer two or three, and use the slotId when booking:\n${offered.map((s) => `${s.slotId} — ${fmtSlot(s, timeZone)}`).join('\n')}${more}`
    }

    case 'book_tour': {
      if (state.tourChangeRequested) return TOUR_CHANGE_SAVED
      const timeZone = tourTimeZone(property, callId)
      if (!timeZone) return CALENDAR_CONFIGURATION_UNAVAILABLE
      const slotId = String(args.slotId ?? '')
      if (!/^slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slotId)) return 'That slot is invalid. Call list_tour_slots again and offer a real time.'
      const requestedStart = new Date(`${slotId.slice(5)}:00.000Z`)
      if (!Number.isFinite(requestedStart.getTime()) || requestedStart.toISOString().slice(0, 16) !== slotId.slice(5)) return 'That slot is invalid. Call list_tour_slots again.'
      const slots = generateSlots(now, { ...effectiveOptions(await calendarStore.read(), { ...runtime?.tourSettings, timeZone }), from: requestedStart, to: new Date(requestedStart.getTime() + 86400000) })
      const slot = slots.find((s) => s.slotId === args.slotId)
      if (!slot) return 'That slot is not on the calendar. Call list_tour_slots again and offer a real time.'
      const requestedUnit = args.unitId ? String(args.unitId).trim().toUpperCase() : null
      const unitId = requestedUnit ? unitIds.find(id => id.toUpperCase() === requestedUnit) ?? null : null
      if (requestedUnit && !unitId) return 'That residence is not in the building inventory. Confirm a residence returned by check_availability, or offer a general building tour.'

      state.name = String(args.prospectName ?? state.name ?? '')
      state.email = args.prospectEmail ? String(args.prospectEmail) : state.email

      await execution?.beforeBooking()
      const booking = await bookTour({
        propertyId: ctx.propertyId,
        interactionId: ctx.interactionId,
        personId: null,
        prospectName: state.name || 'there',
        prospectPhone: state.phone ?? callId,
        prospectEmail: state.email,
        slot,
        unitId,
        floorPlanId: null,
      }, callCalendar(now, timeZone, runtime), { now, makeIntentId: () => `intent-${callId}-${slot.slotId}` })
      if (execution) execution.bookingUncertain = booking.state.status === 'arranging' || booking.state.status === 'failed'

      logEvent(callId, {
        kind: 'tour_booked', status: booking.state.status,
        slot: fmtSlot(slot, timeZone), slotId: slot.slotId, startsAt: slot.startsAt.toISOString(), timeZone, unitId,
        prospectName: state.name, prospectEmail: state.email,
      })
      state.booking = {
        slotId: slot.slotId, startsAt: slot.startsAt.toISOString(),
        unitId,
        ...('externalId' in booking.state && booking.state.externalId ? { externalId: booking.state.externalId } : {}),
        status: booking.state.status === 'confirmed' ? 'confirmed'
          : booking.state.status === 'arranging' ? 'arranging' : 'failed',
      }
      return sayableStatus(booking, timeZone)
    }

    case 'capture_loss_reason': {
      const r = captureLossReason({
        kind: args.kind as never,
        detail: String(args.detail ?? ''),
        evidence: String(args.evidence ?? ''),
        confidence: 0.9,
      }, ctx)
      logEvent(callId, r.record)
      state.lossReason = (r.record as { reason: LossReason }).reason
      return r.say
    }

    default:
      return `Unknown tool: ${name}`
  }
}

/** Bind the full async request before any document, calendar, event or history operation. */
export default async function handler(req: any, res: any) {
  res.atriumRequestId = randomUUID()
  req.atriumRequestId = res.atriumRequestId
  res.setHeader('x-request-id', res.atriumRequestId)
  let databaseMode: boolean
  try { databaseMode = isPostgresRuntime() }
  catch (error) {
    const result = readRuntimeError(error)
    res.setHeader('cache-control', 'no-store')
    return res.status(result.status).json(result.body)
  }
  if (databaseMode) return databaseHandler(req, res)
  if (req.method === 'GET') {
    const auth = authorizeOps(req.headers ?? {}, new Date())
    if (!auth.ok) return scopedHandler(req, res, undefined, auth)
    if (req.headers?.['x-atrium-tenant-id'] !== undefined && req.headers['x-atrium-tenant-id'] !== auth.tenantId) {
      res.setHeader('cache-control', 'no-store')
      return res.status(409).json({error:'The signed-in workspace changed. Reload this page before continuing.',code:'portal_tenant_changed'})
    }
    return withTenant(auth.tenantId, () => scopedHandler(req, res, undefined, auth))
  }
  if (req.method === 'POST') {
    let body: unknown
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body }
    catch { return scopedHandler(req, res) }
    const tenantId = webhookTenant(body)
    if (!tenantId) {
      res.setHeader('cache-control', 'no-store')
      res.status(403).json({ error: 'This assistant is not assigned to a workspace.' })
      return
    }
    // scopedHandler still verifies the webhook credential before using this routing scope.
    return withTenant(tenantId, () => scopedHandler(req, res))
  }
  return scopedHandler(req, res)
}

function verifyDatabaseWebhook(req: any, res: any): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET?.trim()
  if (!expected) {
    res.status(503).json({ error: 'Webhook verification is not configured' })
    return false
  }
  const bearer = req.headers?.authorization
  const provided = req.headers?.['x-vapi-secret'] ?? req.headers?.['x-vapi-signature']
    ?? (typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : undefined)
  if (typeof provided !== 'string' || !constantTimeEquals(provided, expected)) {
    res.status(401).json({ error: 'unauthorized' })
    return false
  }
  return true
}

/** Pure fallback only: never reads property facts, persists a pause, or notifies staff. */
function unavailableEmergencyResponse(body: any): Record<string, unknown> | null {
  const message = body?.message
  if (!message || typeof message !== 'object') return null
  let signal: EmergencySignal | null = null
  let toolCalls: any[] = []
  if (message.type === 'transcript' && message.role === 'user'
    && (!message.transcriptType || message.transcriptType === 'final') && typeof message.transcript === 'string') {
    signal = primaryEmergency(detectEmergency(message.transcript))
  } else if (message.type === 'tool-calls') {
    const list = message.toolCallList ?? message.toolCalls
    if (!Array.isArray(list)) return null
    // Bound the fallback independently of upstream body limits. Each argument tree
    // uses the same 10,000-node screening limit as normal tool execution.
    toolCalls = list.slice(0, 100)
    const signals: EmergencySignal[] = []
    for (const tc of toolCalls) {
      const raw = tc?.arguments ?? tc?.function?.arguments ?? {}
      try { signals.push(...emergencyInArgs(parseToolArgs(raw), raw)) }
      catch { /* Oversized malformed evidence cannot authorize any action. */ }
    }
    signal = primaryEmergency(signals)
  }
  if (!signal) return null
  const instruction = safetyInstruction(signal)
  return {
    error: 'The emergency pause could not be verified. Retry is required.',
    code: 'emergency_persistence_unavailable', retryable: true, safetyInstruction: instruction,
    ...(toolCalls.length ? { results: toolCalls.filter(tc => typeof (tc?.id ?? tc?.toolCallId) === 'string').map(tc => ({
      toolCallId: tc.id ?? tc.toolCallId,
      result: `${instruction} Do not continue with leasing actions. This requested action was not confirmed.`,
    })) } : {}),
  }
}

/** Resolve one server-owned property scope after transport authentication. */
async function databaseHandler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow')
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET or POST only' })
  // No property lookup, account query or store access happens before this check.
  if (req.method === 'POST' && !verifyDatabaseWebhook(req, res)) return
  let emergencyFallback: Record<string, unknown> | null = null
  try {
    let runtime: ResolvedPropertyRuntime
    if (req.method === 'GET') runtime = await resolveOpsRuntime(req, 'read', new Date())
    else {
      let body: unknown
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body }
      catch { return res.status(400).json({ error: 'Invalid webhook body' }) }
      emergencyFallback = unavailableEmergencyResponse(body)
      const assistantId = webhookAssistantId(body)
      if (!assistantId) throw new RuntimeRequestError(403, 'invalid_assistant_identity', 'A valid bound assistant identity is required.')
      runtime = await resolveVerifiedChannelRuntime('vapi', assistantId, new Date(), res.atriumRequestId, runtimeForRequest(req))
      req.body = body
    }
    const json = res.json
    res.json = function (body: Record<string, unknown>) { return json.call(this, { ...body, scope: runtime.responseScope }) }
    try { return await runWithPropertyRuntime(runtime, () => scopedHandler(req, res, runtime)) }
    finally { res.json = json }
  } catch (error) {
    if (emergencyFallback) return res.status(503).json(emergencyFallback)
    const result = readRuntimeError(error)
    res.status(result.status).json(result.body)
  }
}

async function scopedHandler(req: any, res: any, runtime?: ResolvedPropertyRuntime, legacyAuth?: ReturnType<typeof authorizeOps>) {
  // The dashboard reads the log from this same function deliberately: on serverless each
  // function gets its own memory, so a separate endpoint would see an empty log. This is
  // warm-instance scoped and resets when the instance recycles — fine for a demo, and the
  // reason a KV-backed RecordStore is the first thing to add for anything real.
  //
  // It is also the most sensitive thing this service holds: prospect names, email
  // addresses, budget ceilings and the caller's own words. So it is gated by the same
  // operations session that serves the dashboard page, and there is no partial answer —
  // an unauthenticated request gets a status code, never a redacted event, never a count.
  // Redaction is where leaks come back: somebody adds a field to the "safe" shape later.
  if (req.method === 'GET') {
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
    res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
    res.setHeader('referrer-policy', 'no-referrer')

    const auth = runtime ? null : legacyAuth ?? authorizeOps(req.headers ?? {}, new Date())
    if (auth && !auth.ok) {
      res.status(auth.reason === 'not_configured' ? 503 : 401).json({
        error: auth.reason === 'not_configured'
          ? 'The operations log is closed until OPS_DASHBOARD_PASSCODE is set.'
          : 'unauthorized',
      })
      return
    }

    /*
     * Calls come from Vapi, not from eventLog. On serverless each request may land on a
     * different instance, so a dashboard request routinely queried an instance that had
     * never seen the call and the log looked empty — the call was not lost, it was
     * somewhere else. Vapi holds the authoritative record and needs no second store to
     * drift from it.
     *
     * eventLog is still returned because it carries what this process decided — the quote
     * gate, the priced-out gap, which article answered — that Vapi has no view of. It is
     * supplementary now, not the source.
     */
    const history = await callHistory(runtime ? runtime.assistantIds : auth?.ok && auth.tenantId !== 'legacy' ? auth.assistantIds : undefined, runtime)
    let safetyEvents: ReturnType<typeof safetyEventForOps>[] = []
    let safetyEventsError: string | null = null
    try { safetyEvents = (await listCallSafetyEvents(documents)).map(safetyEventForOps) }
    catch { safetyEventsError = 'Saved emergency reports are temporarily unavailable. Retry before assuming there are none.' }
    // An upstream fetch can outlast a membership or assistant-binding change.
    // Recheck the existing scope before releasing calls or in-process events.
    if (runtime) await runtime.revalidate()

    res.status(200).json({
      calls: history.calls,
      callsError: history.error,
      callsConfigured: history.configured,
      callsStale: history.stale,
      events: [...scopedEvents().filter(event => event.kind !== 'emergency' || !safetyEvents.some(saved => saved.callId === event.callId)), ...safetyEvents],
      safetyEventsError,
      generatedAt: new Date().toISOString(),
      note: history.error
        ? (history.stale ? 'Call history is the last good read; Vapi did not answer this time.' : 'Call history unavailable — see callsError.')
        : 'Calls from Vapi. Emergency reports are stored in this workspace; other decision events reset on cold start.',
    })
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'GET or POST only' })
    return
  }

  // Verify the request is genuinely from Vapi when a secret is configured.
  if (!runtime) {
    const expected = process.env.VAPI_WEBHOOK_SECRET?.trim()
    if (!expected && (process.env.VERCEL || process.env.NODE_ENV === 'production' || currentTenantId() !== 'legacy')) {
      res.status(503).json({ error: 'Webhook verification is not configured' })
      return
    }
    if (expected) {
      const bearer = req.headers?.authorization
      const provided = req.headers?.['x-vapi-secret'] ?? req.headers?.['x-vapi-signature']
        ?? (typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : undefined)
      if (typeof provided !== 'string' || !constantTimeEquals(provided, expected)) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
    }
  }

  const now = new Date()
  let callId = 'unknown-call'
  let pendingToolIds: unknown[] = []
  let hasAdmittedWork = false

  try {
    // Parsing lives inside the try deliberately. A malformed body thrown here would
    // otherwise escape as a 500, and a 500 to Vapi drops the call on the caller — the one
    // failure mode a leasing line cannot have.
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const message = body?.message ?? {}
    callId = String(message?.call?.id ?? body?.call?.id ?? 'unknown-call')

    /*
     * Emergency screening on every finished caller turn, ahead of anything the model
     * decides to do. Vapi also streams partial transcripts — several a second while
     * someone is talking — and each one used to cost a function invocation and a store
     * read. They are ignored: the final transcript of the same words follows within a
     * second, and that is the one screened.
     */
    if (message.type === 'transcript' && message.transcriptType && message.transcriptType !== 'final') {
      res.status(200).json({})
      return
    }
    if (runtime && callId !== 'unknown-call') {
      if (!callId || callId.length > 256 || /[\u0000-\u0020\u007f]/.test(callId)) throw new Error('Invalid call identity')
      // Claim the provider call atomically before any calendar hold or tool write.
      // Existing records with missing/different routing require explicit migration.
      await documents.update<CallState>(callKey(callId), freshCall(), raw => reviveCall(raw))
    }
    if (message.type === 'transcript' && message.role === 'user' && message.transcript) {
      const { inventory, articles, property } = load(now, runtime)
      const emergency = checkEmergency(String(message.transcript), {
        propertyId: propertyId(runtime ? runtime.scope.propertyId : String(property.id ?? 'prop-demo')),
        interactionId: interactionId(callId),
        inventory, articles,
        qualification: emptyQualification(),
        jurisdiction: runtime ? runtime.snapshot.jurisdiction : 'NY', confidenceThreshold: 0.7, now,
      })
      if (emergency) {
        if (callId !== 'unknown-call' && emergency.emergency) {
          const recorded = await rememberEmergency(callId, emergency.emergency)
          if (!recorded.hold || !recorded.state || !recorded.incident) {
            res.status(503).json({ error: 'Emergency pause could not be persisted; retry required.',
              code: 'emergency_persistence_unavailable', safetyInstruction: safetyInstruction(emergency.emergency) })
            return
          }
        }
        else logEvent(callId, { ...emergency.record, persisted: false, notificationStatus: 'not_sent' })
      }
      else {
        const excerpt = tourChangeExcerpt(message.transcript)
        if (excerpt) {
          if (callId === 'unknown-call') {
            res.status(400).json({ code: 'call_identity_required', error: TOUR_CHANGE_UNSAVED }); return
          }
          try {
            await rememberTourChange(callId, 'caller_requested', excerpt, {
              phone: message.call?.customer?.number ?? body.call?.customer?.number })
          } catch {
            res.setHeader('retry-after', '2')
            res.status(503).json({ code: 'tour_change_persistence_unavailable', retryable: true, error: TOUR_CHANGE_UNSAVED }); return
          }
        }
      }
      res.status(200).json({})
      return
    }

    if (message.type === 'tool-calls') {
      /*
       * In order, against one copy of the state, saved once. The model emits several tool
       * calls in one turn — capture the budget AND check availability — and running them
       * concurrently had each read the same state, so the availability check never saw the
       * budget, told the model to ask for it again, and whichever save landed last threw
       * the other's away. That was the "just confirming…" loop on a real call.
       */
      const list = message.toolCallList ?? message.toolCalls ?? []
      if (!Array.isArray(list)) throw new Error('Invalid tool-call list')
      pendingToolIds = list.map((tc) => tc?.id ?? tc?.toolCallId).filter((id) => typeof id === 'string')
      if (callId === 'unknown-call') throw new Error('A call id is required for tool calls')
      const prepared = list.map((tc) => {
        const raw = tc?.arguments ?? tc?.function?.arguments ?? {}
        const args = parseToolArgs(raw)
        return { toolCallId: tc?.id ?? tc?.toolCallId,
          name: String(tc?.name ?? tc?.function?.name ?? ''), args, raw,
          emergencies: emergencyInArgs(args, raw),
          tourChange: args?.requestType === 'tour_change' && typeof args.excerpt === 'string' && args.excerpt.trim()
            ? [...args.excerpt].slice(0, 1000).join('') : tourChangeInArgs(args, raw),
        }
      })
      // Screen the entire batch BEFORE any tool runs: the model may put book_tour
      // before answer_question("I smell gas"). Ordering cannot permit that booking.
      const batchEmergency = primaryEmergency(prepared.flatMap((tc) => tc.emergencies))
      if (batchEmergency) {
        const recorded = await rememberEmergency(callId, batchEmergency, prepared.map((tc) => tc.name))
        const saved = recorded.state
        const signal = primaryEmergency([saved && callEmergency(saved), recorded.hold, batchEmergency].filter((e): e is EmergencySignal => Boolean(e)))!
        const persisted = recorded.hold !== null && saved !== null && recorded.incident
        res.status(persisted ? 200 : 503).json({
          ...(!persisted ? { code: 'emergency_persistence_unavailable' } : {}),
          results: prepared.map((tc) => ({ toolCallId: tc.toolCallId,
          result: emergencyToolResponse(signal, tc.name),
        })) })
        return
      }
      // Independent from the call projection, so a failed call-record write cannot
      // clear an acknowledged pause when another instance handles the next request.
      const [holdRead, callRead] = await Promise.allSettled([
        calendarStore.read().then(calendar => heldEmergency(calendar, callId)), getCall(callId),
      ])
      const activeHold = holdRead.status === 'fulfilled' ? holdRead.value : null
      let state = callRead.status === 'fulfilled' ? callRead.value : freshCall()
      if (state.completedAt && !state.work) {
        res.status(200).json({ results: pendingToolIds.map((toolCallId) => ({
          toolCallId, result: 'This call has already ended. No action was taken.',
        })) })
        return
      }
      if (activeHold || state.emergency || state.escalation?.trigger === 'emergency') {
        const signal = primaryEmergency([activeHold, callEmergency(state)].filter((e): e is EmergencySignal => Boolean(e)))
        let incomplete = holdRead.status === 'rejected' || callRead.status === 'rejected'
        if (signal && signal.kind !== activeHold?.kind) {
          try { await holdEmergency(calendarStore, callId, signal, now) }
          catch { incomplete = true }
        }
        for (const tc of prepared) logEvent(callId, { kind: 'tool_blocked', name: tc.name, reason: 'emergency_active' })
        res.status(incomplete ? 503 : 200).json({
          ...(incomplete ? { code: 'emergency_persistence_unavailable' } : {}), results: prepared.map((tc) => ({
          toolCallId: tc.toolCallId, result: emergencyToolResponse(signal, tc.name),
        })) })
        return
      }
      if (holdRead.status === 'rejected' || callRead.status === 'rejected') throw new Error('Call safety state could not be verified')
      const provenance = callProvenance(runtime)
      const identities = prepared.map(tc => {
        if (typeof tc.toolCallId !== 'string') throw new CallLifecycleError('call_work_invalid')
        return { id: tc.toolCallId, name: tc.name, argsHash: hashCallToolArgs(tc.args ?? { invalidArguments: tc.raw }) }
      })
      const token = randomUUID()
      let admission: ReturnType<typeof admitToolBatch> | undefined
      try {
        state = reviveCall(await documents.update<CallState>(callKey(callId), freshCall(), raw => {
          const current = reviveCall(raw)
          if (current.completedAt && !current.work) throw new CallLifecycleError('call_closed')
          const route = lifecycleRoute(current, provenance)
          admission = admitToolBatch(current.work ?? initializeCallLifecycle({ now: now.toISOString(), ...route }),
            { token, tools: identities, now: now.toISOString(), ...route })
          return { ...current, work: admission.work }
        }))
      } catch (error) {
        if (error instanceof CallLifecycleError) throw error
        // An independent safety request may have committed after our first reads,
        // while this call-record admission failed. Preserve any known guidance.
        const safety = await Promise.allSettled([
          calendarStore.read().then(calendar => heldEmergency(calendar, callId)),
          getCall(callId).then(current => callEmergency(current)),
        ])
        const signal = primaryEmergency(safety.flatMap(item => item.status === 'fulfilled' && item.value ? [item.value] : []))
        res.setHeader('retry-after', '2')
        res.status(503).json({ code: signal ? 'emergency_persistence_unavailable' : 'call_work_unavailable', retryable: true,
          results: prepared.map(tc => ({ toolCallId: tc.toolCallId, result: signal ? emergencyToolResponse(signal, tc.name)
            : 'The call work could not be admitted safely. No action was taken; retry or ask the leasing team for help.' })) })
        return
      }
      const accepted = admission!
      const cached = new Map(accepted.results.map(item => [item.toolId, item.result]))
      const batchChange = prepared.find(tc => tc.tourChange)?.tourChange
      let tourChangeSaveFailed = false
      const providerPhone = message.call?.customer?.number ?? body.call?.customer?.number
      if (batchChange || state.tourChangeRequested) {
        state.tourChangeRequested = true
        try {
          state = await rememberTourChange(callId, 'caller_requested', batchChange ?? undefined, {
            phone: state.phone ?? (typeof providerPhone === 'string' ? providerPhone : null), name: state.name, email: state.email })
        } catch { tourChangeSaveFailed = true }
      }
      if (!accepted.admission) {
        const results = prepared.map(tc => ({ toolCallId: tc.toolCallId,
          result: tourChangeSaveFailed ? TOUR_CHANGE_UNSAVED
            : cached.get(tc.toolCallId) === TOUR_CHANGE_UNSAVED ? TOUR_CHANGE_SAVED : cached.get(tc.toolCallId)! }))
        if (tourChangeSaveFailed) {
          res.setHeader('retry-after', '2')
          res.status(503).json({ results, code: 'tour_change_persistence_unavailable', retryable: true }); return
        }
        try { await finishEndedCall(callId, state, now, runtime) }
        catch {
          res.setHeader('retry-after', '2')
          res.status(503).json({ results, code: 'call_projection_pending', retryable: true })
          return
        }
        res.status(200).json({ results })
        return
      }
      hasAdmittedWork = true
      const freshIds = new Set(accepted.admission.toolIds)
      const before = structuredClone(state)
      const phone = message.call?.customer?.number ?? body.call?.customer?.number
      if (!state.phone && typeof phone === 'string' && phone.trim()) state.phone = normalisePhone(phone)
      const results: Array<{ toolCallId: unknown; result: string }> = []
      const completions: CallToolResult[] = []
      let pauseUnpersisted = false
      let unresolved = false
      for (const tc of prepared) {
        if (!freshIds.has(tc.toolCallId)) {
          results.push({ toolCallId: tc.toolCallId, result: cached.get(tc.toolCallId)! })
          continue
        }
        const name = tc.name
        const toolStartedAt = performance.now()
        let result: string
        let errorCode: string | null = null
        let outcome: CallToolResult['outcome'] = 'complete'
        const execution = {
          bookingUncertain: false,
          beforeBooking: async () => {
            await documents.update<CallState>(callKey(callId), freshCall(), raw => {
              const current = reviveCall(raw)
              if (!current.work) throw new CallLifecycleError('call_admission_stale')
              return { ...current, work: markToolDispatch(current.work, { token, toolId: tc.toolCallId, now: new Date().toISOString() }) }
            })
          },
        }
        try {
          if (state.emergency || state.escalation?.trigger === 'emergency') {
            result = emergencyToolResponse(callEmergency(state), name)
            outcome = 'blocked'
          } else if (tourChangeSaveFailed) {
            result = TOUR_CHANGE_UNSAVED
            outcome = 'blocked'
          } else if (unresolved) {
            result = 'An earlier action needs staff review. This additional action was not taken.'
            outcome = 'blocked'
          } else {
            if (!tc.args) throw new Error('Invalid tool arguments')
            result = await runTool(name, tc.args, callId, now, state, runtime, execution)
            if (execution.bookingUncertain) { outcome = 'needs_review'; unresolved = true }
            if (state.emergency) {
              const recorded = await rememberEmergency(callId, state.emergency)
              pauseUnpersisted ||= !recorded.hold || !recorded.state || !recorded.incident
            }
          }
        } catch (error) {
          errorCode = 'tool_failed'
          if (error instanceof TourChangeRequiredError) {
            // Calendar CAS has authoritatively refused the write. Dispatch was
            // marked before that check, so complete its known negative result.
            outcome = 'complete'
            state.tourChangeRequested = true
            try {
              const saved = await rememberTourChange(callId, error.reason, undefined, state)
              state.tourChangeRequested = true
              state.escalation = saved.escalation
              result = TOUR_CHANGE_SAVED
            } catch { result = TOUR_CHANGE_UNSAVED; tourChangeSaveFailed = true }
          } else if (error instanceof TourChangePersistenceError) {
            result = TOUR_CHANGE_UNSAVED; tourChangeSaveFailed = true; outcome = 'blocked'
          } else if (error instanceof Error && error.message === 'CALENDAR_INTERACTION_PAUSED') {
            state.emergency = error instanceof CalendarInteractionPausedError ? error.signal : callEmergency(state)
            state.escalation = { trigger: 'emergency', detail: 'Leasing paused by the calendar safety guard.' }
            result = emergencyToolResponse(state.emergency, name)
          } else {
            result = 'I could not verify that action. Ask for clarification or offer a callback; do not claim it succeeded.'
            outcome = name === 'book_tour' ? 'needs_review' : 'blocked'
            unresolved ||= outcome === 'needs_review'
          }
        }
        results.push({ toolCallId: tc.toolCallId, result })
        completions.push({ toolId: tc.toolCallId, result, outcome })
        // What each tool decided, for the runtime log — no names, numbers or caller words.
        const events = scopedEvents()
        const last = events[events.length - 1] ?? {}
        console.log('[tool]', JSON.stringify({
          ...diagnosticScope(), requestId: res.atriumRequestId, callId,
          toolCallId: tc.toolCallId, name, durationMs: Math.round(performance.now() - toolStartedAt), errorCode,
          ...(last.callId === callId ? {
            kind: last.kind, outcome: last.outcome ?? last.decision ?? null,
            topic: last.topic ?? null, confidence: last.confidence ?? null,
            signal: last.signal ?? null, captured: last.captured ?? null,
            offered: Array.isArray(last.unitsOffered) ? last.unitsOffered.length : null,
          } : {}),
        }))
      }
      let saved: CallState | undefined
      try { saved = await saveCall(callId, state, before, { token, results: completions }) }
      catch (error) {
        if (!state.emergency && state.escalation?.trigger !== 'emergency') throw error
        // Do not replace an already known safety instruction with generic failure copy.
        pauseUnpersisted = true
        logEvent(callId, { kind: 'emergency_record_failed', notificationStatus: 'not_sent' })
      }
      let projectionFailed = false
      if (saved && !unresolved && !pauseUnpersisted) {
        try { await finishEndedCall(callId, saved, new Date(), runtime) }
        catch {
          projectionFailed = true
          logEvent(callId, { kind: 'error', message: 'Finished-call projection remains pending after admitted work completed.' })
        }
      }
      if (unresolved || projectionFailed || tourChangeSaveFailed) res.setHeader('retry-after', '2')
      res.status(pauseUnpersisted || unresolved || projectionFailed || tourChangeSaveFailed ? 503 : 200).json({ results,
        ...(pauseUnpersisted ? { code: 'emergency_persistence_unavailable' }
          : tourChangeSaveFailed ? { code: 'tour_change_persistence_unavailable', retryable: true }
          : unresolved ? { code: 'call_work_unresolved', retryable: true }
            : projectionFailed ? { code: 'call_projection_pending', retryable: true } : {}),
      })
      return
    }

    if (message.type === 'status-update') {
      logEvent(callId, { kind: 'call_status', status: message.status })
    }

    if (message.type === 'end-of-call-report') {
      if (callId === 'unknown-call') {
        res.status(400).json({ error: 'A call id is required for a finished-call report' })
        return
      }
      logEvent(callId, { kind: 'call_status', status: 'end-of-call-report' })
      /*
       * The one moment the whole call is known. Fold it into the caller's profile and
       * derive what the building should do next about them. This call has already ended;
       * unlike an interactive tool response, a failed write must not be acknowledged as
       * successful delivery. The inbox preserves accepted work for explicit replay.
       */
      try {
        const call = message.call ?? body.call ?? {}
        const started = reportInstant(message.startedAt ?? call.startedAt)
        const ended = reportInstant(message.endedAt ?? call.endedAt)
        const duration = Number.isFinite(started) && Number.isFinite(ended) ? Math.round((ended - started) / 1000) : null
        const reported = call?.customer?.number ?? message.customer?.number
        const provenance = callProvenance(runtime)
        const state = reviveCall(await documents.update<CallState>(callKey(callId), freshCall(), raw => {
          const current = reviveCall(raw)
          if (current.completedAt && !current.work) return current
          const route = lifecycleRoute(current, provenance)
          const work = current.work ?? initializeCallLifecycle({ now: now.toISOString(), ...route })
          return { ...current, work: requestCallEnd(work, { now: now.toISOString(), ...route, metadata: {
            eventKey: `end:${hashCallToolArgs({ callId })}`,
            startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null,
            endedAt: Number.isFinite(ended) ? new Date(ended).toISOString() : null,
            reportedPhone: typeof reported === 'string' ? normalisePhone(reported) : null,
            durationSeconds: duration !== null && duration >= 0 && duration <= 604_800 ? duration : null,
          } }) }
        }))
        if (state.completedAt) { res.status(200).json({}); return }
        // PostgreSQL freezes, projects receipt/profile/follow-ups, and completes the
        // same call revision atomically. KV retains the frozen snapshot for replay.
        const completed = runtime
          ? await runtime.documents.transaction(store => projectFrozenCall(store, callId, now, runtime))
          : await projectFrozenCall(documents, callId, now)
        const phone = completed.phone
        console.log('[call]', JSON.stringify({
          ...diagnosticScope(), requestId: res.atriumRequestId, callId,
          consolidated: true, hasPhone: Boolean(phone && phone !== 'unknown'),
          tools: state.toolsCalled.length, booked: state.booking?.status ?? null,
          escalated: Boolean(state.escalation), store: documents.describe().kind,
        }))
      } catch (err) {
        if (err instanceof CallLifecycleError) { lifecycleResponse(res, err); return }
        console.error('[vapi]', JSON.stringify({ ...diagnosticScope(), requestId: res.atriumRequestId, callId, errorCode: 'consolidation_failed' }))
        logEvent(callId, { kind: 'error', message: 'Finished-call processing failed; delivery must be retried.' })
        res.setHeader('retry-after', '30')
        res.status(503).json({ error: 'Finished-call processing failed', retryable: true, requestId: res.atriumRequestId })
        return
      }
    }

    res.status(200).json({})
  } catch (err) {
    if (err instanceof CallLifecycleError) { lifecycleResponse(res, err, pendingToolIds); return }
    if (hasAdmittedWork) {
      res.setHeader('retry-after', '2')
      res.status(503).json({ code: 'call_work_unresolved', retryable: true,
        results: pendingToolIds.map(toolCallId => ({ toolCallId,
          result: 'The accepted call work could not be completed safely. Do not claim the action succeeded; it needs retry or staff review.' })) })
      return
    }
    if (runtime) throw err
    console.error('[vapi] handler error', err)
    logEvent(callId, { kind: 'error', message: err instanceof Error ? err.message : String(err) })
    // Never 500 at Vapi — that drops the call. Give the agent something safe to say.
    res.status(200).json({
      results: (pendingToolIds.length ? pendingToolIds : ['error']).map((id) => ({
        toolCallId: id,
        result: 'Something went wrong on my end. Apologise, offer to have someone call them back, and take their number.',
      })),
    })
  }
}
