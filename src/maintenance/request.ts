import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AuthenticatedUser } from '../auth/model.ts'
import type { PropertyResponseScope } from '../application/runtime.ts'
import { mintAccountFormToken, verifyAccountFormToken } from '../auth/account-request.ts'

function binding(token: string, scope: PropertyResponseScope, secret: string): string {
  return createHmac('sha256', secret).update('atrium-resident-service-form-v1\n')
    .update(JSON.stringify([scope.organizationId, scope.propertyId, scope.configurationVersion, scope.permissionVersion, token]))
    .digest('base64url')
}

/** A copied form cannot change organization, property, account or browser session. */
export function mintServiceFormToken(principal: AuthenticatedUser, scope: PropertyResponseScope, now: Date, secret: string): string {
  const token = mintAccountFormToken(principal, now, secret)
  return `${token}~${binding(token, scope, secret)}`
}
export function verifyServiceFormToken(value: unknown, principal: AuthenticatedUser,
  scope: PropertyResponseScope, now: Date, secret: string): boolean {
  if (typeof value !== 'string' || value.length > 1200) return false
  const parts = value.split('~')
  if (parts.length !== 2) return false
  const [token, supplied] = parts as [string, string]
  const expected = binding(token, scope, secret)
  return /^[A-Za-z0-9_-]{43}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    && verifyAccountFormToken(token, principal, now, secret)
}
