import type { InventorySnapshot, FloorPlan } from '../inventory/types.ts'
import { findMatches } from '../inventory/match.ts'
import { rentPhrase } from '../inventory/pricing.ts'
import type { QualificationState } from '../leasing/qualification.ts'
import { mayQuote, nextSignalToAsk, captureCore } from '../leasing/qualification.ts'
import { extracted } from '../leasing/captured.ts'
import { parseMoveIn } from '../leasing/when.ts'
import { decideAnswer } from '../knowledge/answer.ts'
import { retrieve } from '../knowledge/retrieve.ts'
import { guardTopic } from '../knowledge/guard.ts'
import type { KnowledgeArticle } from '../knowledge/article.ts'
import { isPolicy, type Topic } from '../knowledge/topics.ts'
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

const SMALL: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
}

/**
 * A monthly ceiling from what the caller said.
 *
 * Speech-to-text writes "four thousand" as "$4. 000." and the model, told to pass a number,
 * passed 4 — a four-dollar budget, and every residence priced out by five thousand. The
 * model's value is tried first; anything under a plausible rent falls through to the
 * caller's own words, with the transcriber's punctuation between digit groups removed.
 */
export function parseBudget(value: unknown, excerpt: unknown): number | null {
  for (const text of [value, excerpt]) {
    const s = String(text ?? '').toLowerCase()
      .replace(/(\d)[\s.,]+(?=\d{3}\b)/g, '$1')
      .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)\s+(thousand|grand|k)\b/g,
        (_, w: string) => String(SMALL[w]! * 1000))
      .replace(/\b(\d+)\s+hundred\b/g, (_, d: string) => String(Number(d) * 100))
    for (const m of s.matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*(k|thousand|grand)?\b/g)) {
      let n = Number(m[1])
      if (!Number.isFinite(n)) continue
      if (m[2]) n *= 1000
      if (n >= 300 && n <= 50_000) return Math.round(n)
    }
  }
  return null
}

/** Records something the prospect told us, with the words that justified it. */
export function captureSignal(args: CaptureArgs, ctx: ToolContext): ToolResult {
  const conf = args.confidence ?? 0.85
  let q = ctx.qualification
  let captured = false

  if (args.signal === 'budget') {
    const n = parseBudget(args.value, args.excerpt)
    if (n !== null) {
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
export interface AvailabilityArgs {
  /** A specific residence the caller named — usually read off the website. */
  unitId?: string
  reason?: string
  /**
   * What the caller has said about timing, size and money, in their words. Passing them
   * here is one round trip instead of three capture_signal calls and a check — and it
   * cannot race, because the capture and the lookup happen in the same call.
   */
  moveIn?: string
  bedrooms?: string
  budget?: string
}

const sizeOf = (u: { bedrooms: number }) => (u.bedrooms === 0 ? 'studio' : `${u.bedrooms} bed`)

/** One residence, priced the way the website prints it. */
const unitLine = (u: { unitId: string; bedrooms: number; bathrooms: number; sqft: number; floor: number; monthlyRent: number; concession?: string | null; availableFrom: string; view?: string }) =>
  `Unit ${u.unitId} (${sizeOf(u)}, ${u.bathrooms} bath, ${u.sqft} sq ft, floor ${u.floor}): ${rentPhrase(u)}, available ${availDate(u.availableFrom)}${u.view ? `. ${u.view}` : ''}`

const availDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

/**
 * A caller who has the website open asks about a residence by name. That question does
 * not need qualification — they have already chosen — and answering it from the verified
 * snapshot is the opposite of a hallucination risk. Without this the agent had no way to
 * look a unit up and either improvised or said it was unavailable.
 */
export function lookupUnit(unitId: string, ctx: ToolContext): ToolResult {
  const wanted = unitId.trim().toUpperCase().replace(/^(RESIDENCE|UNIT|APARTMENT|APT)\s*/i, '')
  const u = ctx.inventory.units.find((x) => x.unitId.toUpperCase() === wanted)
  const plan = u ? ctx.inventory.floorPlans.find((p) => p.id === u.floorPlanId) : undefined

  if (!u) {
    return {
      say: `There is no residence ${wanted} on the current availability list. Say so plainly — do not guess at whether it exists or what it costs — and offer to check what is available in the size they want.`,
      record: { kind: 'availability_checked', outcome: 'unit_not_found', unitId: wanted, unitsOffered: [] },
    }
  }

  if (u.status !== 'available') {
    return {
      say: `Residence ${u.unitId} is ${u.status === 'pending' ? 'pending — someone has an application in on it' : 'not currently available'}. Say exactly that. Offer to check similar residences.`,
      record: { kind: 'availability_checked', outcome: `unit_${u.status}`, unitId: u.unitId, unitsOffered: [] },
    }
  }

  const moveIn = ctx.qualification.moveInTiming?.value.earliest
  const timing = moveIn && Date.parse(u.availableFrom) > moveIn.getTime() + 42 * 86_400_000
    ? ` NOTE: it is not free until ${availDate(u.availableFrom)}, which is later than the ${availDate(moveIn.toISOString())} they mentioned — say that and ask whether the date works.`
    : ''

  return {
    say: `Residence ${u.unitId} is available: ${sizeOf(u)}, ${u.bathrooms} bath, ${u.sqft} sq ft${plan ? ` (${plan.name})` : ''}, ${rentPhrase(u)}, available ${availDate(u.availableFrom)}${u.view ? `. ${u.view}` : ''}. Quote exactly this — the net effective figure first, then the lease figure.${timing}`,
    record: { kind: 'availability_checked', outcome: 'unit_lookup', unitId: u.unitId, unitsOffered: [u.unitId] },
  }
}

/**
 * "Is an A2 open?" names a floor plan, not a residence. Sending it through the residence
 * lookup answered "there is no residence A2" — true, and the reason a caller who read the
 * plan catalogue was told the building had nothing. A plan names a layout, so it is
 * answered like one: what is open in that layout, from the verified snapshot.
 */
export function lookupPlan(plan: FloorPlan, ctx: ToolContext): ToolResult {
  const open = ctx.inventory.units
    .filter((u) => u.floorPlanId === plan.id && u.status === 'available')
    .sort((a, b) => Date.parse(a.availableFrom) - Date.parse(b.availableFrom))
  const size = plan.bedrooms === 0 ? 'studio' : `${plan.bedrooms} bed`

  if (open.length === 0) {
    return {
      say: `No ${plan.name} (${plan.id}) residences are open right now. Say so plainly and offer to check the other ${size} layouts.`,
      record: { kind: 'availability_checked', outcome: 'plan_none_open', floorPlanId: plan.id, unitsOffered: [] },
    }
  }

  const shown = open.slice(0, 3)
  const lines = shown.map(unitLine)
  const rest = open.length - shown.length
  const more = rest > 0 ? ` ${rest} more ${plan.name} residence${rest === 1 ? ' is' : 's are'} open — say more exist and offer to go through them.` : ''

  return {
    say: `${plan.name} (${plan.id}): ${size}, ${plan.bathrooms} bath, about ${plan.sqft} sq ft. Open now — quote exactly these:\n${lines.join('\n')}${more}`,
    record: { kind: 'availability_checked', outcome: 'plan_lookup', floorPlanId: plan.id, unitsOffered: shown.map((u) => u.unitId) },
  }
}

export function checkAvailability(ctx: ToolContext, args: AvailabilityArgs = {}): ToolResult {
  // Signals passed inline are captured first, against the same state the lookup then reads.
  let inline: QualificationState | undefined
  for (const [signal, value] of [['moveInTiming', args.moveIn], ['bedrooms', args.bedrooms], ['budget', args.budget]] as const) {
    if (!value) continue
    const r = captureSignal({ signal, value: String(value), excerpt: String(value) },
      { ...ctx, qualification: inline ?? ctx.qualification })
    if (r.qualificationPatch) inline = r.qualificationPatch
  }
  if (inline) {
    const { moveIn: _m, bedrooms: _b, budget: _g, ...rest } = args
    const out = checkAvailability({ ...ctx, qualification: inline }, rest)
    return { ...out, qualificationPatch: inline }
  }

  if (args.unitId) {
    // A residence first — it is the more specific name — then a plan by code or name.
    const wanted = args.unitId.trim().toUpperCase()
      .replace(/^(RESIDENCE|UNIT|APARTMENT|APT|THE|PLAN|FLOOR ?PLAN|LAYOUT)\s*/i, '')
      .replace(/\s*(FLOOR ?PLAN|PLAN|LAYOUT|LINE|RESIDENCES?|UNITS?|APARTMENTS?)$/i, '')
    const unit = ctx.inventory.units.find((u) => u.unitId.toUpperCase() === wanted)
    if (unit) return lookupUnit(unit.unitId, ctx)
    const plan = ctx.inventory.floorPlans.find(
      (p) => p.id.toUpperCase() === wanted || p.name.toUpperCase() === wanted,
    )
    if (plan) return lookupPlan(plan, ctx)
    if (/[0-9]/.test(wanted)) return lookupUnit(wanted, ctx)
  }

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
      /*
       * The most valuable branch in the system. Do not offer something dearer and hope —
       * but do name the residence, and do say what the money buys. "It's not giving me the
       * exact residence number" and a caller hanging up is what this text used to produce.
       */
      const size = ctx.qualification.bedrooms ? sizeOf({ bedrooms: ctx.qualification.bedrooms.value.min }) : 'residence'
      const nearest = out.nearest.map((m) => unitLine(m.unit))
      const alternatives = out.alternatives.map((m) => unitLine(m.unit))
      return {
        say: [
          `Nothing ${size === 'residence' ? '' : `${size} `}is available at or below ${money(out.budgetMax)}. The closest is ${money(out.gap)}/month above what they said:`,
          nearest.join('\n'),
          `Be straight about the gap and name the residence if they ask — that is real, current information. Do NOT pitch it as though it met their budget.`,
          alternatives.length
            ? `What DOES fit their budget is a size down — offer it plainly, as a real option, then ask which way they'd rather go:\n${alternatives.join('\n')}`
            : 'Nothing smaller fits either. Offer to take their details so someone can call when something closer opens up.',
          'If they walk, call capture_loss_reason with what they said.',
        ].join('\n\n'),
        record: {
          kind: 'availability_checked', outcome: 'priced_out',
          budgetMax: out.budgetMax, cheapestAvailable: out.cheapestAvailable, gap: out.gap,
          unitsOffered: [...out.nearest, ...out.alternatives].map((n) => n.unit.unitId),
        },
      }
    }

    case 'matches': {
      const lines = out.units.map((m) => unitLine(m.unit))
      const stretchLines = out.stretch.map((m) =>
        `Slightly above their range: ${unitLine(m.unit)} — offer this ONLY after acknowledging it is over what they said.`)
      const laterLines = out.later.map((m) =>
        `Coming up a bit later: Unit ${m.unit.unitId}, ${sizeOf(m.unit)}, ${rentPhrase(m.unit)}, free ${availDate(m.unit.availableFrom)}.`)
      const more = out.moreInTime.length
        ? `There ${out.moreInTime.length === 1 ? 'is' : 'are'} also ${out.moreInTime.join(', ')} in their range and window — mention that more exist and offer to go through them. If they ask about one by name, look it up.`
        : ''

      /*
       * The shape of this answer is the point. It is never a closed door: what fits now,
       * then what is close on price, then what is coming a little later, then that more
       * exist. A caller who asked about one residence and hears "not available" and
       * nothing else has been shut out of a building with twenty-seven homes open.
       */
      const parts: string[] = []
      if (lines.length) parts.push(`Available in their window and range — quote exactly these, net effective figure first, then the lease figure:\n${lines.join('\n')}`)
      if (stretchLines.length) parts.push(stretchLines.join('\n'))
      if (laterLines.length) parts.push(
        `${lines.length ? 'Also, if they can wait a little' : 'Nothing frees up by their date, but if they can wait a little'}:\n${laterLines.join('\n')}\nSay it warmly — something like "we've got this by the time you're looking to move, and a couple more opening up after if you're able to wait." Do NOT call these unavailable.`)
      if (more) parts.push(more)
      if (parts.length === 0) parts.push('Nothing matches on any of size, date or budget. Say so plainly, then ask what they would be flexible on.')

      return {
        say: parts.join('\n\n'),
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
  const servable = (a: KnowledgeArticle) => a.status === 'published' && a.approvedBy !== null
  const inTopic = ctx.articles.filter((a) => a.topic === topic && servable(a))
  let { ranked, confidence } = retrieve(args.question, inTopic)

  const decide = (t: Topic, cands: KnowledgeArticle[], conf: number) => decideAnswer({
    question: args.question,
    topic: t,
    propertyId: ctx.propertyId,
    jurisdiction: ctx.jurisdiction,
    candidates: cands,
    confidence: conf,
    confidenceThreshold: ctx.confidenceThreshold,
    now: ctx.now,
  })
  let decision = decide(topic, ranked.map((r) => r.article), confidence)
  let answeredUnder: Topic = topic

  /*
   * The topic is the model's guess, and the corpus files one subject under several. "Is
   * there a broker fee?" labelled general_property_fact found nothing under that topic and
   * refused, while the approved answer sat under application_requirements. A refusal for a
   * policy question is retried across every policy article. Never wider than that: the
   * question guard has already run, restricted topics escalated above, and volatile ones
   * deferred — so the retry can only ever land on another ordinary policy article, and only
   * one that clears the same confidence threshold.
   */
  if (decision.kind === 'refuse' && isPolicy(topic)) {
    const everywhere = ctx.articles.filter((a) => isPolicy(a.topic) && servable(a))
    const again = retrieve(args.question, everywhere)
    const best = again.ranked[0]
    if (best && best.article.topic !== topic && again.confidence >= ctx.confidenceThreshold) {
      const retry = decide(
        best.article.topic,
        again.ranked.filter((r) => r.article.topic === best.article.topic).map((r) => r.article),
        again.confidence,
      )
      if (retry.kind === 'answer') {
        decision = retry
        confidence = again.confidence
        answeredUnder = best.article.topic
      }
    }
  }

  switch (decision.kind) {
    case 'answer':
      return {
        say: decision.text,
        record: {
          kind: 'question_answered', question: args.question, topic: answeredUnder,
          decision: 'answer', sources: decision.sources.slice(0, 3).map((s) => `${s.id}@v${s.version}`),
          confidence: Number(confidence.toFixed(2)),
          ...(answeredUnder !== topic ? { topicAsked: topic } : {}),
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
