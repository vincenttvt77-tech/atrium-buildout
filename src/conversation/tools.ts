import type { InventorySnapshot } from '../inventory/types.ts'
import { findMatches } from '../inventory/match.ts'
import type { QualificationState } from '../leasing/qualification.ts'
import { mayQuote, nextSignalToAsk, captureCore } from '../leasing/qualification.ts'
import { extracted } from '../leasing/captured.ts'
import { parseMoveIn } from '../leasing/when.ts'
import { decideAnswer } from '../knowledge/answer.ts'
import { retrieve } from '../knowledge/retrieve.ts'
import { guardTopic } from '../knowledge/guard.ts'
import type { KnowledgeArticle } from '../knowledge/article.ts'
import type { Topic } from '../knowledge/topics.ts'
import { detectEmergency, primaryEmergency, safetyInstruction } from '../escalation/emergency.ts'
import type { PropertyId, InteractionId } from '../domain/ids.ts'
import type { LossReason } from '../record/store.ts'

/**
 * The tools the voice agent may call, and the guards that make them safe.
 *
 * Every rule that matters is enforced HERE, in the tool implementation — not in the system
 * prompt. A prompt instruction is a request; a tool that refuses is a constraint. A caller
 * who talks the model into wanting to quote a price still gets a refusal, because the
 * quote gate lives in code the model cannot argue with.
 */

export interface ToolContext {
  propertyId: PropertyId
  interactionId: InteractionId
  inventory: InventorySnapshot
  articles: KnowledgeArticle[]
  qualification: QualificationState
  jurisdiction: string
  confidenceThreshold: number
  now: Date
}

export interface ToolResult {
  /** What the agent should say, or the substance it should say. */
  say: string
  /** Structured outcome for the operational record. */
  record: Record<string, unknown>
  /** Set when this turn must hand off to a human. */
  escalate?: { trigger: string; detail: string }
  /** Mutations the caller should apply to conversation state. */
  qualificationPatch?: QualificationState
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`

/** Runs before everything else on every inbound utterance. */
export function checkEmergency(utterance: string, ctx: ToolContext): ToolResult | null {
  const signals = detectEmergency(utterance)
  const primary = primaryEmergency(signals)
  if (!primary) return null
  return {
    say: safetyInstruction(primary),
    record: { kind: 'emergency', emergencyKind: primary.kind, matched: primary.matched },
    escalate: { trigger: 'emergency', detail: `${primary.kind}: "${primary.matched}"` },
  }
}

export interface CaptureArgs {
  signal: 'moveInTiming' | 'budget' | 'bedrooms' | 'pets' | 'parking'
  value: string
  excerpt: string
  confidence?: number
}

/** Records something the prospect told us, with the words that justified it. */
export function captureSignal(args: CaptureArgs, ctx: ToolContext): ToolResult {
  const conf = args.confidence ?? 0.85
  let q = ctx.qualification
  let captured = false

  if (args.signal === 'budget') {
    const n = Number(String(args.value).replace(/[^0-9.]/g, ''))
    if (Number.isFinite(n) && n > 0) {
      q = captureCore(q, 'budget', extracted({ maxMonthly: n, stated: true }, conf, ctx.interactionId, args.excerpt, ctx.now))
      captured = true
    }
  } else if (args.signal === 'bedrooms') {
    const n = /studio/i.test(args.value) ? 0 : Number(String(args.value).replace(/[^0-9]/g, ''))
    if (Number.isFinite(n)) {
      q = captureCore(q, 'bedrooms', extracted({ min: n, max: n }, conf, ctx.interactionId, args.excerpt, ctx.now))
      captured = true
    }
  } else if (args.signal === 'moveInTiming') {
    // Callers say "2 months", not "2026-11-07". Parsing that with Date.parse returned NaN,
    // captured nothing, and the tool then asked the model to collect the same signal again
    // — which it did, forever, while the caller listened to ambience.
    const window = parseMoveIn(args.value, ctx.now) ?? parseMoveIn(args.excerpt, ctx.now)
    if (window) {
      q = captureCore(q, 'moveInTiming', extracted(
        { earliest: window.earliest, latest: window.latest }, conf, ctx.interactionId, args.excerpt, ctx.now))
      captured = true
    }
  } else {
    // pets and parking are recorded as evidence without gating anything.
    captured = true
  }

  const gate = mayQuote(q)
  const next = nextSignalToAsk(q)

  /*
   * What this says back is the loop guard. Naming a signal the agent already asked about
   * sends it round again; the caller answers the same way, nothing parses, and the call
   * hangs. So an unparseable value says so once and hands back control, and a successful
   * capture never names the signal just captured.
   */
  const say = !captured
    ? `Could not read "${args.value}" as ${args.signal}. Do NOT ask that question again the same way — either ask it differently once, or move on with what you have and check availability.`
    : gate.allowed
      ? 'Got it. You have enough to check availability now.'
      : next
        ? `Got it. Next, ask about ${next === 'moveInTiming' ? 'when they want to move' : next === 'bedrooms' ? 'how many bedrooms' : 'their budget'}.`
        : 'Got it.'

  return {
    say,
    record: {
      kind: 'signal_captured', signal: args.signal, value: args.value,
      excerpt: args.excerpt, confidence: conf, captured,
    },
    qualificationPatch: q,
  }
}

/**
 * Availability and pricing. Gated on qualification, and answers only from the verified
 * snapshot — the agent may never name a unit or a rent that did not come through here.
 */
export function checkAvailability(ctx: ToolContext): ToolResult {
  const gate = mayQuote(ctx.qualification)
  if (!gate.allowed) {
    const next = nextSignalToAsk(ctx.qualification)
    return {
      say: `Before I quote anything I need a little more. Ask about ${next ?? 'their needs'} first, then check again. Do NOT state any rent figure yet.`,
      record: { kind: 'quote_gate', allowed: false, captured: gate.captured, missing: gate.missing },
    }
  }

  const out = findMatches(ctx.inventory, ctx.qualification, { now: ctx.now })

  switch (out.kind) {
    case 'stale':
      return {
        say: 'I need to re-check the current availability before I quote anything — tell the caller you are pulling up the live list.',
        record: { kind: 'availability_checked', outcome: 'stale', unitsOffered: [] },
      }

    case 'no_match':
      return {
        say: out.reason === 'bedroom_mismatch'
          ? 'We do not have that bedroom count available. Say so plainly, ask whether a different size would work, and capture the mismatch.'
          : 'Nothing is available matching that. Say so plainly and offer to take their details for the waitlist.',
        record: { kind: 'availability_checked', outcome: out.reason, unitsOffered: [] },
      }

    case 'priced_out': {
      // The most valuable branch in the system. Do not offer something dearer and hope.
      return {
        say: `Nothing is available at or below ${money(out.budgetMax)}. The lowest available right now is ${money(out.cheapestAvailable)} — ${money(out.gap)} above what they said. Be straight with them about that. Do NOT pitch a more expensive unit as though it met their budget. Ask whether that gap is workable, or whether they would like to hear when something closer opens up.`,
        record: {
          kind: 'availability_checked', outcome: 'priced_out',
          budgetMax: out.budgetMax, cheapestAvailable: out.cheapestAvailable, gap: out.gap,
          unitsOffered: out.nearest.map((n) => n.unit.unitId),
        },
      }
    }

    case 'matches': {
      const lines = out.units.map((m) => {
        const u = m.unit
        const avail = new Date(u.availableFrom).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
        return `Unit ${u.unitId}: ${u.bedrooms === 0 ? 'studio' : `${u.bedrooms} bed`}, ${u.bathrooms} bath, ${u.sqft} sq ft, ${money(u.monthlyRent)}/month, available ${avail}${u.concession ? `. Concession: ${u.concession}` : ''}${u.view ? `. ${u.view}` : ''}`
      })
      const stretchLines = out.stretch.map((m) =>
        `Slightly above their range: Unit ${m.unit.unitId} at ${money(m.unit.monthlyRent)} — offer this ONLY after acknowledging it is over what they said.`)

      return {
        say: lines.length > 0
          ? `Verified availability — you may quote these exactly and nothing else:\n${lines.join('\n')}${stretchLines.length ? `\n${stretchLines.join('\n')}` : ''}`
          : `Nothing within their stated range.${stretchLines.length ? ` ${stretchLines.join(' ')}` : ''}`,
        record: {
          kind: 'availability_checked', outcome: 'matches',
          unitsOffered: out.units.map((m) => m.unit.unitId),
        },
      }
    }
  }
}

export interface AnswerArgs {
  question: string
  topic: Topic
}

/** Property questions. Answers only from approved knowledge; escalates the restricted. */
export function answerQuestion(args: AnswerArgs, ctx: ToolContext): ToolResult {
  /*
   * The topic is an argument the model supplies. Trusting it alone means one
   * misclassification is a Fair Housing incident, so the question text is screened first
   * and can override the topic upward into a restricted one — never downward.
   */
  const guard = guardTopic(args.question)
  const topic = guard ? guard.topic : args.topic

  // Rank against what was actually asked. Passing every article filed under the topic and
  // taking the first is how "what are the gym hours" gets answered with the leasing
  // office's hours — approved, fluent, and wrong.
  /*
   * Only articles that could actually be served are ranked. retrieve() returns the
   * confidence of its top hit, and decideAnswer() filters to servable afterwards — so
   * ranking a held draft lets it set ceiling confidence for whatever servable article
   * happens to rank next. Unpublishing text is not the same as removing it.
   */
  const inTopic = ctx.articles.filter(
    (a) => a.topic === topic && a.status === 'published' && a.approvedBy !== null,
  )
  const { ranked, confidence } = retrieve(args.question, inTopic)

  const decision = decideAnswer({
    question: args.question,
    topic,
    propertyId: ctx.propertyId,
    jurisdiction: ctx.jurisdiction,
    candidates: ranked.map((r) => r.article),
    confidence,
    confidenceThreshold: ctx.confidenceThreshold,
    now: ctx.now,
  })

  switch (decision.kind) {
    case 'answer':
      return {
        say: decision.text,
        record: {
          kind: 'question_answered', question: args.question, topic,
          decision: 'answer', sources: decision.sources.slice(0, 3).map((s) => `${s.id}@v${s.version}`),
          confidence: Number(confidence.toFixed(2)),
        },
      }

    case 'escalate':
      return {
        say: 'That is something a member of the team needs to handle directly. Tell the caller you are passing it to the leasing manager who will follow up, take their contact details, and do NOT attempt to answer, characterise, or redirect the question.',
        record: {
          kind: 'question_answered', question: args.question, topic,
          decision: 'escalate', sources: [],
          ...(guard ? { guardedFrom: args.topic, guardMatched: guard.matched } : {}),
        },
        escalate: { trigger: `restricted:${topic}`, detail: args.question },
      }

    case 'defer_to_live_source':
      return {
        say: `That is live information — use the availability tool, not your own knowledge. Do NOT answer from memory.`,
        record: { kind: 'question_answered', question: args.question, topic, decision: 'defer', sources: [] },
      }

    case 'refuse':
      return {
        say: "You do not have an approved answer for that. Say honestly that you do not want to guess, offer to have someone from the office follow up with the exact answer, and take their contact details. Do NOT improvise an answer.",
        record: {
          kind: 'question_refused', question: args.question,
          reason: decision.reason, timesAsked: decision.propose.timesAsked,
        },
      }
  }
}

/** Records why a prospect did not convert, with evidence. */
export function captureLossReason(
  reason: Omit<LossReason, 'at'>, ctx: ToolContext,
): ToolResult {
  return {
    say: 'Noted.',
    record: { kind: 'loss_reason', reason: { ...reason, at: ctx.now } },
  }
}
