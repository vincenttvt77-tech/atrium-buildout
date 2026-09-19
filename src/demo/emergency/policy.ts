import type { EmergencySignal } from '../../escalation/emergency.ts'

/**
 * Who gets told about an emergency, in what order, and when to give up on one person and
 * try the next. Pure decisions, so the ordering can be tested exhaustively without a
 * database, a transport or a clock.
 *
 * Detection already exists in src/escalation/emergency.ts and the record already exists in
 * src/calls/safety-events.ts, where `notificationStatus` is the literal type `'not_sent'`
 * and nothing anywhere sets it to anything else. Atrium currently notices a gas leak,
 * writes it down correctly, and tells nobody. This is the missing half.
 *
 * Two rules from Scope of Work 8.1 are structural here rather than advisory:
 *
 * The first contact is attempted immediately. There is no approval step, no diagnostic
 * questioning and no waiting period before a safety escalation starts, so `nextStep` with
 * no attempts on record always returns a notification, whatever else is true.
 *
 * Silence is not acknowledgement. A contact who does not answer within the window is
 * passed over for the next one, and the chain keeps going until somebody confirms or the
 * list runs out. Running out is a state a person has to see, not a quiet ending.
 */

export interface EmergencyContact {
  /** 1 is called first. Positions are a property's configured order, not a ranking of people. */
  readonly position: number
  readonly name: string
  readonly channel: 'sms' | 'voice' | 'email'
  readonly address: string
}

export interface AttemptRecord {
  readonly position: number
  readonly attemptedAtMs: number
  readonly outcome: 'recorded' | 'delivered' | 'failed'
}

export interface EscalationPolicy {
  /** How long one contact gets before the next is tried. */
  readonly acknowledgeWithinMs: number
  readonly maxContacts: number
}

/**
 * Two minutes matches the emergency response deadline already set in
 * src/escalation/escalate.ts, so the chain and the SLA cannot drift apart.
 */
export const DEFAULT_EMERGENCY_POLICY: EscalationPolicy = {
  acknowledgeWithinMs: 2 * 60_000,
  maxContacts: 4,
}

export type NextStep =
  | { readonly action: 'notify'; readonly contact: EmergencyContact }
  | { readonly action: 'wait'; readonly untilMs: number; readonly awaiting: number }
  | { readonly action: 'exhausted' }
  | { readonly action: 'acknowledged' }

export interface NextStepInput {
  readonly contacts: readonly EmergencyContact[]
  readonly attempts: readonly AttemptRecord[]
  readonly acknowledgedAtMs: number | null
  readonly nowMs: number
  readonly policy?: EscalationPolicy
}

/** Configured order, de-duplicated by position, capped by policy. */
export function orderedContacts(
  contacts: readonly EmergencyContact[],
  policy: EscalationPolicy = DEFAULT_EMERGENCY_POLICY,
): EmergencyContact[] {
  const seen = new Set<number>()
  return [...contacts]
    .filter(contact => contact.position >= 1 && Number.isSafeInteger(contact.position))
    .sort((left, right) => left.position - right.position)
    .filter(contact => (seen.has(contact.position) ? false : (seen.add(contact.position), true)))
    .slice(0, policy.maxContacts)
}

export function nextStep(input: NextStepInput): NextStep {
  const policy = input.policy ?? DEFAULT_EMERGENCY_POLICY
  if (input.acknowledgedAtMs !== null) return { action: 'acknowledged' }

  const contacts = orderedContacts(input.contacts, policy)
  if (!contacts.length) return { action: 'exhausted' }

  // Nothing has been tried. Go now. No condition below this line can introduce a delay,
  // which is the point: a safety escalation is never held for anything.
  if (!input.attempts.length) return { action: 'notify', contact: contacts[0] as EmergencyContact }

  const tried = new Set(input.attempts.map(attempt => attempt.position))
  const remaining = contacts.filter(contact => !tried.has(contact.position))

  const lastAttemptMs = Math.max(...input.attempts.map(attempt => attempt.attemptedAtMs))
  const dueAtMs = lastAttemptMs + policy.acknowledgeWithinMs

  // A failed send is not a person who was given a chance to answer, so the next contact is
  // tried at once rather than after the window. A phone that rang out still gets its window.
  const lastFailed = input.attempts
    .filter(attempt => attempt.attemptedAtMs === lastAttemptMs)
    .every(attempt => attempt.outcome === 'failed')

  if (!remaining.length) return { action: 'exhausted' }
  if (lastFailed || input.nowMs >= dueAtMs) {
    return { action: 'notify', contact: remaining[0] as EmergencyContact }
  }
  return { action: 'wait', untilMs: dueAtMs, awaiting: input.attempts[input.attempts.length - 1]?.position ?? 0 }
}

export interface SafetyInstruction {
  readonly text: string
  /** Whether the words came from the property's approved set or the built-in fallback. */
  readonly source: 'property' | 'default'
  readonly callEmergencyServices: boolean
}

const DEFAULT_INSTRUCTIONS: Record<string, string> = {
  gas: 'Leave the building now. Do not switch anything on or off, including lights. Once you are outside, call 911.',
  smoke_or_fire: 'Leave the building now by the stairs. Do not use the lift. Once you are outside, call 911.',
  carbon_monoxide: 'Get everyone outside into fresh air now, then call 911.',
  injury: 'Call 911 now. Stay with the person if it is safe to do so.',
  intruder: 'Get somewhere you can lock, then call 911.',
  flooding: 'Keep away from any water near sockets or electrical fittings. We are contacting the building now.',
  no_heat: 'We are contacting the building now. If anyone is unwell from the cold, call 911.',
  structural: 'Leave the affected area now and stay out of it. We are contacting the building now.',
}

/**
 * The words a caller hears. A property may approve its own; the fallback is deliberately
 * conservative, and the source is reported so a screen can show which was used. What it
 * must never do is invent an instruction for a kind it has no words for.
 */
export function instructionFor(
  signal: EmergencySignal,
  approved: Readonly<Record<string, string>> | null = null,
): SafetyInstruction {
  const property = approved?.[signal.kind]
  if (typeof property === 'string' && property.trim()) {
    return { text: property.trim(), source: 'property', callEmergencyServices: signal.callEmergencyServices }
  }
  const fallback = DEFAULT_INSTRUCTIONS[signal.kind]
  if (fallback) return { text: fallback, source: 'default', callEmergencyServices: signal.callEmergencyServices }
  return {
    text: signal.callEmergencyServices
      ? 'Call 911 now. We are contacting the building at the same time.'
      : 'We are contacting the building now.',
    source: 'default',
    callEmergencyServices: signal.callEmergencyServices,
  }
}
