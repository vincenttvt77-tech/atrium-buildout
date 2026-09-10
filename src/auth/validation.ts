import { validateTimeZone } from '../calendar/time.ts'
import { AuthorizationError } from './model.ts'
import type { Organization, Property, User, Membership, PropertyGrant, ChannelBinding, Role, Permission } from './model.ts'

export const PERMISSIONS: readonly Permission[] = Object.freeze(['read', 'operate', 'configure', 'manage_members', 'manage_organization'])
const ROLES: readonly Role[] = ['owner', 'admin', 'staff', 'viewer']
export const normalizeUsername = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized) ? normalized : null
}
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
export const validVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const name = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const status = (value: unknown) => value === 'active' || value === 'inactive'
const accessStatus = (value: unknown) => value === 'active' || value === 'revoked'
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const requireValid = (valid: boolean): void => { if (!valid) throw new AuthorizationError('invalid_record') }
export function validateOrganization(value: Organization): Organization {
  requireValid(record(value) && validId(value.id) && name(value.name) && status(value.status) && validVersion(value.permissionVersion))
  return { ...value }
}
export function validateProperty(value: Property): Property {
  requireValid(record(value) && validId(value.id) && validId(value.organizationId) && name(value.name) && status(value.status) && validVersion(value.permissionVersion))
  try { return { ...value, timeZone: validateTimeZone(value.timeZone) } }
  catch { throw new AuthorizationError('invalid_record') }
}
export function validateUser(value: User): User {
  requireValid(record(value) && validId(value.id) && typeof value.username === 'string' && normalizeUsername(value.username) === value.username
    && name(value.displayName) && status(value.status) && validVersion(value.credentialVersion))
  return { ...value }
}
export function validateMembership(value: Membership): Membership {
  requireValid(record(value) && validId(value.id) && validId(value.userId) && validId(value.organizationId)
    && ROLES.includes(value.role) && accessStatus(value.status) && (value.access === 'organization' || value.access === 'properties')
    && validVersion(value.permissionVersion))
  return { ...value }
}
export function validatePropertyGrant(value: PropertyGrant): PropertyGrant {
  requireValid(record(value) && validId(value.membershipId) && validId(value.organizationId) && validId(value.propertyId)
    && accessStatus(value.status) && validVersion(value.permissionVersion))
  return { ...value }
}
export function validateChannelBinding(value: ChannelBinding): ChannelBinding {
  requireValid(record(value) && validId(value.id) && validId(value.organizationId) && validId(value.propertyId)
    && typeof value.provider === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value.provider)
    && typeof value.externalId === 'string' && value.externalId.length > 0 && value.externalId.length <= 256 && !/[\u0000-\u0020\u007f]/.test(value.externalId)
    && status(value.status) && validVersion(value.permissionVersion) && Array.isArray(value.capabilities)
    && value.capabilities.length > 0 && value.capabilities.every(permission => PERMISSIONS.includes(permission))
    && new Set(value.capabilities).size === value.capabilities.length)
  return { ...value, capabilities: [...value.capabilities] }
}
export function rolePermissions(role: Role): readonly Permission[] {
  switch (role) {
    case 'owner': return PERMISSIONS
    case 'admin': return Object.freeze(['read', 'operate', 'configure', 'manage_members'])
    case 'staff': return Object.freeze(['read', 'operate'])
    case 'viewer': return Object.freeze(['read'])
    default: throw new AuthorizationError('invalid_record')
  }
}
export function requirePermission(permissions: readonly Permission[], permission: Permission): void {
  if (!PERMISSIONS.includes(permission) || !permissions.includes(permission)) throw new AuthorizationError('forbidden')
}
