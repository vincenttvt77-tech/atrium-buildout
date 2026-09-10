import { isIP } from 'node:net'
import { MfaError } from './mfa-model.ts'
import type { MfaConfiguration } from './mfa-model.ts'

/** Deployment configuration only. Never infer WebAuthn authority from request headers. */
export function mfaConfiguration(origin: unknown): MfaConfiguration {
  if (typeof origin !== 'string' || origin.length > 512) throw new MfaError('mfa_unavailable')
  let url: URL
  try { url = new URL(origin) } catch { throw new MfaError('mfa_unavailable') }
  const host = url.hostname
  if (origin !== url.origin || url.username || url.password || url.search || url.hash
    || isIP(host.replace(/^\[|\]$/g, '')) || host.endsWith('.')
    || (host !== 'localhost' && (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)
      || host.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))))
    || !(url.protocol === 'https:' || (host === 'localhost' && url.protocol === 'http:'))) {
    throw new MfaError('mfa_unavailable')
  }
  return Object.freeze({ origin, rpId: host, rpName: 'Atrium' })
}
