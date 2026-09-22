import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AuthenticatedUser } from '../auth/model.ts'
import { assertStaffUser } from '../auth/identity.ts'
import type { PropertyResponseScope } from '../application/runtime.ts'
import { assertManagedSession } from '../auth/session-management.ts'
import { validSessionId } from '../auth/session.ts'
import type { EnrollmentPreview } from './enrollment-model.ts'
import { EnrollmentError } from './enrollment-model.ts'

export const RESIDENT_BROWSER_COOKIE = 'atrium_resident_browser'
export const RESIDENT_INVITATION_COOKIE = 'atrium_resident_invitation'
export const RESIDENT_BROWSER_TTL_MS = 30 * 60 * 1000
export interface ResidentBrowser { id: string; expiresAt: number }
export interface ResidentInvitationContext { tokenHash: string; browserId: string; expiresAt: number }
function signature(purpose: string, payload: string, secret: string): Buffer {
  if (typeof secret !== 'string' || secret.trim().length < 32) throw new Error('A configured signing secret is required.')
  return createHmac('sha256', secret).update(`atrium-resident-${purpose}-v1|${payload}`).digest()
}
function mint(purpose: string, fields: unknown[], secret: string): string {
  const payload = Buffer.from(JSON.stringify(fields)).toString('base64url')
  return `${payload}.${signature(purpose, payload, secret).toString('base64url')}`
}
function read(purpose: string, value: unknown, secret: string): unknown[] | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value)
  if (!match) return null
  try {
    const payload = Buffer.from(match[1]!, 'base64url'), supplied = Buffer.from(match[2]!, 'base64url')
    if (payload.toString('base64url') !== match[1] || supplied.toString('base64url') !== match[2]
      || !timingSafeEqual(supplied, signature(purpose, match[1]!, secret))) return null
    const fields: unknown = JSON.parse(payload.toString('utf8'))
    return Array.isArray(fields) ? fields : null
  } catch { return null }
}
const current = (expiry: unknown, now: Date): expiry is number => Number.isSafeInteger(expiry)
  && Number.isFinite(now.getTime()) && Number(expiry) > now.getTime() && Number(expiry) <= now.getTime() + RESIDENT_BROWSER_TTL_MS
export function createResidentBrowser(now: Date): ResidentBrowser {
  if (!Number.isFinite(now.getTime())) throw new EnrollmentError('enrollment_unavailable')
  return { id: randomUUID(), expiresAt: now.getTime() + RESIDENT_BROWSER_TTL_MS }
}
export const mintResidentBrowser = (browser: ResidentBrowser, secret: string): string => mint('browser', [browser.id, browser.expiresAt], secret)
export function readResidentBrowser(value: unknown, now: Date, secret: string): ResidentBrowser | null {
  const fields = read('browser', value, secret)
  return fields?.length === 2 && validSessionId(fields[0]) && current(fields[1], now) ? { id: fields[0], expiresAt: fields[1] } : null
}
function identity(principal: AuthenticatedUser | null): [string | null, string | null] {
  if (!principal) return [null, null]
  assertManagedSession(principal)
  if (principal.audience !== 'resident') throw new EnrollmentError('enrollment_forbidden')
  return [principal.userId, principal.sessionId!]
}
export function mintResidentForm(browser: ResidentBrowser, principal: AuthenticatedUser | null, secret: string): string {
  return mint('form', [browser.id, ...identity(principal), browser.expiresAt], secret)
}
export function verifyResidentForm(value: unknown, browser: ResidentBrowser, principal: AuthenticatedUser | null, now: Date, secret: string): boolean {
  const fields = read('form', value, secret), [userId, sessionId] = identity(principal)
  return !!fields && fields.length === 4 && fields[0] === browser.id && fields[1] === userId && fields[2] === sessionId
    && fields[3] === browser.expiresAt && current(fields[3], now)
}
export function newEnrollmentToken(): string { return randomBytes(32).toString('base64url') }
export function hashEnrollmentToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) {
    throw new EnrollmentError('enrollment_invalid_input')
  }
  return createHash('sha256').update(value).digest('hex')
}
export function mintResidentInvitation(context: ResidentInvitationContext, secret: string): string {
  return mint('invitation', [context.tokenHash, context.browserId, context.expiresAt], secret)
}
export function readResidentInvitation(value: unknown, browser: ResidentBrowser, now: Date, secret: string): ResidentInvitationContext | null {
  const fields = read('invitation', value, secret)
  return fields?.length === 3 && typeof fields[0] === 'string' && /^[a-f0-9]{64}$/.test(fields[0]) && fields[1] === browser.id
    && current(fields[2], now) && fields[2] <= browser.expiresAt
    ? { tokenHash: fields[0], browserId: fields[1], expiresAt: fields[2] } : null
}
const previewFields = (preview: EnrollmentPreview): unknown[] => [preview.invitationId, preview.invitationVersion,
  preview.propertyName, preview.unitId, preview.recipientHint, preview.expiresAt]
export function mintEnrollmentReview(preview: EnrollmentPreview, context: ResidentInvitationContext, secret: string): string {
  return mint('review', [context.browserId, context.tokenHash, context.expiresAt, ...previewFields(preview)], secret)
}
export function verifyEnrollmentReview(value: unknown, preview: EnrollmentPreview, context: ResidentInvitationContext, now: Date, secret: string): boolean {
  const fields = read('review', value, secret)
  return !!fields && fields.length === 9 && current(context.expiresAt, now) && Date.parse(preview.expiresAt) > now.getTime()
    && JSON.stringify(fields) === JSON.stringify([context.browserId, context.tokenHash, context.expiresAt, ...previewFields(preview)])
}
export const enrollmentPrivateKey = (kind: 'client' | 'browser', value: string, secret: string): string =>
  signature(kind, value, secret).toString('hex')
const staffFields = (principal: AuthenticatedUser, scope: PropertyResponseScope, residentId: string): unknown[] => {
  assertStaffUser(principal); assertManagedSession(principal)
  return [principal.userId, principal.credentialVersion, principal.sessionId, scope.organizationId, scope.propertyId,
    scope.configurationVersion, scope.permissionVersion, residentId]
}
export function mintEnrollmentStaffForm(principal: AuthenticatedUser, scope: PropertyResponseScope, residentId: string, now: Date, secret: string): string {
  return mint('staff-form', [...staffFields(principal, scope, residentId), Math.min(now.getTime() + RESIDENT_BROWSER_TTL_MS, principal.sessionExpiresAt!)], secret)
}
export function verifyEnrollmentStaffForm(value: unknown, principal: AuthenticatedUser, scope: PropertyResponseScope, residentId: string, now: Date, secret: string): boolean {
  const fields = read('staff-form', value, secret)
  return !!fields && fields.length === 9 && current(fields[8], now)
    && JSON.stringify(fields.slice(0, 8)) === JSON.stringify(staffFields(principal, scope, residentId))
}
export function residentCookie(name: string, value: string, secure: boolean, maxAgeSeconds: number): string {
  if (![RESIDENT_BROWSER_COOKIE, RESIDENT_INVITATION_COOKIE, 'atrium_resident_session'].includes(name)
    || !/^[A-Za-z0-9_.-]*$/.test(value) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new Error('Invalid resident cookie.')
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}
