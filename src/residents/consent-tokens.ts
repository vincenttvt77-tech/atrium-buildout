import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AuthenticatedUser } from '../auth/model.ts'
import type { PropertyResponseScope } from '../application/runtime.ts'
import { assertManagedSession } from '../auth/session-management.ts'
import { validId, validVersion } from '../auth/validation.ts'
import { validSessionId } from '../auth/session.ts'
import { ConsentError } from './consent-model.ts'

const TTL = 30 * 60 * 1000
function sign(payload: string, secret: string): Buffer {
  if (typeof secret !== 'string' || secret.trim().length < 32) throw new ConsentError('consent_unavailable')
  return createHmac('sha256', secret).update(`atrium-consent-form-v1|${payload}`).digest()
}
function fields(principal: AuthenticatedUser, scope: PropertyResponseScope | null, caseId: string | null): unknown[] {
  assertManagedSession(principal)
  if (principal.audience === 'staff') {
    if (!scope || !validId(scope.organizationId) || !validId(scope.propertyId) || !validVersion(scope.configurationVersion)
      || typeof scope.permissionVersion !== 'string' || scope.permissionVersion.length < 1 || scope.permissionVersion.length > 512
      || !validSessionId(caseId)) throw new ConsentError('consent_invalid_input')
  } else if (principal.audience !== 'resident' || scope !== null || caseId !== null) throw new ConsentError('consent_invalid_input')
  return [principal.audience, principal.userId, principal.credentialVersion, principal.sessionId,
    scope?.organizationId ?? null, scope?.propertyId ?? null, scope?.configurationVersion ?? null, scope?.permissionVersion ?? null, caseId]
}
export function mintConsentForm(principal: AuthenticatedUser, scope: PropertyResponseScope | null, caseId: string | null, now: Date, secret: string): string {
  if (!Number.isFinite(now.getTime()) || principal.sessionExpiresAt! <= now.getTime()) throw new ConsentError('consent_unauthenticated')
  const payload = Buffer.from(JSON.stringify([...fields(principal, scope, caseId), Math.min(now.getTime() + TTL, principal.sessionExpiresAt!)])).toString('base64url')
  return `${payload}.${sign(payload, secret).toString('base64url')}`
}
export function verifyConsentForm(value: unknown, principal: AuthenticatedUser, scope: PropertyResponseScope | null, caseId: string | null, now: Date, secret: string): boolean {
  try {
    if (typeof value !== 'string' || value.length > 4096 || !Number.isFinite(now.getTime())) return false
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value)
    if (!match) return false
    const raw = Buffer.from(match[1]!, 'base64url'), signature = Buffer.from(match[2]!, 'base64url')
    if (raw.toString('base64url') !== match[1] || signature.toString('base64url') !== match[2]
      || !timingSafeEqual(signature, sign(match[1]!, secret))) return false
    const body: unknown = JSON.parse(raw.toString('utf8'))
    return Array.isArray(body) && body.length === 10 && Number.isSafeInteger(body[9])
      && body[9] > now.getTime() && body[9] <= now.getTime() + TTL && body[9] <= principal.sessionExpiresAt!
      && JSON.stringify(body.slice(0, 9)) === JSON.stringify(fields(principal, scope, caseId))
  } catch { return false }
}
