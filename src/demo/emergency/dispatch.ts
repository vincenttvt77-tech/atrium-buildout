import { instructionFor, nextStep } from './policy.ts'
import { composeAlert } from './transport.ts'
import type { EmergencySignal } from '../../escalation/emergency.ts'
import type { EscalationPolicy } from './policy.ts'
import type { EmergencyScope, EmergencyStore, EscalationRecord } from './store.ts'
import type { AlertTransport } from './transport.ts'

/**
 * Opens a safety escalation and moves it along, one step per call.
 *
 * Opening one always attempts the first contact in the same call. There is no queue, no
 * backoff and no runner to wait for, and that is deliberate: the durable workflow engine is
 * the right home for a tour booking, but it processes work in turn, and an emergency behind
 * twenty queued bookings is an emergency nobody hears about. Scope of Work 8.1 does not
 * allow that, so this path goes direct and keeps the durable record for the chain that
 * follows.
 *
 * Everything after the first contact is driven by `advance`, which is safe to call as often
 * as anyone likes: it re-reads state, asks the policy what is due, and does nothing at all
 * when the answer is to wait.
 */

export interface EmergencyPorts {
  readonly store: EmergencyStore
  readonly transport: AlertTransport
  readonly propertyName: string
  readonly now?: () => Date
  readonly policy?: EscalationPolicy
  readonly approvedInstructions?: Readonly<Record<string, string>> | null
  readonly newId?: () => string
}

export interface OpenInput extends EmergencyScope {
  readonly signal: EmergencySignal
  readonly unitLabel?: string | null
  readonly callerNumber?: string | null
}

export type AdvanceOutcome =
  | { readonly action: 'notified'; readonly position: number; readonly contactName: string; readonly outcome: string }
  | { readonly action: 'waiting'; readonly untilMs: number }
  | { readonly action: 'acknowledged' }
  | { readonly action: 'exhausted'; readonly reason: 'no_contacts' | 'contacts_exhausted' }

export interface OpenResult {
  readonly escalation: EscalationRecord
  /** What the caller is told, available to the voice agent without waiting for any of the above. */
  readonly instruction: string
  readonly callEmergencyServices: boolean
  readonly first: AdvanceOutcome
}

let fallbackCounter = 0
const defaultId = (): string => {
  fallbackCounter += 1
  return `escalation-${Date.now().toString(36)}-${fallbackCounter}`
}

export async function openEmergency(input: OpenInput, ports: EmergencyPorts): Promise<OpenResult> {
  const now = ports.now ?? (() => new Date())
  const instruction = instructionFor(input.signal, ports.approvedInstructions ?? null)
  const record = await ports.store.open({
    id: (ports.newId ?? defaultId)(),
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    signal: input.signal,
    unitLabel: input.unitLabel ?? null,
    callerNumber: input.callerNumber ?? null,
    instruction: instruction.text,
    instructionSource: instruction.source,
    openedAtMs: now().getTime(),
  })
  // The caller's instruction is already decided above and is returned whatever happens
  // below, so a storage or transport problem can never leave a caller with no words.
  const first = await advance(record.id, ports)
  return {
    escalation: record,
    instruction: instruction.text,
    callEmergencyServices: instruction.callEmergencyServices,
    first,
  }
}

export async function advance(escalationId: string, ports: EmergencyPorts): Promise<AdvanceOutcome> {
  const now = ports.now ?? (() => new Date())
  const record = await ports.store.get(escalationId)
  if (!record) return { action: 'exhausted', reason: 'no_contacts' }
  if (record.acknowledgedAtMs !== null) return { action: 'acknowledged' }

  const [contacts, attempts] = await Promise.all([
    ports.store.contacts({ organizationId: record.organizationId, propertyId: record.propertyId }),
    ports.store.attempts(escalationId),
  ])

  const step = nextStep({
    contacts,
    attempts,
    acknowledgedAtMs: record.acknowledgedAtMs,
    nowMs: now().getTime(),
    ...(ports.policy === undefined ? {} : { policy: ports.policy }),
  })

  if (step.action === 'acknowledged') return { action: 'acknowledged' }
  if (step.action === 'wait') return { action: 'waiting', untilMs: step.untilMs }
  if (step.action === 'exhausted') {
    await ports.store.setStatus(escalationId, 'exhausted')
    return { action: 'exhausted', reason: contacts.length ? 'contacts_exhausted' : 'no_contacts' }
  }

  const composed = composeAlert({
    propertyName: ports.propertyName,
    unitLabel: record.unitLabel,
    callerNumber: record.callerNumber,
    signal: record.signal,
    instruction: record.instruction,
    openedAt: new Date(record.openedAtMs),
    position: step.contact.position,
    contactName: step.contact.name,
  })
  const message = { ...composed, channel: step.contact.channel, address: step.contact.address }

  let result
  try {
    result = await ports.transport.send(message)
  } catch (error) {
    // A transport that throws is a contact who was not reached, which moves the chain on
    // rather than ending it. The failure is recorded so it is visible either way.
    result = {
      outcome: 'failed' as const,
      detail: error instanceof Error ? error.message.slice(0, 200) : 'the transport failed',
      reference: null,
    }
  }

  await ports.store.recordAttempt({
    escalationId,
    position: step.contact.position,
    attemptedAtMs: now().getTime(),
    outcome: result.outcome,
    contactName: step.contact.name,
    channel: step.contact.channel,
    address: step.contact.address,
    subject: message.subject,
    body: message.body,
    detail: result.detail,
    reference: result.reference,
    // Only a transport that genuinely delivers may produce a delivered attempt.
    delivered: ports.transport.delivers && result.outcome === 'delivered',
  })

  return {
    action: 'notified',
    position: step.contact.position,
    contactName: step.contact.name,
    outcome: result.outcome,
  }
}

export async function acknowledgeEmergency(
  escalationId: string, by: string, ports: EmergencyPorts,
): Promise<boolean> {
  const now = ports.now ?? (() => new Date())
  return ports.store.acknowledge(escalationId, by, now().getTime())
}
