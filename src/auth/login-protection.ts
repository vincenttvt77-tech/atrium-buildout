import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { normalizeUsername } from './validation.ts'

export interface LoginProtectionRepository {
  /** Commit the reservation before returning; the database owns limits and time. */
  reserve(keys: { usernameKey: string; clientKey: string }): Promise<{ allowed: boolean; retryAfterSeconds: number }>
}

export class LoginProtectionError extends Error {
  readonly code: 'rate_limited' | 'login_unavailable'
  readonly retryAfterSeconds: number | undefined
  constructor(code: LoginProtectionError['code'], retryAfterSeconds?: number) {
    super(code === 'rate_limited' ? 'Sign-in is temporarily limited. Please try again later.' : 'Sign-in is temporarily unavailable.')
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Vercel overwrites this header at its ingress. Elsewhere, only the actual peer is
 * trusted: an arbitrary forwarded header must not create a new guessing budget.
 * Deployments behind other proxies share the peer's budget until their ingress
 * trust boundary is explicitly implemented and verified.
 */
export function requestLoginAddress(req: { headers?: Record<string, unknown>; socket?: { remoteAddress?: unknown } },
  env: { VERCEL?: string | undefined } = process.env): string {
  const value = env.VERCEL === '1' ? req.headers?.['x-vercel-forwarded-for'] : req.socket?.remoteAddress
  return typeof value === 'string' && value.length <= 45 && !value.includes('%') && isIP(value) ? value : 'unknown'
}

/** Collapse textual aliases and IPv6 address rotation within one network. */
function networkIdentity(value: unknown): string {
  if (typeof value !== 'string' || value.length > 45 || value.includes('%')) return 'unknown'
  const family = isIP(value)
  if (family === 4) return `v4:${value}`
  if (family !== 6) return 'unknown'
  let address = value.toLowerCase()
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':')
    const octets = address.slice(lastColon + 1).split('.').map(Number)
    address = address.slice(0, lastColon + 1) + ((octets[0]! << 8) | octets[1]!).toString(16)
      + ':' + ((octets[2]! << 8) | octets[3]!).toString(16)
  }
  const halves = address.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const words = (halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left).map(word => parseInt(word, 16))
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return `v4:${words[6]! >>> 8}.${words[6]! & 255}.${words[7]! >>> 8}.${words[7]! & 255}`
  }
  return `v6:${words.slice(0, 4).map(word => word.toString(16).padStart(4, '0')).join(':')}::/64`
}

export function createLoginProtection(repository: LoginProtectionRepository, secret: string) {
  if (typeof secret !== 'string' || secret.trim().length < 32) throw new Error('A session signing secret of at least 32 characters is required.')
  const digest = (kind: 'username' | 'client', value: string) => createHmac('sha256', secret)
    .update(JSON.stringify(['atrium-login-protection-v1', kind, value])).digest('hex')
  return Object.freeze({
    async reserve(username: unknown, clientAddress: unknown): Promise<void> {
      const keys = { usernameKey: digest('username', normalizeUsername(username) ?? '!invalid-username'),
        clientKey: digest('client', networkIdentity(clientAddress)) }
      let result: Awaited<ReturnType<LoginProtectionRepository['reserve']>>
      try { result = await repository.reserve(keys) }
      catch { throw new LoginProtectionError('login_unavailable') }
      if (!result || typeof result.allowed !== 'boolean' || !Number.isSafeInteger(result.retryAfterSeconds)
        || result.retryAfterSeconds < 0 || result.retryAfterSeconds > 2147483647
        || (result.allowed ? result.retryAfterSeconds !== 0 : result.retryAfterSeconds < 1)) {
        throw new LoginProtectionError('login_unavailable')
      }
      if (!result.allowed) throw new LoginProtectionError('rate_limited', result.retryAfterSeconds)
    },
  })
}
