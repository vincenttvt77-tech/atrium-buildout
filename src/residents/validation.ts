import type { ResidentDetails, ResidentSource, ResidentContext, ResidentRecord } from './model.ts'

export const residentSourceMaximumAgeMs = 90 * 24 * 60 * 60 * 1000
const invalid = (): never => { throw new Error('resident_invalid_input') }
export const recordId = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
export function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return invalid()
  return value as Record<string, unknown>
}
export function boundedText(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return invalid()
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (text.length < min || text.length > max) return invalid()
  return text
}
export function isoTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return invalid()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return invalid()
  return value
}
function calendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return invalid()
  isoTimestamp(`${value}T00:00:00.000Z`)
  return value
}
export function contactPhone(value: unknown): string | null {
  if (value === null) return null
  const text = boundedText(value, 6, 32)
  if (!/^\+?[0-9][0-9 ()-]{5,30}$/.test(text)) return invalid()
  return text
}
export function contactEmail(value: unknown): string | null {
  if (value === null) return null
  const text = boundedText(value, 3, 254)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return invalid()
  return text
}
export function parseResidentSource(input: unknown): ResidentSource {
  const value = exactObject(input, ['kind', 'reference', 'version', 'observedAt', 'validUntil'])
  if (value.kind !== 'staff_review') return invalid()
  const observedAt = isoTimestamp(value.observedAt), validUntil = isoTimestamp(value.validUntil)
  const duration = Date.parse(validUntil) - Date.parse(observedAt)
  if (duration <= 0 || duration > residentSourceMaximumAgeMs) return invalid()
  return { kind: 'staff_review', reference: boundedText(value.reference, 3, 240),
    version: boundedText(value.version, 1, 80), observedAt, validUntil }
}
function common(value: Record<string, unknown>): Omit<ResidentDetails, 'unitId'> {
  if (value.relationship !== 'leaseholder' && value.relationship !== 'occupant') return invalid()
  const startsOn = calendarDate(value.startsOn), endsOn = value.endsOn === null ? null : calendarDate(value.endsOn)
  if (endsOn !== null && endsOn <= startsOn) return invalid()
  return { displayName: boundedText(value.displayName, 1, 120), relationship: value.relationship,
    startsOn, endsOn, phone: contactPhone(value.phone), email: contactEmail(value.email), source: parseResidentSource(value.source) }
}
const detailKeys = ['displayName', 'relationship', 'startsOn', 'endsOn', 'phone', 'email', 'source']
export function parseResidentDetails(input: unknown): ResidentDetails {
  const value = exactObject(input, ['unitId', ...detailKeys])
  if (!recordId(value.unitId)) return invalid()
  return { unitId: value.unitId, ...common(value) }
}
export function parseResidentReviewDetails(input: unknown): Omit<ResidentDetails, 'unitId'> {
  return common(exactObject(input, detailKeys))
}

/** This projection is for authorized staff, never proof presented by a caller. */
export function residentContext(record: ResidentRecord | null): ResidentContext {
  return { state: record?.contextState ?? 'not_established', residentId: record?.id ?? null,
    residentVersion: record?.version ?? null, displayName: record?.displayName ?? null,
    unitId: record?.unitId ?? null, callerIdentityVerified: false, entryAuthorized: false }
}
