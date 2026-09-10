import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AuthenticatedUser } from './model.ts'
import { assertAuthenticatedUser } from './identity.ts'

const TTL_MS = 60 * 60 * 1000
const signature = (payload: string, secret: string) => createHmac('sha256', secret)
  .update(`atrium-account-csrf-v1.${payload}`).digest('base64url')

/** Signed form token bound to the rendered identity and current credential version. */
export function mintAccountFormToken(principal: AuthenticatedUser, now: Date, secret: string): string {
  assertAuthenticatedUser(principal)
  const payload = Buffer.from(JSON.stringify([principal.userId, principal.credentialVersion,
    now.getTime() + TTL_MS, randomBytes(24).toString('base64url')])).toString('base64url')
  return `${payload}.${signature(payload, secret)}`
}

export function verifyAccountFormToken(token: unknown, principal: AuthenticatedUser, now: Date, secret: string): boolean {
  assertAuthenticatedUser(principal)
  if (typeof token !== 'string' || token.length > 1024) return false
  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [payload, supplied] = parts as [string, string]
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false
  const expected = signature(payload, secret)
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return false
  try {
    const fields: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return Array.isArray(fields) && fields.length === 4 && fields[0] === principal.userId
      && fields[1] === principal.credentialVersion && Number.isSafeInteger(fields[2])
      && fields[2] > now.getTime() && fields[2] <= now.getTime() + TTL_MS
      && typeof fields[3] === 'string' && /^[A-Za-z0-9_-]{32}$/.test(fields[3])
  } catch { return false }
}

/** Reject simple cross-site forms and ambiguous proxy/header inputs before credential work. */
export function isSameOriginAccountRequest(headers: Record<string, unknown>): boolean {
  if (typeof headers.origin !== 'string' || typeof headers.host !== 'string'
    || headers['x-atrium-account-action'] !== 'change-password'
    || typeof headers['content-type'] !== 'string'
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'])
    || (headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin')) return false
  try {
    const origin = new URL(headers.origin)
    // No credentials, paths, opaque origins, or multiple Origin values.
    if (origin.origin !== headers.origin || origin.host !== headers.host) return false
    if (origin.protocol === 'https:') return headers['x-forwarded-proto'] === undefined || headers['x-forwarded-proto'] === 'https'
    return origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      && (headers['x-forwarded-proto'] === undefined || headers['x-forwarded-proto'] === 'http')
  } catch { return false }
}
