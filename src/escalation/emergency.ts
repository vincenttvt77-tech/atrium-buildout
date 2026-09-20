/**
 * Emergency detection, per SOW 8.1.
 *
 * This runs before intent classification, before qualification, before knowledge lookup and
 * before any authority check. A life-safety signal overrides every other flow — the agent
 * must never hold a safety response to gather diagnostic information or await approval.
 *
 * Detection is deliberately keyword-driven rather than model-driven. A model that is having
 * a bad day can misclassify "I smell gas"; a keyword list cannot. False positives here cost
 * a needless escalation. False negatives cost something else entirely.
 */

export type EmergencyKind =
  | 'gas' | 'smoke_or_fire' | 'carbon_monoxide' | 'flooding' | 'no_heat'
  | 'injury' | 'intruder' | 'structural'

export interface EmergencySignal {
  kind: EmergencyKind
  /** The phrase that triggered it, kept for the audit record. */
  matched: string
  /** True when the approved instruction is to hang up and call emergency services. */
  callEmergencyServices: boolean
}

interface Rule {
  kind: EmergencyKind
  callEmergencyServices: boolean
  patterns: RegExp[]
}

const RULES: Rule[] = [
  {
    kind: 'gas', callEmergencyServices: true,
    patterns: [/\bsmell(?:s|ing)? (?:like )?gas\b/i, /\bgas (?:leak|smell|odou?r)\b/i, /\bsmell of gas\b/i],
  },
  {
    // Bare /fire/ and /smoke in/ are not usable here: "is there a fire pit on the roof" and
    // "can I smoke in my apartment" are ordinary leasing questions, and routing them to an
    // emergency escalation would be both wrong and expensive. Every pattern below requires
    // phrasing that only occurs when something is actually happening.
    kind: 'smoke_or_fire', callEmergencyServices: true,
    patterns: [
      /\bthere(?:'s| is) a fire\b/i,
      /\bon fire\b/i,
      /\bfire in (?:the|my)\b/i,
      /\bflames?\b/i,
      /\bthere(?:'s| is) smoke\b/i,
      /\bsmoke (?:coming|everywhere|pouring|filling)\b/i,
      /\bi (?:see|smell) smoke\b/i,
      /\bsmell(?:s|ing)? (?:like )?(?:smoke|burning)\b/i,
      /\bsomething(?:'s| is) burning\b/i,
      /\b(?:fire|smoke) (?:alarm|detector)s? (?:is |are )?(?:going off|sounding|blaring)\b/i,
    ],
  },
  {
    kind: 'carbon_monoxide', callEmergencyServices: true,
    patterns: [/\bcarbon monoxide\b/i, /\bco (?:detector|alarm)\b/i, /\bco2? alarm going off\b/i],
  },
  {
    kind: 'injury', callEmergencyServices: true,
    patterns: [
      /\b(?:someone|somebody|he|she|they|i)(?:'s| is|'ve| have)? (?:been )?(?:hurt|injured|bleeding)\b/i,
      /\bunconscious\b/i, /\bnot breathing\b/i, /\bheart attack\b/i, /\bfell down\b/i,
      /\bthere(?:'s| is) blood\b/i, /\bcall an ambulance\b/i,
    ],
  },
  {
    kind: 'intruder', callEmergencyServices: true,
    patterns: [
      /\b(?:break[- ]?in|broke in|breaking in)\b/i, /\bintruder\b/i,
      /\bsomeone(?:'s| is) in my (?:apartment|unit|home)\b/i, /\bbeing robbed\b/i,
    ],
  },
  {
    // Bare /flood/ catches "flooded the market with concessions". Require a physical subject.
    kind: 'flooding', callEmergencyServices: false,
    patterns: [
      /\b(?:apartment|unit|bathroom|kitchen|basement|hallway|floor|place)\s+(?:is\s+)?flood(?:ing|ed)\b/i,
      /\bflooding in\b/i,
      /\bit(?:'s| is) flooding\b/i,
      /\bwater (?:is )?(?:everywhere|pouring|gushing|coming through|all over)\b/i,
      /\bceiling(?:'s| is)? (?:leaking|coming down)\b/i,
      /\bburst pipe\b/i, /\bpipe burst\b/i,
    ],
  },
  {
    kind: 'no_heat', callEmergencyServices: false,
    patterns: [/\bno heat\b/i, /\bheat(?:'s| is)? (?:still )?(?:out|not working|off)\b/i, /\bfreezing in (?:here|my)\b/i],
  },
  {
    kind: 'structural', callEmergencyServices: false,
    patterns: [/\bceiling (?:collapsed|caved)\b/i, /\bwall(?:'s| is) cracking\b/i, /\bfloor (?:gave way|collapsed)\b/i],
  },
]

/**
 * A heating-policy question or explicitly past/resolved heating problem is not a
 * current incident. Keep this exception local to each heat phrase: a hypothetical
 * earlier in a sentence must not hide a later actual report, or any life-safety
 * signal. Ambiguous heat reports remain guarded. This never clears a saved hold.
 */
function nonCurrentHeatMention(utterance: string, index: number, length: number): boolean {
  const text = utterance.toLowerCase().replace(/[’‘]/g, "'")
  const before = text.slice(0, index)
  const boundary = /[.!?;,\n]|\b(?:but|however|and|actually)\b/g
  let start = 0
  for (const match of before.matchAll(boundary)) start = match.index + match[0].length
  const prefix = text.slice(start, index).trimStart()
  const rest = text.slice(index + length)
  const end = /[.!?;,\n]|\b(?:but|however|and)\b/.exec(rest)?.index ?? rest.length
  const suffix = rest.slice(0, end)

  // Negating the report is different from the “not working” within a report.
  if (/\b(?:not|never)\s+(?:(?:reporting|experiencing|having|saying|claiming)\s+(?:(?:that|there|is|a|an|issue|problem|with)\s+)*)?$/.test(prefix)
    || /\b(?:do not|don't) have (?:a |an |any )?(?:problem|issue) with\s*$/.test(prefix)
    || /^\s+(?:is not|isn't|was not|wasn't) (?:a |an |the |our |my )?(?:problem|issue)\b/.test(suffix)) return true

  if (/\b(?:right now|currently|at the moment|today|still|ongoing|unresolved|since)\b/.test(prefix + text.slice(index, index + length) + suffix)) return false

  if (/^(?:if|suppose|supposing|hypothetically|in case)\b/.test(prefix)
    || /\b(?:what|who|how)\b.*\bif\b/.test(prefix)
    || /\b(?:can|could|should|would|may) (?:i|we)\b.*\bif\b/.test(prefix)
    || /\b(?:in (?:the )?case of|in the event of)\b/.test(prefix)
    || /\b(?:policy|procedure|protocol)\s+(?:for|on|about|regarding)\b/.test(prefix)) return true

  // A past report at this building can still be unresolved. Require affirmative
  // resolution, not merely “yesterday”, a past-tense report, or the word “fixed”.
  if (/\b(?:still|ongoing|unresolved|continues?|not (?:fixed|resolved|working))\b/.test(rest)) return false
  const past = /\b(?:had|experienced|reported)(?:\s+(?:a|an|issue|problem|with|period|of))*\s*$/.test(prefix)
    || /\bused to have\s*$/.test(prefix)
  const historical = /\b(?:old|former|previous) (?:apartment|unit|home|building)\b/.test(prefix + suffix)
  // Require a final direct affirmative clause. “Nobody said it was fixed”, “it
  // has not been repaired”, or “it was fixed but broke again” are not resolution.
  const resolution = /(?:^|[.!?;,\n]|\b(?:and|but)\b)\s*(?:now )?(?:it|that|the (?:heat|heating|problem|issue)) (?:is|was|has been|had been) (?:fixed|resolved|repaired|restored|working (?:again|now))\b/.exec(rest)
  const resolved = resolution !== null && /^\s*(?:(?:now|again|today|yesterday|this morning|last night)\s*)?[.!]?\s*$/.test(rest.slice(resolution.index + resolution[0].length))
  return past && (historical || resolved)
}

/** Returns every emergency signal present. Multiple can fire at once — a fire and an injury. */
export function detectEmergency(utterance: string): EmergencySignal[] {
  const found: EmergencySignal[] = []
  for (const rule of RULES) {
    let matched = false
    for (const pattern of rule.patterns) {
      for (const m of utterance.matchAll(new RegExp(pattern.source, pattern.flags + 'g'))) {
        if (rule.kind === 'no_heat' && nonCurrentHeatMention(utterance, m.index, m[0].length)) continue
        found.push({ kind: rule.kind, matched: m[0], callEmergencyServices: rule.callEmergencyServices })
        matched = true
        break
      }
      if (matched) break
    }
  }
  return found
}

/** The highest-severity signal — the one whose instruction the agent gives first. */
export function primaryEmergency(signals: EmergencySignal[]): EmergencySignal | null {
  if (signals.length === 0) return null
  const lifeSafety = signals.find((s) => s.callEmergencyServices)
  return lifeSafety ?? signals[0]!
}

/**
 * Fixed safety guidance, independent of knowledge search and notification delivery.
 * Gas: https://www.coned.com/en/safety/energy-safety/gas-safety
 * Flood electrical hazards: https://www.cdc.gov/floods/safety/reentering-your-flooded-home-safety.html
 * Recording an escalation is not proof that staff or emergency services were contacted.
 */
export function safetyInstruction(signal: EmergencySignal): string {
  const delivery = ' I have not contacted emergency services or building staff.'
  switch (signal.kind) {
    case 'gas':
      return "Please stop what you're doing and leave the apartment and building right now. Don't use any light switches, appliances, or your phone inside. Once you're outside and away from the building, call 911." + delivery
    case 'smoke_or_fire':
      return "Please leave the building now using the stairs, not the elevator. Once you're outside, call 911." + delivery
    case 'carbon_monoxide':
      return 'Please get everyone out into fresh air right now, then call 911 from outside.' + delivery
    case 'injury':
      return 'Please call 911 right now for emergency help.' + delivery
    case 'intruder':
      return 'Please get somewhere safe and call 911 immediately.' + delivery
    case 'flooding':
      return "Stay out of the water and away from electrical equipment. Don't touch switches, plugs, or appliances while wet or standing in water. Contact the building's emergency maintenance line directly. If anyone is in immediate danger, call 911." + delivery
    case 'no_heat':
      return "Contact the building's emergency maintenance line directly about the loss of heat. If anyone needs urgent medical help, call 911." + delivery
    case 'structural':
      return "Please move away from that area and don't go back in. Contact the building's emergency maintenance line directly. If anyone is in immediate danger, call 911." + delivery
  }
}
