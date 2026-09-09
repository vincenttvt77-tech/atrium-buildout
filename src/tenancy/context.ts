import { AsyncLocalStorage } from 'node:async_hooks'
import { isHostedRuntime } from '../store/config.ts'

/** Request-local scope. Only authenticated handlers and trusted webhook routing set it. */
const tenantContext = new AsyncLocalStorage<string>()
export const LEGACY_TENANT = 'legacy'

export function validateTenantId(id: string): string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid tenant identity')
  return id
}

export function currentTenantId(): string {
  const tenant = tenantContext.getStore()
  if (tenant) return tenant
  if (isHostedRuntime()) throw new Error('An explicit tenant scope is required in a deployed runtime')
  return LEGACY_TENANT
}

export function withTenant<T>(tenantId: string, fn: () => T): T {
  return tenantContext.run(validateTenantId(tenantId), fn)
}

/** Preserve existing single-property records; named accounts always receive a new namespace. */
export function tenantNamespace(tenantId = currentTenantId()): string {
  validateTenantId(tenantId)
  return tenantId === LEGACY_TENANT ? 'atrium' : `atrium:tenant:${tenantId}`
}
