import type { EmergencySignal } from '../../escalation/emergency.ts'
import type { EmergencyContact } from './policy.ts'

/**
 * How an alert leaves the building, and the one thing a demonstration transport must never
 * do, which is imply that somebody received it.
 *
 * There is no SMS or voice provider connected to this project. A stand-in that reported
 * 'delivered' would make a screen that says an emergency reached the duty manager when
 * nobody was told anything, and that is a worse failure than the silence we are fixing.
 * So the honest outcome is `recorded`: the message was composed and written down, and no
 * human has seen it. The dashboard is expected to say exactly that.
 */

export type AlertChannel = EmergencyContact['channel']

export interface AlertMessage {
  readonly channel: AlertChannel
  readonly address: string
  readonly subject: string
  readonly body: string
}

export interface AlertResult {
  /** `recorded` means composed and stored, not sent. Only a live provider may say `delivered`. */
  readonly outcome: 'recorded' | 'delivered' | 'failed'
  readonly detail: string
  readonly reference: string | null
}

export interface AlertTransport {
  readonly id: string
  /** False for any stand-in. A screen showing an alert must reflect this. */
  readonly delivers: boolean
  send(message: AlertMessage): Promise<AlertResult>
}

export interface AlertContext {
  readonly propertyName: string
  readonly unitLabel: string | null
  readonly callerNumber: string | null
  readonly signal: EmergencySignal
  readonly instruction: string
  readonly openedAt: Date
  readonly position: number
  readonly contactName: string
}

const KIND_WORDS: Record<string, string> = {
  gas: 'Gas smell reported',
  smoke_or_fire: 'Fire or smoke reported',
  carbon_monoxide: 'Carbon monoxide alarm reported',
  injury: 'Injury reported',
  intruder: 'Intruder reported',
  flooding: 'Flooding reported',
  no_heat: 'No heat reported',
  structural: 'Structural problem reported',
}

/**
 * What the person on call reads. It leads with the thing that decides their next thirty
 * seconds, and it quotes the caller rather than summarising, because a summary of "I smell
 * gas in the hallway" is how the hallway gets left out.
 */
export function composeAlert(context: AlertContext): Omit<AlertMessage, 'channel' | 'address'> {
  const where = context.unitLabel ? `unit ${context.unitLabel}` : 'location not stated'
  const headline = KIND_WORDS[context.signal.kind] ?? 'Emergency reported'
  const subject = `${headline} at ${context.propertyName}, ${where}`
  const lines = [
    subject,
    '',
    `Caller said: "${context.signal.matched}"`,
    `Caller number: ${context.callerNumber ?? 'withheld'}`,
    `Reported at: ${context.openedAt.toISOString()}`,
    '',
    `The caller was told: ${context.instruction}`,
    context.signal.callEmergencyServices
      ? 'The caller was directed to emergency services.'
      : 'This was not treated as an immediate danger to life.',
    '',
    `You are contact ${context.position} for this property. Reply ACK to confirm you are handling it.`,
    'If you do not confirm, the next contact will be called.',
  ]
  return { subject, body: lines.join('\n') }
}

/**
 * The stand-in. It stores what would have been sent and says so. `failAddresses` lets a
 * demonstration show a contact who cannot be reached, which is what moves the chain on.
 */
export function recordingTransport(options: { failAddresses?: readonly string[] } = {}): AlertTransport {
  const failing = new Set(options.failAddresses ?? [])
  let counter = 0
  return {
    id: 'demo_recording_transport',
    delivers: false,
    async send(message: AlertMessage): Promise<AlertResult> {
      counter += 1
      if (failing.has(message.address)) {
        return { outcome: 'failed', detail: 'the stand-in transport was told this address fails', reference: null }
      }
      return {
        outcome: 'recorded',
        detail: 'composed and stored by the stand-in transport; nobody was contacted',
        reference: `recorded-${counter}`,
      }
    },
  }
}
