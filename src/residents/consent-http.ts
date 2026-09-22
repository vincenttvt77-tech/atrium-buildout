import { randomUUID } from 'node:crypto'
import type { DatabaseRuntime } from '../application/runtime.ts'
import { readRuntimeError } from '../application/runtime.ts'
import { MfaError } from '../auth/mfa-model.ts'
import { mfaConfiguration } from '../auth/mfa-config.ts'
import { validSessionId } from '../auth/session.ts'
import { PostgresResidentConsentRepository } from '../database/resident-consent.ts'
import { createResidentConsentService } from './consent-service.ts'
import { ConsentError } from './consent-model.ts'
import type { ConsentListQuery, ResidentConsentRepository } from './consent-model.ts'

export const consentInvalid = (): never => { throw new ConsentError('consent_invalid_input') }
export function consentId(value: unknown): string { if (!validSessionId(value)) return consentInvalid(); return value }
export function consentHeaders(req: any, res: any): void {
  req.atriumRequestId = randomUUID()
  res.setHeader('x-request-id', req.atriumRequestId)
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
}
export function consentPageHeaders(res: any, nonce: string): void {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('content-security-policy', `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`)
}
export function consentObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return consentInvalid()
  return value as Record<string, unknown>
}
export function consentQuery(value: unknown): Record<string, string> {
  const result = consentObject(value ?? {})
  if (Object.values(result).some(item => typeof item !== 'string')) return consentInvalid()
  return result as Record<string, string>
}
export function consentKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) consentInvalid()
}
export function consentBody(value: unknown): Record<string, unknown> {
  try {
    if (Buffer.isBuffer(value)) return consentInvalid()
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    if (!raw || Buffer.byteLength(raw) > 96 * 1024) return consentInvalid()
    return consentObject(JSON.parse(raw))
  } catch { return consentInvalid() }
}
export function consentListQuery(query: Record<string, string>): ConsentListQuery {
  const limit = query.limit === undefined ? 25 : Number(query.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (query.limit !== undefined && String(limit) !== query.limit)) return consentInvalid()
  if ((query.beforeId === undefined) !== (query.beforeCreatedAt === undefined)) return consentInvalid()
  if (query.beforeCreatedAt === undefined) return { limit }
  const time = Date.parse(query.beforeCreatedAt)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== query.beforeCreatedAt) return consentInvalid()
  return { limit, before: { id: consentId(query.beforeId), createdAt: query.beforeCreatedAt } }
}
export function consentServices(runtime: DatabaseRuntime) {
  const configuration = mfaConfiguration(runtime.authenticationOrigin)
  const repository: ResidentConsentRepository = new PostgresResidentConsentRepository(runtime.app, runtime.auth, configuration)
  const service = createResidentConsentService(repository, {
    requireResidentLogin: principal => runtime.mfa.requireLogin(principal),
    async requireStaffAdministration(principal) {
      const auth = runtime.mfa.administrationAuthentication(principal), proof = await auth.verifyCurrentSession(principal)
      const now = Date.now()
      if (!proof || proof.issuer !== auth.issuer || proof.sessionId !== principal.sessionId || proof.subjectId !== principal.userId
        || proof.credentialVersion !== principal.credentialVersion || proof.purpose !== 'organization_administration'
        || proof.method !== 'webauthn' || !Number.isFinite(Date.parse(proof.verifiedAt)) || Date.parse(proof.verifiedAt) > now
        || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= now
        || Date.parse(proof.expiresAt) - Date.parse(proof.verifiedAt) > 600000) throw new MfaError('mfa_required')
      return consentId(proof.verificationId)
    },
  }, configuration)
  return { repository, service }
}
export function consentFailure(res: any, error: unknown): void {
  if (error instanceof ConsentError) {
    if (error.code === 'consent_rate_limited') res.setHeader('retry-after', '900')
    res.status(error.status).json({ code: error.code, error: error.message }); return
  }
  const failure = readRuntimeError(error)
  res.status(failure.status).json(failure.body)
}
