/**
 * Secret access, in one place.
 *
 * SOW 15.2 requires that secrets never appear in source code, logs, screenshots,
 * tickets or client-visible configuration. Centralising reads here means there is one
 * place to audit, and `redact` exists so a secret cannot be logged by accident when
 * someone reaches for console.log during a 2am incident.
 */

export type SecretName =
  /** Vapi API key for outbound calls to Vapi. Server-side only, never a browser. */
  | 'VAPI_PRIVATE_KEY'
  /** Shared secret used to verify inbound Vapi webhooks are genuine. */
  | 'VAPI_WEBHOOK_SECRET'
  /** Passcode staff type to open the operations dashboard and read the call log. */
  | 'OPS_DASHBOARD_PASSCODE'
  /** Model provider key for the conversation engine. */
  | 'ANTHROPIC_API_KEY'

export interface SecretSpec {
  name: SecretName
  purpose: string
  /** Who owns rotation — SOW 18.2 requires an owner per secret. */
  owner: 'atrium' | 'client'
  requiredFor: string[]
}

/** The credential inventory SOW 18.2 asks for, kept next to the code that reads it. */
export const SECRETS: readonly SecretSpec[] = [
  {
    name: 'VAPI_PRIVATE_KEY',
    purpose: 'Authenticate Atrium to the Vapi API',
    owner: 'atrium',
    requiredFor: ['voice.outbound_api'],
  },
  {
    name: 'VAPI_WEBHOOK_SECRET',
    purpose: 'Verify inbound Vapi webhooks are genuine before acting on them',
    owner: 'atrium',
    requiredFor: ['voice.inbound_webhook'],
  },
  {
    name: 'OPS_DASHBOARD_PASSCODE',
    purpose: 'Gate the operations dashboard and the call log it reads',
    owner: 'client',
    requiredFor: ['ops.dashboard', 'ops.event_log'],
  },
  {
    name: 'ANTHROPIC_API_KEY',
    purpose: 'Model provider for the conversation engine',
    owner: 'atrium',
    requiredFor: ['conversation.engine'],
  },
]

export class MissingSecretError extends Error {
  readonly secret: SecretName

  constructor(secret: SecretName) {
    const spec = SECRETS.find((s) => s.name === secret)
    super(
      `Missing required secret ${secret}` +
      (spec ? ` (${spec.purpose}). Set it in the environment — never in the repo.` : ''),
    )
    this.secret = secret
    this.name = 'MissingSecretError'
  }
}

/**
 * Reads a secret or throws. Deliberately throws rather than returning undefined: a voice
 * agent that boots without its webhook secret and answers calls unverified is worse than
 * one that refuses to start.
 */
export function requireSecret(name: SecretName, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') throw new MissingSecretError(name)
  return value
}

export function hasSecret(name: SecretName, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[name]
  return v !== undefined && v.trim() !== ''
}

/** Safe for logs and error reports: shows enough to identify, never enough to use. */
export function redact(value: string): string {
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`
}

/** Startup check — report every missing secret at once rather than one per restart. */
export function checkSecrets(
  required: SecretName[], env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; missing: SecretName[] } {
  const missing = required.filter((n) => !hasSecret(n, env))
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}
