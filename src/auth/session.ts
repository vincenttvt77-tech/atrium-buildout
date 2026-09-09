import { createHmac, timingSafeEqual } from 'node:crypto'
import { assertAuthenticatedUser } from './identity.ts'
import type { AuthenticatedUser } from './model.ts'
import { validId, validVersion } from './validation.ts'

export const USER_SESSION_TTL_MS = 8 * 60 * 60 * 1000
const CONTEXT = 'atrium-database-user-session-v3'
export interface UserSessionClaims { userId: string; credentialVersion: number; expiresAt: number }
function requireSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.trim().length < 32) throw new Error('A session signing secret of at least 32 characters is required.')
}
function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`${CONTEXT}|${payload}`).digest()
}

/** Scope/roles never enter this cookie; every request resolves current user and membership. */
export function mintUserSession(principal: AuthenticatedUser, now: Date, secret: string, ttlMs = USER_SESSION_TTL_MS): string {
  assertAuthenticatedUser(principal)
  requireSecret(secret)
  const expiresAt = now.getTime() + ttlMs
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > USER_SESSION_TTL_MS || !Number.isSafeInteger(expiresAt)) throw new Error('Invalid session lifetime.')
  const payload = Buffer.from(JSON.stringify({ userId: principal.userId, credentialVersion: principal.credentialVersion, expiresAt })).toString('base64url')
  return `a3.${payload}.${signature(payload, secret).toString('base64url')}`
}

/** Signature validation alone does not authenticate: the service rechecks the current user. */
export function verifyUserSessionClaims(token: string | undefined, now: Date, secret: string): UserSessionClaims | null {
  requireSecret(secret)
  if (!token || token.length > 2048 || !Number.isFinite(now.getTime())) return null
  const match = /^a3\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!match) return null
  const presented = Buffer.from(match[2]!, 'base64url')
  if (presented.toString('base64url') !== match[2] || !timingSafeEqual(presented, signature(match[1]!, secret))) return null
  try {
    const bytes = Buffer.from(match[1]!, 'base64url')
    if (bytes.toString('base64url') !== match[1]) return null
    const claims: unknown = JSON.parse(bytes.toString('utf8'))
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null
    const value = claims as Record<string, unknown>
    if (Object.keys(value).length !== 3 || !validId(value.userId) || !validVersion(value.credentialVersion)
      || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
      || value.expiresAt <= now.getTime() || value.expiresAt > now.getTime() + USER_SESSION_TTL_MS) return null
    return { userId: value.userId, credentialVersion: value.credentialVersion, expiresAt: value.expiresAt }
  } catch { return null }
}
