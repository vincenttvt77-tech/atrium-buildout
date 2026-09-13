import { normalizeUsername, validVersion } from '../auth/validation.ts'
import { validSessionId } from '../auth/session.ts'
import { boundedText, exactObject, isoTimestamp } from './validation.ts'
import { EnrollmentError } from './enrollment-model.ts'
import type { EnrollmentPolicyDetails, EnrollmentStaffCommand } from './enrollment-model.ts'

export const enrollmentPolicyMaximumAgeMs = 90 * 24 * 60 * 60 * 1000
export const enrollmentCheckMaximumAgeMs = 24 * 60 * 60 * 1000
const invalid = (): never => { throw new EnrollmentError('enrollment_invalid_input') }
const version = (value: unknown): number => validVersion(value) ? value : invalid()
export const enrollmentId = (value: unknown): string => validSessionId(value) ? value : invalid()
export const enrollmentDigest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : invalid()
export function parseEnrollmentPolicy(value: unknown): EnrollmentPolicyDetails {
  try {
    const row = exactObject(value, ['enabled','method','protocol','invitationLifetimeMinutes','sourceReference','observedAt','validUntil'])
    if (typeof row.enabled !== 'boolean' || row.method !== 'in_person_staff_check'
      || !Number.isInteger(row.invitationLifetimeMinutes) || Number(row.invitationLifetimeMinutes) < 15 || Number(row.invitationLifetimeMinutes) > 1440) return invalid()
    const observedAt = isoTimestamp(row.observedAt), validUntil = isoTimestamp(row.validUntil)
    if (Date.parse(validUntil) <= Date.parse(observedAt) || Date.parse(validUntil) - Date.parse(observedAt) > enrollmentPolicyMaximumAgeMs) invalid()
    return { enabled: row.enabled, method: 'in_person_staff_check', protocol: boundedText(row.protocol, 20, 2000),
      invitationLifetimeMinutes: Number(row.invitationLifetimeMinutes), sourceReference: boundedText(row.sourceReference, 3, 240), observedAt, validUntil }
  } catch { return invalid() }
}
export function parseEnrollmentStaffCommand(value: unknown): EnrollmentStaffCommand {
  try {
    const action = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).action : null
    if (action === 'publish_policy') {
      const row = exactObject(value, ['action','requestId','expectedVersion','details','reason'])
      return { action, requestId: enrollmentId(row.requestId), expectedVersion: row.expectedVersion === null ? null : version(row.expectedVersion),
        details: parseEnrollmentPolicy(row.details), reason: boundedText(row.reason, 3, 1000) }
    }
    if (action === 'issue_invitation') {
      const row = exactObject(value, ['action','requestId','residentId','expectedResidentVersion','expectedPolicyVersion','replaces','checkedAt','evidenceReference','protocolCompleted','reason'])
      if (row.protocolCompleted !== true) invalid()
      const replaces = row.replaces === null ? null : exactObject(row.replaces, ['id','version'])
      return { action, requestId: enrollmentId(row.requestId), residentId: enrollmentId(row.residentId),
        expectedResidentVersion: version(row.expectedResidentVersion), expectedPolicyVersion: version(row.expectedPolicyVersion),
        replaces: replaces === null ? null : { id: enrollmentId(replaces.id), version: version(replaces.version) },
        checkedAt: isoTimestamp(row.checkedAt), evidenceReference: boundedText(row.evidenceReference, 3, 240), protocolCompleted: true,
        reason: boundedText(row.reason, 3, 1000) }
    }
    if (action === 'revoke_invitation' || action === 'revoke_binding') {
      const row = exactObject(value, ['action','requestId','id','expectedVersion','reason'])
      return { action, requestId: enrollmentId(row.requestId), id: enrollmentId(row.id), expectedVersion: version(row.expectedVersion), reason: boundedText(row.reason, 3, 1000) }
    }
    return invalid()
  } catch { return invalid() }
}
export function enrollmentUsername(value: unknown): string {
  const username = normalizeUsername(value)
  if (!username) return invalid()
  return username
}
export function enrollmentDisplayName(value: unknown): string {
  try { return boundedText(value, 1, 120) } catch { return invalid() }
}
export function validateResidentPassword(value: unknown, isNew: boolean): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\ud800-\udfff]/u.test(value)
    || (isNew && [...value].length < 15)) return invalid()
  return value
}
export function supportedResidentHash(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = /^scrypt\$65536\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(value)
  return !!parts && Buffer.from(parts[1]!, 'base64url').toString('base64url') === parts[1]
    && Buffer.from(parts[2]!, 'base64url').toString('base64url') === parts[2]
}
