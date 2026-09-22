import { createHash } from 'node:crypto'
import type { DocumentStore } from '../store/documents.ts'
import type { InventorySnapshot } from '../inventory/types.ts'
import { slotDate } from '../calendar/slots.ts'
import { normalisePhone } from './profile.ts'
import { profileKey } from './consolidate.ts'

const PREFIX = 'unit-feedback:'
export const FEEDBACK_CATEGORIES = ['price', 'layout', 'light', 'noise', 'condition', 'amenities', 'other'] as const
export const FEEDBACK_SENTIMENTS = ['positive', 'neutral', 'negative'] as const
export interface FeedbackActor { id: string; label: string }
export interface UnitFeedback {
  id: string
  unitId: string
  sentiment: typeof FEEDBACK_SENTIMENTS[number]
  category: typeof FEEDBACK_CATEGORIES[number]
  note: string
  leadPhone: string | null
  observedDate: string
  createdAt: string
  updatedAt: string
  createdBy: FeedbackActor
  updatedBy: FeedbackActor
  revision: number
}
interface FeedbackInput {
  unitId: string; sentiment: UnitFeedback['sentiment']; category: UnitFeedback['category']
  note: string; leadPhone: string | null; observedDate: string
}
interface StoredFeedback {
  version: 1
  scopeKey: string
  record: UnitFeedback
  creation: { keyHash: string; inputJson: string }
  lastEdit: { keyHash: string; inputJson: string; expectedRevision: number } | null
}
/** The API supplies current server authority and published units; none come from the body. */
export interface FeedbackContext {
  scopeKey: string
  actor: FeedbackActor
  inventory: InventorySnapshot
  timeZone: string
  now: Date
}
export class UnitFeedbackError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
const invalid = (message: string): never => { throw new UnitFeedbackError(400, 'unit_feedback_invalid', message) }
const conflict = (): never => { throw new UnitFeedbackError(409, 'unit_feedback_conflict', 'This feedback changed or the retry key was reused. Reload it before saving again.') }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const goodText = (value: unknown, max: number): value is string => typeof value === 'string' && [...value].length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('A feedback object is required.')
  return value as Record<string, unknown>
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) return invalid('A unique retry key is required.')
  return value
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01'
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) return invalid('Use a valid observed date (YYYY-MM-DD).')
  return value
}
function input(value: Record<string, unknown>, unitId: unknown): FeedbackInput {
  if (!goodText(unitId, 256) || !unitId.trim() || unitId !== unitId.trim()) return invalid('Choose a unit.')
  if (!FEEDBACK_SENTIMENTS.includes(value.sentiment as UnitFeedback['sentiment'])) return invalid('Choose positive, neutral or negative sentiment.')
  if (!FEEDBACK_CATEGORIES.includes(value.category as UnitFeedback['category'])) return invalid('Choose a feedback category.')
  const note = value.note ?? ''
  if (!goodText(note, 1000)) return invalid('Feedback notes must be at most 1,000 characters without invalid control characters.')
  let leadPhone: string | null = null
  if (value.leadPhone != null && value.leadPhone !== '') {
    if (typeof value.leadPhone !== 'string' || value.leadPhone.length > 64 || !/^[+\d ().-]+$/.test(value.leadPhone)) return invalid('Choose an existing prospect.')
    leadPhone = normalisePhone(value.leadPhone)
    if (!/^\+[1-9]\d{7,14}$/.test(leadPhone)) return invalid('Choose an existing prospect.')
  }
  return { unitId, sentiment: value.sentiment as UnitFeedback['sentiment'], category: value.category as UnitFeedback['category'],
    note: note.trim(), leadPhone, observedDate: date(value.observedDate) }
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('The feedback contains unsupported fields.')
}
function validateContext(context: FeedbackContext) {
  if (!goodText(context.scopeKey, 600) || !context.scopeKey || !goodText(context.actor.id, 256) || !context.actor.id
    || !goodText(context.actor.label, 200) || !context.actor.label || !Number.isFinite(context.now.getTime())) throw new Error('Invalid feedback authority')
}
async function references(store: DocumentStore, value: FeedbackInput, context: FeedbackContext, requireCurrentUnit = true) {
  if (requireCurrentUnit && !context.inventory.units.some(unit => unit.unitId === value.unitId)) {
    throw new UnitFeedbackError(404, 'unit_feedback_unit_missing', 'That unit is not in this property’s current inventory.')
  }
  if (value.observedDate > slotDate(context.now, context.timeZone)) invalid('The observed date cannot be in the future for this property.')
  if (value.leadPhone && !await store.get(profileKey(value.leadPhone))) {
    throw new UnitFeedbackError(404, 'unit_feedback_lead_missing', 'That prospect is not in this property’s CRM.')
  }
}
function checked(value: StoredFeedback, scopeKey: string, id: string): StoredFeedback {
  try {
    const r = value.record
    if (value.version !== 1 || value.scopeKey !== scopeKey || !r || r.id !== id || !/^uf-[a-f0-9]{64}$/.test(id)
      || !Number.isSafeInteger(r.revision) || r.revision < 1 || !Number.isFinite(Date.parse(r.createdAt))
      || !Number.isFinite(Date.parse(r.updatedAt)) || !value.creation || !/^[a-f0-9]{64}$/.test(value.creation.keyHash)
      || typeof value.creation.inputJson !== 'string') throw new Error()
    for (const actor of [r.createdBy, r.updatedBy]) if (!actor || !goodText(actor.id, 256) || !actor.id || !goodText(actor.label, 200) || !actor.label) throw new Error()
    const normalized = input(r as unknown as Record<string, unknown>, r.unitId)
    for (const key of Object.keys(normalized) as (keyof FeedbackInput)[]) if (normalized[key] !== r[key]) throw new Error()
    return value
  } catch { throw new Error('Stored unit feedback is invalid') }
}
const editableKeys = ['sentiment', 'category', 'note', 'leadPhone', 'observedDate']

/** One CAS envelope owns both the record and retry evidence in every adapter. */
export async function addUnitFeedback(store: DocumentStore, raw: unknown, context: FeedbackContext): Promise<UnitFeedback> {
  validateContext(context)
  const body = object(raw)
  keys(body, ['idempotencyKey', 'unitId', ...editableKeys])
  const retryKey = token(body.idempotencyKey)
  const value = input(body, body.unitId)
  const keyHash = digest([context.actor.id, retryKey])
  const id = `uf-${digest([context.scopeKey, context.actor.id, retryKey])}`
  const inputJson = JSON.stringify(value)
  // An exact creation retry returns the current record even after ordinary staff edits.
  const prior = await store.get<StoredFeedback>(PREFIX + id)
  if (prior) {
    const existing = checked(prior, context.scopeKey, id)
    if (existing.creation.keyHash !== keyHash || existing.creation.inputJson !== inputJson) conflict()
    return existing.record
  }
  await references(store, value, context)
  const at = context.now.toISOString()
  const initial: StoredFeedback = { version: 1, scopeKey: context.scopeKey,
    record: { ...value, id, createdAt: at, updatedAt: at, createdBy: { ...context.actor }, updatedBy: { ...context.actor }, revision: 1 },
    creation: { keyHash, inputJson }, lastEdit: null }
  const saved = await store.update(PREFIX + id, initial, current => {
    const existing = checked(current, context.scopeKey, id)
    if (existing.creation.keyHash !== keyHash || existing.creation.inputJson !== inputJson) conflict()
    return existing
  })
  return saved.record
}

/** Keep unit ownership immutable; a revision conflict never overwrites another edit. */
export async function editUnitFeedback(store: DocumentStore, raw: unknown, context: FeedbackContext): Promise<UnitFeedback> {
  validateContext(context)
  const body = object(raw)
  keys(body, ['id', 'expectedRevision', 'idempotencyKey', ...editableKeys])
  if (typeof body.id !== 'string' || !/^uf-[a-f0-9]{64}$/.test(body.id)) invalid('Choose an existing feedback record.')
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1 || Number(body.expectedRevision) >= Number.MAX_SAFE_INTEGER) invalid('A current feedback revision is required.')
  const id = body.id as string, expectedRevision = body.expectedRevision as number
  const keyHash = digest([context.actor.id, token(body.idempotencyKey)])
  const existing = await store.get<StoredFeedback>(PREFIX + id)
  if (!existing) throw new UnitFeedbackError(404, 'unit_feedback_missing', 'That feedback is not in this property.')
  const prior = checked(existing, context.scopeKey, id)
  const value = input(body, prior.record.unitId), inputJson = JSON.stringify(value)
  // Unit ownership is fixed by this scoped stored record. A catalogue removal must
  // not prevent staff from correcting historical feedback about that same apartment.
  await references(store, value, context, false)
  const saved = await store.update(PREFIX + id, prior, current => {
    const latest = checked(current, context.scopeKey, id)
    if (latest.lastEdit?.keyHash === keyHash) {
      if (latest.lastEdit.inputJson !== inputJson || latest.lastEdit.expectedRevision !== expectedRevision) conflict()
      return latest
    }
    if (latest.record.revision !== expectedRevision) conflict()
    return { ...latest, record: { ...latest.record, ...value, updatedAt: context.now.toISOString(),
      updatedBy: { ...context.actor }, revision: expectedRevision + 1 }, lastEdit: { keyHash, inputJson, expectedRevision } }
  })
  return saved.record
}

export async function listUnitFeedback(store: DocumentStore, scopeKey: string): Promise<{ unitFeedback: UnitFeedback[]; unitFeedbackTruncated: boolean }> {
  const records: UnitFeedback[] = []
  for (const key of await store.list(PREFIX)) {
    const value = await store.get<StoredFeedback>(key)
    if (!value) throw new Error('Stored unit feedback is missing')
    records.push(checked(value, scopeKey, key.slice(PREFIX.length)).record)
  }
  records.sort((a, b) => b.observedDate.localeCompare(a.observedDate) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  return { unitFeedback: records.slice(0, 500), unitFeedbackTruncated: records.length > 500 }
}

/** Descriptors are a read-only inventory projection, not a second inventory authority. */
export function feedbackInventory(snapshot: InventorySnapshot) {
  const plans = new Map(snapshot.floorPlans.map(plan => [plan.id, plan.name]))
  return {
    feedbackUnits: snapshot.units.map(unit => ({ unitId: unit.unitId, floorPlanId: unit.floorPlanId,
      floorPlanName: plans.get(unit.floorPlanId) ?? unit.floorPlanId, bedrooms: unit.bedrooms, bathrooms: unit.bathrooms,
      sqft: unit.sqft, floor: unit.floor, monthlyRent: unit.monthlyRent, status: unit.status })),
    feedbackInventory: { sourceMode: snapshot.provenance?.sourceMode ?? 'live', readAt: snapshot.readAt.toISOString(),
      source: snapshot.source, fictional: snapshot.provenance?.sourceMode === 'demo' },
  }
}
