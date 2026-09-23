import type { PropertySnapshot } from '../properties/model.ts'
import { hashJson } from '../workflows/validation.ts'

export const CALLBACK_CHANNEL = 'website-callback'
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)
export const channelId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v)
export const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
export class CallbackError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) { super(message); this.code = code; this.status = status }
}
export interface CallbackBinding {
  enabled: true; organizationId: string; propertyId: string; channelId: string; origin: string
  providerOrgId: string; assistantId: string; assistantVersion: string; phoneNumberId: string
  reviewedAt: string; reviewExpiresAt: string; dailyLimit: number
  /** Local property wall-clock minutes; no overnight intervals. Use two days for those. */
  hours: { day: number; start: number; end: number }[]
}
export const callbackUnavailable = (): never => { throw new CallbackError('callback_unavailable', 'Online callbacks are unavailable. Please use the building’s published contact number.', 503) }
export function callbackBinding(snapshot: PropertySnapshot, now: Date): CallbackBinding {
  const raw = snapshot.property.websiteCallback
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return callbackUnavailable()
  const v = raw as CallbackBinding
  if (Object.keys(v).sort().join(',') !== 'assistantId,assistantVersion,channelId,dailyLimit,enabled,hours,organizationId,origin,phoneNumberId,propertyId,providerOrgId,reviewExpiresAt,reviewedAt'
    || v.enabled !== true || v.organizationId !== snapshot.organizationId || v.propertyId !== snapshot.propertyId
    || !channelId(v.channelId) || !uuid(v.providerOrgId) || !uuid(v.assistantId) || !uuid(v.phoneNumberId)
    || typeof v.assistantVersion !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(v.assistantVersion)
    || !Number.isSafeInteger(v.dailyLimit) || v.dailyLimit < 1 || v.dailyLimit > 50) return callbackUnavailable()
  try {
    const origin = new URL(v.origin)
    if (origin.origin !== v.origin || origin.protocol !== 'https:' || origin.port || !origin.hostname.includes('.')
      || /[^a-z0-9.-]/.test(origin.hostname) || /\.(local|internal|localhost)$/.test(origin.hostname)
      || /^[\d.]+$/.test(origin.hostname)) return callbackUnavailable()
  } catch { return callbackUnavailable() }
  const reviewed = Date.parse(v.reviewedAt), expires = Date.parse(v.reviewExpiresAt), current = now.getTime()
  if (![reviewed, expires, current].every(Number.isFinite) || reviewed > Date.parse(snapshot.publishedAt)
    || reviewed > current || expires <= current || expires - reviewed > 30 * 86400000) return callbackUnavailable()
  if (!Array.isArray(v.hours) || !v.hours.length || v.hours.length > 14) return callbackUnavailable()
  for (const slot of v.hours) {
    if (!slot || Object.keys(slot).sort().join(',') !== 'day,end,start' || !Number.isInteger(slot.day) || slot.day < 0 || slot.day > 6
      || !Number.isInteger(slot.start) || !Number.isInteger(slot.end) || slot.start < 0 || slot.end > 1440 || slot.start >= slot.end) return callbackUnavailable()
  }
  if (typeof snapshot.property.buildingName !== 'string' || !snapshot.property.buildingName.trim() || snapshot.property.buildingName.length > 100
    || /[\u0000-\u001f{}<>]/.test(snapshot.property.buildingName)) return callbackUnavailable()
  return v
}
export function callbackOpen(binding: CallbackBinding, timeZone: string, now: Date): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
    const part = (key: string) => parts.find(p => p.type === key)?.value ?? ''
    const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(part('weekday')), minute = Number(part('hour')) * 60 + Number(part('minute'))
    return binding.hours.some(slot => slot.day === day && slot.start <= minute && minute < slot.end)
  } catch { return false }
}
export const callbackConsent = (name: string) => `I request one immediate call from ${name}’s AI leasing assistant at the number I provide. This is my number and I agree to this call being recorded. This does not sign me up for marketing calls.`
export const callbackGreeting = (name: string) => `Hi, this is the AI leasing assistant for ${name}, returning the call you requested on the website. This call is recorded. Is now a good time to talk about an apartment?`
export function callbackPolicy(snapshot: PropertySnapshot, binding: CallbackBinding) {
  const consent = callbackConsent(String(snapshot.property.buildingName))
  return { consent, policySha256: hashJson({ binding, configurationVersion: snapshot.version, timeZone: snapshot.timeZone, consent }) }
}

/** Conservative upper bound: never schedule a requested callback beyond the next
 * closed interval, including DST changes. At most120 bounded local-time checks. */
export function callbackDeadline(binding: CallbackBinding, timeZone: string, now: Date): string {
  let end = now.getTime() + 120000
  for (let elapsed = 0; elapsed <= 120000; elapsed += 1000) {
    if (!callbackOpen(binding, timeZone, new Date(now.getTime() + elapsed))) { end = now.getTime() + Math.max(0, elapsed - 1000); break }
  }
  return new Date(end).toISOString()
}
