import rawProperty from '../data/property.json' with { type: 'json' }
import rawUnits from '../data/inventory.json' with { type: 'json' }
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
import { authorizeOps } from '../src/ops/session.ts'
import { fetchCalls } from '../src/ops/vapi-calls.ts'
import { calendarStoreFromEnv } from '../src/calendar/store.ts'
import { storeBackedCalendar } from '../src/calendar/port.ts'
import { documentStoreFromEnv } from '../src/store/documents.ts'
import { consolidateCall } from '../src/leads/consolidate.ts'
import type { LossReason } from '../src/record/store.ts'
import { bookTour } from '../src/booking/book.ts'
import type { CalendarPort, TourSlot } from '../src/booking/types.ts'
import { sayableStatus } from '../src/booking/book.ts'
import { propertyId, interactionId } from '../src/domain/ids.ts'

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

function load(now: Date) {
  if (cache) return cache

  const { snapshot, problems } = loadInventory(
    rawUnits as unknown[], rawPlans as unknown[], now, 'data/inventory.json')
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
  qualification: QualificationState
  name: string | null
  email: string | null
  unitsDiscussed: string[]
  booking: { slotId: string; startsAt: string; unitId: string | null; status: 'confirmed' | 'arranging' | 'failed' } | null
  lossReason: LossReason | null
  escalation: { trigger: string; detail: string } | null
  toolsCalled: string[]
}

const documents = documentStoreFromEnv()
const callKey = (id: string) => `call:${id}`

const freshCall = (): CallState => ({
  qualification: emptyQualification(), name: null, email: null, unitsDiscussed: [],
  booking: null, lossReason: null, escalation: null, toolsCalled: [],
})

/** Dates inside QualificationState do not survive JSON; rehydrate them. */
function reviveCall(raw: CallState | null): CallState {
  if (!raw) return freshCall()
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

async function saveCall(callId: string, state: CallState): Promise<void> {
  await documents.set(callKey(callId), state)
}

/*
 * The tour calendar the phone line books against. It is the same store the operations
 * dashboard edits, so a block set there is a time the agent will not offer here — which is
 * the test that proves it reads a calendar rather than inventing one.
 */
const calendarStore = calendarStoreFromEnv()
const TOUR_CAPACITY = Math.max(1, Number((rawProperty as { tourCapacityPerSlot?: number }).tourCapacityPerSlot ?? 1))
const demoCalendar = (now: Date) => storeBackedCalendar(calendarStore, () => now, { capacity: TOUR_CAPACITY })

const nyDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const nyHour = (d: Date) => Number(d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }))

/**
 * Which open times to put in front of the model.
 *
 * The first six slots in date order are six half-hours on the same morning, so the caller
 * heard "I can do Tuesday" from a calendar that was wide open. A caller who named a day
 * gets that day; otherwise the next three days with something open, a morning and an
 * afternoon time on each, and a note that other days are open too.
 */
export function pickSlotsToOffer(open: TourSlot[], preferredDate?: string): { offered: TourSlot[]; daysOpen: number } {
  const byDay = new Map<string, TourSlot[]>()
  for (const s of open) { const d = nyDay(s.startsAt); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(s) }
  const wanted = preferredDate && /^\d{4}-\d{2}-\d{2}$/.test(preferredDate) ? byDay.get(preferredDate) : undefined
  if (wanted?.length) return { offered: wanted.slice(0, 6), daysOpen: byDay.size }
  const offered: TourSlot[] = []
  for (const [, slots] of [...byDay.entries()].slice(0, 3)) {
    const morning = slots.find((s) => nyHour(s.startsAt) < 13)
    const afternoon = slots.find((s) => nyHour(s.startsAt) >= 13)
    for (const s of [morning, afternoon]) if (s && !offered.includes(s)) offered.push(s)
    if (!morning && !afternoon) offered.push(slots[0]!)
  }
  return { offered, daysOpen: byDay.size }
}

const fmtSlot = (s: TourSlot) =>
  s.startsAt.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/New_York',
  })

/** Everything that happened, for the dashboard. */
export const eventLog: Array<Record<string, unknown>> = []

function logEvent(callId: string, e: Record<string, unknown>) {
  eventLog.push({ ...e, callId, at: new Date().toISOString() })
  if (eventLog.length > 2000) eventLog.splice(0, eventLog.length - 2000)
}

/**
 * Runs one tool against the call's state, mutating it. The caller loads the state once
 * per webhook request, runs every tool in that request in order, and saves once.
 */
async function runTool(
  name: string, args: Record<string, unknown>, callId: string, now: Date, state: CallState,
): Promise<string> {
  const { inventory, articles, property } = load(now)
  state.toolsCalled.push(name)

  const ctx: ToolContext = {
    propertyId: propertyId(String(property.id ?? 'prop-demo')),
    interactionId: interactionId(callId),
    inventory,
    articles,
    qualification: state.qualification,
    jurisdiction: 'NY',
    confidenceThreshold: 0.7,
    now,
  }

  switch (name) {
    case 'capture_signal': {
      const r = captureSignal(args as never, ctx)
      if (r.qualificationPatch) state.qualification = r.qualificationPatch
      logEvent(callId, r.record)
      return r.say
    }

    case 'check_availability': {
      // Under exactOptionalPropertyTypes an absent key and an explicit `undefined` are
      // different types, so only include what the model actually sent.
      const r = checkAvailability(ctx, {
        ...(args.unitId ? { unitId: String(args.unitId) } : {}),
        ...(args.reason ? { reason: String(args.reason) } : {}),
        ...(args.moveIn ? { moveIn: String(args.moveIn) } : {}),
        ...(args.bedrooms ? { bedrooms: String(args.bedrooms) } : {}),
        ...(args.budget ? { budget: String(args.budget) } : {}),
      })
      if (r.qualificationPatch) state.qualification = r.qualificationPatch
      logEvent(callId, r.record)
      const offered = (r.record.unitsOffered as string[] | undefined) ?? []
      state.unitsDiscussed = [...new Set([...state.unitsDiscussed, ...offered])]
      return r.say
    }

    case 'answer_question': {
      const r = answerQuestion(args as never, ctx)
      logEvent(callId, r.record)
      if (r.escalate) {
        logEvent(callId, { kind: 'escalated', trigger: r.escalate.trigger, detail: r.escalate.detail })
        state.escalation = r.escalate
      }
      return r.say
    }

    case 'list_tour_slots': {
      const slots = await demoCalendar(now).listSlots(ctx.propertyId, now, now)
      const { offered, daysOpen } = pickSlotsToOffer(slots, args.preferredDate ? String(args.preferredDate) : undefined)
      logEvent(callId, { kind: 'slots_listed', count: offered.length, daysOpen })
      if (offered.length === 0) return 'No tour times are open. Offer to have someone call them back.'
      const more = daysOpen > 3 ? ` Other days are open too (${daysOpen} days in the next two weeks) — if none of these suit, ask which day works and call this again with preferredDate as YYYY-MM-DD.` : ''
      return `Real open tour times — offer two or three, and use the slotId when booking:\n${offered.map((s) => `${s.slotId} — ${fmtSlot(s)}`).join('\n')}${more}`
    }

    case 'book_tour': {
      const slots = await demoCalendar(now).listSlots(ctx.propertyId, now, now)
      const slot = slots.find((s) => s.slotId === args.slotId)
      if (!slot) return 'That slot is not on the calendar. Call list_tour_slots again and offer a real time.'

      state.name = String(args.prospectName ?? state.name ?? '')
      state.email = args.prospectEmail ? String(args.prospectEmail) : state.email

      const booking = await bookTour({
        propertyId: ctx.propertyId,
        interactionId: ctx.interactionId,
        personId: null,
        prospectName: state.name || 'there',
        prospectPhone: callId,
        prospectEmail: state.email,
        slot,
        unitId: args.unitId ? String(args.unitId) : null,
        floorPlanId: null,
      }, demoCalendar(now), { now, makeIntentId: () => `intent-${callId}-${slot.slotId}` })

      logEvent(callId, {
        kind: 'tour_booked', status: booking.state.status,
        slot: fmtSlot(slot), unitId: args.unitId ?? null,
        prospectName: state.name, prospectEmail: state.email,
      })
      state.booking = {
        slotId: slot.slotId, startsAt: slot.startsAt.toISOString(),
        unitId: args.unitId ? String(args.unitId) : null,
        status: booking.state.status === 'confirmed' ? 'confirmed'
          : booking.state.status === 'arranging' ? 'arranging' : 'failed',
      }
      return sayableStatus(booking)
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

export default async function handler(req: any, res: any) {
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

    const auth = authorizeOps(req.headers ?? {}, new Date())
    if (!auth.ok) {
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
    const history = await fetchCalls({ limit: 20 })

    res.status(200).json({
      calls: history.ok ? history.calls : [],
      callsError: history.ok ? null : history.reason,
      callsConfigured: history.ok ? true : history.configured,
      events: eventLog,
      generatedAt: new Date().toISOString(),
      note: history.ok
        ? 'Calls from Vapi. Decision events are in-process and reset on cold start.'
        : 'Call history unavailable — see callsError.',
    })
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'GET or POST only' })
    return
  }

  // Verify the request is genuinely from Vapi when a secret is configured.
  const expected = process.env.VAPI_WEBHOOK_SECRET
  if (expected) {
    const provided = req.headers['x-vapi-secret'] ?? req.headers['x-vapi-signature']
    if (provided !== expected) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
  }

  const now = new Date()
  let callId = 'unknown-call'

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
    if (message.type === 'transcript' && message.role === 'user' && message.transcript) {
      const { inventory, articles, property } = load(now)
      const emergency = checkEmergency(String(message.transcript), {
        propertyId: propertyId(String(property.id ?? 'prop-demo')),
        interactionId: interactionId(callId),
        inventory, articles,
        qualification: emptyQualification(),
        jurisdiction: 'NY', confidenceThreshold: 0.7, now,
      })
      if (emergency) {
        logEvent(callId, emergency.record)
        logEvent(callId, { kind: 'escalated', trigger: 'emergency', detail: emergency.escalate?.detail })
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
      const state = await getCall(callId)
      const results: Array<{ toolCallId: unknown; result: string }> = []
      for (const tc of list) {
        const name = tc.name ?? tc.function?.name
        const rawArgs = tc.arguments ?? tc.function?.arguments ?? {}
        const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
        const result = await runTool(String(name), args, callId, now, state)
        results.push({ toolCallId: tc.id ?? tc.toolCallId, result })
        // What each tool decided, for the runtime log — no names, numbers or caller words.
        const last = eventLog[eventLog.length - 1] ?? {}
        console.log('[tool]', JSON.stringify({
          call: callId.slice(-6), name,
          ...(last.callId === callId ? {
            kind: last.kind, outcome: last.outcome ?? last.decision ?? null,
            topic: last.topic ?? null, confidence: last.confidence ?? null,
            signal: last.signal ?? null, captured: last.captured ?? null,
            offered: Array.isArray(last.unitsOffered) ? last.unitsOffered.length : null,
          } : {}),
          said: result.slice(0, 60),
        }))
      }
      await saveCall(callId, state)
      res.status(200).json({ results })
      return
    }

    if (message.type === 'status-update') {
      logEvent(callId, { kind: 'call_status', status: message.status })
    }

    if (message.type === 'end-of-call-report') {
      logEvent(callId, { kind: 'call_status', status: 'end-of-call-report' })
      /*
       * The one moment the whole call is known. Fold it into the caller's profile and
       * derive what the building should do next about them. Never allowed to fail the
       * webhook: Vapi is told 200 whatever happens here, because a profile write that
       * throws must not look like a dropped call.
       */
      try {
        const state = await getCall(callId)
        const call = message.call ?? body.call ?? {}
        const phone = String(call?.customer?.number ?? message.customer?.number ?? 'unknown')
        const started = call?.startedAt ? Date.parse(call.startedAt) : NaN
        const ended = call?.endedAt ? Date.parse(call.endedAt) : now.getTime()
        await consolidateCall(documents, {
          callId, phone, at: now,
          durationSeconds: Number.isNaN(started) ? null : Math.round((ended - started) / 1000),
          qualification: state.qualification,
          name: state.name, email: state.email,
          unitsDiscussed: state.unitsDiscussed,
          booking: state.booking, lossReason: state.lossReason, escalation: state.escalation,
          toolsCalled: state.toolsCalled,
        })
        await documents.delete(callKey(callId))
        console.log('[call]', JSON.stringify({
          call: callId.slice(-6), consolidated: true, hasPhone: Boolean(phone && phone !== 'unknown'),
          tools: state.toolsCalled.length, booked: state.booking?.status ?? null,
          escalated: Boolean(state.escalation), store: documents.describe().kind,
        }))
      } catch (err) {
        console.error('[vapi] consolidate failed', err instanceof Error ? err.message : String(err))
        logEvent(callId, { kind: 'error', message: `consolidate: ${err instanceof Error ? err.message : String(err)}` })
      }
    }

    res.status(200).json({})
  } catch (err) {
    console.error('[vapi] handler error', err)
    logEvent(callId, { kind: 'error', message: err instanceof Error ? err.message : String(err) })
    // Never 500 at Vapi — that drops the call. Give the agent something safe to say.
    res.status(200).json({
      results: [{
        toolCallId: 'error',
        result: 'Something went wrong on my end. Apologise, offer to have someone call them back, and take their number.',
      }],
    })
  }
}
