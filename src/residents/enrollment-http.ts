import { randomUUID } from 'node:crypto'
import type { DatabaseRuntime } from '../application/runtime.ts'
import { readRuntimeError } from '../application/runtime.ts'
import { LoginProtectionError } from '../auth/login-protection.ts'
import { MfaError } from '../auth/mfa-model.ts'
import { SessionManagementError } from '../auth/session-management.ts'
import { PostgresResidentEnrollmentRepository } from '../database/resident-enrollment.ts'
import { createResidentEnrollmentService } from './enrollment-service.ts'
import { EnrollmentError } from './enrollment-model.ts'
import { enrollmentId } from './enrollment-validation.ts'

export const enrollmentInvalid = (): never => { throw new EnrollmentError('enrollment_invalid_input') }
export function enrollmentHeaders(req: any, res: any): void {
  const requestId = randomUUID(); req.atriumRequestId = requestId
  res.setHeader('x-request-id', requestId)
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
}
export function enrollmentPageHeaders(res: any, nonce: string): void {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('content-security-policy', `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`)
}
export function enrollmentObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return enrollmentInvalid()
  return value as Record<string, unknown>
}
export function enrollmentQuery(value: unknown): Record<string, string> {
  const result = enrollmentObject(value ?? {})
  if (Object.values(result).some(item => typeof item !== 'string')) return enrollmentInvalid()
  return result as Record<string, string>
}
export function enrollmentKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) enrollmentInvalid()
}
export function enrollmentBody(value: unknown): Record<string, unknown> {
  try {
    if (Buffer.isBuffer(value)) return enrollmentInvalid()
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    if (!raw || Buffer.byteLength(raw) > 16 * 1024) return enrollmentInvalid()
    return enrollmentObject(JSON.parse(raw))
  } catch { return enrollmentInvalid() }
}
export function enrollmentServices(runtime: DatabaseRuntime) {
  const repository = new PostgresResidentEnrollmentRepository(runtime.app, runtime.auth)
  const service = createResidentEnrollmentService(repository, {
    reserveLogin: (username, address) => runtime.loginProtection.reserve(username, address),
    requireResidentLogin: principal => runtime.mfa.requireLogin(principal),
    async requireStaffAdministration(principal) {
      const auth = runtime.mfa.administrationAuthentication(principal), proof = await auth.verifyCurrentSession(principal)
      const now = Date.now()
      if (!proof || proof.issuer !== auth.issuer || proof.sessionId !== principal.sessionId || proof.subjectId !== principal.userId
        || proof.credentialVersion !== principal.credentialVersion || proof.purpose !== 'organization_administration'
        || proof.method !== 'webauthn' || !Number.isFinite(Date.parse(proof.verifiedAt)) || Date.parse(proof.verifiedAt) > now
        || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= now
        || Date.parse(proof.expiresAt) - Date.parse(proof.verifiedAt) > 600_000) throw new MfaError('mfa_required')
      return enrollmentId(proof.verificationId)
    },
  })
  return { repository, service }
}
export function enrollmentFailure(res: any, error: unknown): void {
  if (error instanceof EnrollmentError || error instanceof SessionManagementError) {
    if (error.code === 'enrollment_rate_limited') res.setHeader('retry-after', '900')
    res.status(error.status).json({ code: error.code, error: error.message }); return
  }
  if (error instanceof LoginProtectionError) {
    if (error.retryAfterSeconds) res.setHeader('retry-after', String(error.retryAfterSeconds))
    res.status(error.code === 'rate_limited' ? 429 : 503).json({ code: error.code, error: error.message }); return
  }
  const failure = readRuntimeError(error)
  res.status(failure.status).json(failure.body)
}
