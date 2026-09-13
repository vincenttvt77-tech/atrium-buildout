import { readAccountsConfig } from '../ops/accounts.ts'
import { LEGACY_TENANT } from './context.ts'

/** Extract routing only after the transport has verified the webhook credential. */
export function webhookAssistantId(body: unknown): string | null {
  const payload = body && typeof body === 'object' ? body as Record<string, any> : {}
  const nested = payload.message?.call?.assistantId
  const outer = payload.call?.assistantId
  if (nested !== undefined && outer !== undefined && nested !== outer) return null
  const id = nested ?? outer
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u0020\u007f]/.test(id) ? id : null
}

/** Routing identity comes from the verified Vapi call, never a browser tenant parameter. */
export function webhookTenant(body: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  const config = readAccountsConfig(env)
  if (config.mode === 'legacy') return LEGACY_TENANT
  if (config.mode === 'invalid') return null
  const payload = body && typeof body === 'object' ? body as Record<string, any> : {}
  const call = payload.message?.call ?? payload.call
  const assistantId = call?.assistantId
  if (typeof assistantId !== 'string' || !assistantId) return null
  const tenants = new Set(config.accounts.filter((a) => a.assistantIds.includes(assistantId)).map((a) => a.tenantId))
  return tenants.size === 1 ? [...tenants][0]! : null
}
