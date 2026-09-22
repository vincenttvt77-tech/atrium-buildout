import { isIP } from 'node:net'
import { PropertyConfigurationError } from './model.ts'

/** Publisher attestation of a compatible public property website, not a DNS ownership proof. */
export interface PublicShortlistWebsite {
  readonly format: 'atrium-shortlist-v1'
  readonly organizationId: string
  readonly propertyId: string
  readonly inventorySource: string
  readonly baseUrl: string
  readonly reviewedAt: string
  readonly reviewExpiresAt: string
}
export interface WebsiteScope { organizationId: string; propertyId: string; inventorySource: string }
const fields = ['format', 'organizationId', 'propertyId', 'inventorySource', 'baseUrl', 'reviewedAt', 'reviewExpiresAt']
const invalid = (): never => { throw new PropertyConfigurationError('property_configuration_invalid', 'bundle.property.publicShortlistWebsite') }
const instant = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? time : NaN
}

export function validatePublicShortlistWebsite(value: unknown, scope: WebsiteScope, publishedAt: string): PublicShortlistWebsite | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const data = value as Record<string, unknown>
  if (Object.keys(data).length !== fields.length || fields.some(key => !Object.hasOwn(data, key))) return invalid()
  if (data.format !== 'atrium-shortlist-v1' || data.organizationId !== scope.organizationId
    || data.propertyId !== scope.propertyId || data.inventorySource !== scope.inventorySource) return invalid()
  if (typeof data.baseUrl !== 'string' || data.baseUrl.length > 512 || /[\s\\?#]/.test(data.baseUrl)) return invalid()
  let url: URL
  try { url = new URL(data.baseUrl) } catch { return invalid() }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
    || url.href !== data.baseUrl || !/^[A-Za-z0-9/_.-]*$/.test(url.pathname)
    || !url.hostname.includes('.') || url.hostname.endsWith('.') || isIP(url.hostname.replace(/^\[|\]$/g, ''))
    || /\.(?:localhost|local|internal)$/.test(url.hostname)) return invalid()
  const reviewed = instant(data.reviewedAt), expires = instant(data.reviewExpiresAt), published = instant(publishedAt)
  if (![reviewed, expires, published].every(Number.isFinite) || reviewed > published || expires <= reviewed
    || expires - reviewed > 30 * 86400000) return invalid()
  return Object.freeze({ ...data }) as unknown as PublicShortlistWebsite
}

/** No network access. Expired or mismatched configuration cannot prepare a link. */
export function publicShortlistLink(website: PublicShortlistWebsite | undefined, scope: WebsiteScope, unitIds: string[], now: Date): string | null {
  if (!website || !Number.isFinite(now.getTime())) return null
  try { validatePublicShortlistWebsite(website, scope, now.toISOString()) } catch { return null }
  if (now.getTime() >= instant(website.reviewExpiresAt) || !unitIds.length || unitIds.length > 5
    || unitIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(id))
    || new Set(unitIds.map(id => id.toUpperCase())).size !== unitIds.length) return null
  const url = new URL(website.baseUrl)
  url.hash = '#availability?units=' + encodeURIComponent(unitIds.map(id => id.toUpperCase()).join(','))
  return url.href
}
