import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AuthenticatedUser } from '../auth/model.ts'
import type { PropertyResponseScope } from '../application/runtime.ts'
import type { ServiceCursor } from './model.ts'
import type { MaintenanceInboxQuery } from './planning-model.ts'
import { MaintenancePlanningError } from './planning-model.ts'
import { validateMaintenanceInboxQuery } from './planning-inbox.ts'

export const planningScanLifetimeMs = 300_000
export interface PlanningScan {
  startedAt: number
  expiresAt: number
  policyVersion: number | null
}
export function expiredPlanningScan(): never {
  throw new MaintenancePlanningError('planning_cursor_expired', 'The planning list changed or expired. Refresh it to check current requests from the top.')
}
function signature(payload: string, principal: AuthenticatedUser, scope: PropertyResponseScope,
  query: Pick<MaintenanceInboxQuery, 'filter' | 'unitId' | 'limit'>, secret: string): string {
  return createHmac('sha256', secret).update('atrium-maintenance-inbox-v1\n').update(JSON.stringify([
    principal.userId, principal.credentialVersion, principal.sessionId,
    scope.organizationId, scope.propertyId, scope.configurationVersion, scope.permissionVersion,
    query.filter, query.unitId ?? null, query.limit, payload,
  ])).digest('base64url')
}
function validScan(scan: PlanningScan, now: number): boolean {
  return Number.isSafeInteger(now) && Number.isSafeInteger(scan.startedAt) && Number.isSafeInteger(scan.expiresAt)
    && scan.startedAt <= now && now < scan.expiresAt && scan.expiresAt > scan.startedAt
    && scan.expiresAt - scan.startedAt <= planningScanLifetimeMs
    && (scan.policyVersion === null || Number.isSafeInteger(scan.policyVersion) && scan.policyVersion > 0)
}
export function mintPlanningInboxCursor(before: ServiceCursor, scan: PlanningScan, principal: AuthenticatedUser,
  scope: PropertyResponseScope, query: Pick<MaintenanceInboxQuery, 'filter' | 'unitId' | 'limit'>, now: Date, secret: string): string {
  if (!principal.sessionId || !validScan(scan, now.getTime())) return expiredPlanningScan()
  validateMaintenanceInboxQuery({ ...query, before })
  const payload = Buffer.from(JSON.stringify([1, scan.startedAt, scan.expiresAt, scan.policyVersion, before.createdAt, before.id])).toString('base64url')
  return payload + '.' + signature(payload, principal, scope, query, secret)
}
/** A signed continuation is scoped navigation only; every page and every later action reauthorizes. */
export function readPlanningInboxCursor(value: unknown, principal: AuthenticatedUser, scope: PropertyResponseScope,
  query: Pick<MaintenanceInboxQuery, 'filter' | 'unitId' | 'limit'>, now: Date, secret: string): PlanningScan & { before: ServiceCursor } {
  if (!principal.sessionId || typeof value !== 'string' || value.length > 800) return expiredPlanningScan()
  const parts = value.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return expiredPlanningScan()
  const [payload, supplied] = parts as [string, string], expected = signature(payload, principal, scope, query, secret)
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return expiredPlanningScan()
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!Array.isArray(decoded) || decoded.length !== 6 || decoded[0] !== 1) return expiredPlanningScan()
    const scan: PlanningScan = { startedAt: decoded[1], expiresAt: decoded[2], policyVersion: decoded[3] }
    if (!validScan(scan, now.getTime())) return expiredPlanningScan()
    const page = validateMaintenanceInboxQuery({ ...query, before: { createdAt: decoded[4], id: decoded[5] } })
    return { ...scan, before: page.before! }
  } catch { return expiredPlanningScan() }
}
