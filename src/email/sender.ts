import type { PropertySnapshot } from '../properties/model.ts'
import { validEmailAddress, validEmailMessage } from './render.ts'
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value)
export interface PropertyEmailBinding { from: string; replyTo: string; reviewExpiresAt: string }
/** Published property configuration attests the sending identity; provider still enforces domain access. */
export function propertyEmailBinding(snapshot: PropertySnapshot, now: Date, purpose: 'tourConfirmationEmail' | 'voiceShortlistEmail'): PropertyEmailBinding | null {
  const raw = snapshot.property[purpose]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'from,organizationId,propertyId,provider,replyTo,reviewExpiresAt'
    || v.provider !== 'resend' || v.organizationId !== snapshot.organizationId || v.propertyId !== snapshot.propertyId
    || !validEmailAddress(v.replyTo) || !text(v.reviewExpiresAt) || !Number.isFinite(Date.parse(v.reviewExpiresAt))
    || Date.parse(v.reviewExpiresAt) <= now.getTime() || Date.parse(v.reviewExpiresAt) - now.getTime() > 30 * 86400000
    || !validEmailMessage({ to: 'check@example.test', from: v.from, replyTo: v.replyTo, subject: 'Check', html: '<p>Check</p>' })) return null
  return { from: v.from as string, replyTo: v.replyTo, reviewExpiresAt: v.reviewExpiresAt }
}
