import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadInventory } from '../src/inventory/load.ts'
import type { InventorySnapshot } from '../src/inventory/types.ts'
import type { KnowledgeArticle } from '../src/knowledge/article.ts'
import { emptyQualification, type QualificationState } from '../src/leasing/qualification.ts'
import {
  checkEmergency, checkAvailability, answerQuestion, captureSignal, captureLossReason,
  type ToolContext,
} from '../src/conversation/tools.ts'
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

const DATA = join(process.cwd(), 'data')

let cache: {
  inventory: InventorySnapshot
  articles: KnowledgeArticle[]
  property: Record<string, unknown>
  loadedAt: number
} | null = null

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(DATA, name), 'utf8')) as T
  } catch {
    return fallback
  }
}

async function load(now: Date) {
  // Re-read every 60s so an inventory edit shows up without a redeploy.
  if (cache && Date.now() - cache.loadedAt < 60_000) return cache

  const [rawUnits, rawPlans, rawArticles, property] = await Promise.all([
    readJson<unknown[]>('inventory.json', []),
    readJson<unknown[]>('floorplans.json', []),
    readJson<unknown[]>('knowledge.json', []),
    readJson<Record<string, unknown>>('property.json', {}),
  ])

  const { snapshot, problems } = loadInventory(rawUnits, rawPlans, now, 'data/inventory.json')
  if (problems.length > 0) console.warn('[inventory] excluded records:', problems)

  const articles = (rawArticles as Record<string, unknown>[])
    .map((a) => ({
      ...a,
      approvedAt: a.approvedAt ? new Date(a.approvedAt as string) : null,
      reviewBy: new Date(a.reviewBy as string),
    }) as unknown as KnowledgeArticle)

  cache = { inventory: snapshot, articles, property, loadedAt: Date.now() }
  return cache
}

/** Per-call conversation state. Lives as long as the warm instance does. */
const calls = new Map<string, { qualification: QualificationState; name: string | null; email: string | null }>()

function callState(callId: string) {
  let s = calls.get(callId)
  if (!s) {
    s = { qualification: emptyQualification(), name: null, email: null }
    calls.set(callId, s)
  }
  return s
}

/** Demo tour calendar: weekday and weekend slots for the next 10 days. */
function demoSlots(now: Date): TourSlot[] {
  const slots: TourSlot[] = []
  for (let d = 1; d <= 10; d++) {
    const day = new Date(now.getTime() + d * 86_400_000)
    const dow = day.getUTCDay()
    const hours = dow === 0 ? [15, 17] : dow === 6 ? [14, 15, 16, 18] : [14, 16, 18, 21]
    for (const h of hours) {
      const startsAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, 0, 0))
      slots.push({
        slotId: `slot-${startsAt.toISOString().slice(0, 13)}`,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      })
    }
  }
  return slots
}

const booked = new Map<string, { externalId: string; slot: TourSlot }>()

function demoCalendar(now: Date): CalendarPort {
  return {
    async listSlots() {
      return demoSlots(now).filter((s) => ![...booked.values()].some((b) => b.slot.slotId === s.slotId))
    },
    async createBooking(intent) {
      const existing = booked.get(intent.idempotencyKey)
      if (existing) return { externalId: existing.externalId }
      const externalId = `demo-${intent.idempotencyKey.replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`
      booked.set(intent.idempotencyKey, { externalId, slot: intent.request.slot })
      return { externalId }
    },
    async readBooking(externalId) {
      for (const b of booked.values()) if (b.externalId === externalId) return b
      return null
    },
  }
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

async function runTool(
  name: string, args: Record<string, unknown>, callId: string, now: Date,
): Promise<string> {
  const { inventory, articles, property } = await load(now)
  const state = callState(callId)

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
      const r = checkAvailability(ctx)
      logEvent(callId, r.record)
      return r.say
    }

    case 'answer_question': {
      const r = answerQuestion(args as never, ctx)
      logEvent(callId, r.record)
      if (r.escalate) logEvent(callId, { kind: 'escalated', trigger: r.escalate.trigger, detail: r.escalate.detail })
      return r.say
    }

    case 'list_tour_slots': {
      const slots = await demoCalendar(now).listSlots(ctx.propertyId, now, now)
      const next = slots.slice(0, 6)
      logEvent(callId, { kind: 'slots_listed', count: next.length })
      return next.length === 0
        ? 'No tour times are open. Offer to have someone call them back.'
        : `Real open tour times — offer only these, and use the slotId when booking:\n${next.map((s) => `${s.slotId} — ${fmtSlot(s)}`).join('\n')}`
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
  if (req.method === 'GET') {
    res.setHeader('cache-control', 'no-store')
    res.status(200).json({
      events: eventLog,
      generatedAt: new Date().toISOString(),
      note: 'In-memory, warm-instance scoped. Resets on cold start.',
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

    // Emergency screening on every caller turn, ahead of anything the model decides to do.
    if (message.type === 'transcript' && message.role === 'user' && message.transcript) {
      const { inventory, articles, property } = await load(now)
      const emergency = checkEmergency(String(message.transcript), {
        propertyId: propertyId(String(property.id ?? 'prop-demo')),
        interactionId: interactionId(callId),
        inventory, articles,
        qualification: callState(callId).qualification,
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
      const list = message.toolCallList ?? message.toolCalls ?? []
      const results = await Promise.all(list.map(async (tc: any) => {
        const name = tc.name ?? tc.function?.name
        const rawArgs = tc.arguments ?? tc.function?.arguments ?? {}
        const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
        const result = await runTool(String(name), args, callId, now)
        return { toolCallId: tc.id ?? tc.toolCallId, result }
      }))
      res.status(200).json({ results })
      return
    }

    if (message.type === 'status-update' || message.type === 'end-of-call-report') {
      logEvent(callId, { kind: 'call_status', status: message.status ?? message.type })
      if (message.type === 'end-of-call-report') calls.delete(callId)
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
