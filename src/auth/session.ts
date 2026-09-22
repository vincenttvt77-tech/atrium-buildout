import { createHmac, timingSafeEqual } from 'node:crypto'
import { assertAuthenticatedUser } from './identity.ts'
import type { AuthenticatedUser, SessionAudience, UserSessionClaims } from './model.ts'
import { validId, validVersion } from './validation.ts'

export const USER_SESSION_TTL_MS = 8 * 60 * 60 * 1000
const CONTEXT = 'atrium-database-user-session-v4'
const RESIDENT_CONTEXT = 'atrium-database-resident-session-v1'
export const RESIDENT_COOKIE = 'atrium_resident_session'
export type { UserSessionClaims } from './model.ts'
export const validSessionId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
function requireSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.trim().length < 32) throw new Error('A session signing secret of at least 32 characters is required.')
}
function signature(payload: string, secret: string, audience: SessionAudience): Buffer {
  return createHmac('sha256', secret).update(`${audience === 'staff' ? CONTEXT : RESIDENT_CONTEXT}|${payload}`).digest()
}

/** Scope/roles never enter this cookie; every request resolves current user and membership. */
export function mintUserSession(principal: AuthenticatedUser, now: Date, secret: string): string {
  return mintSession(principal, now, secret, 'staff')
}
export function mintResidentSession(principal: AuthenticatedUser, now: Date, secret: string): string {
  return mintSession(principal, now, secret, 'resident')
}
function mintSession(principal: AuthenticatedUser, now: Date, secret: string, audience: SessionAudience): string {
  assertAuthenticatedUser(principal)
  if (principal.audience !== audience) throw new Error('A session for this portal is required.')
  requireSecret(secret)
  const expiresAt = principal.sessionExpiresAt
  if (!validSessionId(principal.sessionId) || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
    || !Number.isFinite(now.getTime()) || expiresAt <= now.getTime() || expiresAt > 8_640_000_000_000_000) throw new Error('A registered session with a valid lifetime is required.')
  const payload = Buffer.from(JSON.stringify({ userId: principal.userId, credentialVersion: principal.credentialVersion, sessionId: principal.sessionId, expiresAt })).toString('base64url')
  return `${audience === 'staff' ? 'a4' : 'r1'}.${payload}.${signature(payload, secret, audience).toString('base64url')}`
}

/** Signature validation alone does not authenticate: the service rechecks the current user. */
export function verifyUserSessionClaims(token: string | undefined, now: Date, secret: string): UserSessionClaims | null {
  return verifySessionClaims(token, now, secret, 'staff')
}
export function verifyResidentSessionClaims(token: string | undefined, now: Date, secret: string): UserSessionClaims | null {
  return verifySessionClaims(token, now, secret, 'resident')
}
function verifySessionClaims(token: string | undefined, now: Date, secret: string, audience: SessionAudience): UserSessionClaims | null {
  requireSecret(secret)
  if (!token || token.length > 2048 || !Number.isFinite(now.getTime())) return null
  const match = (audience === 'staff' ? /^a4\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/ : /^r1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/).exec(token)
  if (!match) return null
  const presented = Buffer.from(match[2]!, 'base64url')
  if (presented.toString('base64url') !== match[2] || !timingSafeEqual(presented, signature(match[1]!, secret, audience))) return null
  try {
    const bytes = Buffer.from(match[1]!, 'base64url')
    if (bytes.toString('base64url') !== match[1]) return null
    const claims: unknown = JSON.parse(bytes.toString('utf8'))
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null
    const value = claims as Record<string, unknown>
    if (Object.keys(value).length !== 4 || !validSessionId(value.sessionId) || !validId(value.userId) || !validVersion(value.credentialVersion)
      || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
      || value.expiresAt <= now.getTime() || value.expiresAt > 8_640_000_000_000_000) return null
    return { userId: value.userId, credentialVersion: value.credentialVersion, sessionId: value.sessionId, expiresAt: value.expiresAt, audience }
  } catch { return null }
}
