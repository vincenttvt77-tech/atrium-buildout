/**
 * Checks the property data against the contracts the agent enforces at runtime.
 *
 * The point is to catch a knowledge article that quotes a rent, or one filed under a
 * restricted topic, BEFORE it reaches a caller. A stale rent in the knowledge base defeats
 * the entire live-inventory discipline, and it is invisible until someone is quoted it.
 */
import { readFile } from 'node:fs/promises'

const VOLATILE = new Set(['unit_availability', 'pricing', 'tour_slot_availability',
  'application_status', 'account_status', 'work_order_status'])
const RESTRICTED = new Set(['fair_housing', 'reasonable_accommodation', 'eligibility_or_denial',
  'legal_question', 'dispute', 'money_movement', 'protected_class_inquiry'])
const POLICY = new Set(['pet_policy', 'parking', 'amenities', 'hours', 'utilities',
  'application_requirements', 'building_access', 'move_logistics', 'general_property_fact'])

const PHONE = '+1 (516) 990-9252'
const NOW = new Date('2026-09-07T12:00:00Z')

const problems = []
const fail = (where, msg) => problems.push({ severity: 'error', where, msg })
const warn = (where, msg) => problems.push({ severity: 'warn', where, msg })

const read = async (f) => { try { return JSON.parse(await readFile(`data/${f}`, 'utf8')) } catch { return null } }

const property = await read('property.json')
const plans = await read('floorplans.json')
const units = await read('inventory.json')
const articles = await read('knowledge.json')

if (!property) fail('property.json', 'missing')
else if (property.leasingPhone !== PHONE) fail('property.json', `leasingPhone is "${property.leasingPhone}", must be "${PHONE}"`)

// ---- floor plans and units must agree
const planById = new Map((plans ?? []).map((p) => [p.id, p]))
if (!plans?.length) fail('floorplans.json', 'no floor plans')
if (!units?.length) fail('inventory.json', 'no units')

for (const u of units ?? []) {
  const w = `inventory.json ${u.unitId}`
  const p = planById.get(u.floorPlanId)
  if (!p) { fail(w, `floorPlanId "${u.floorPlanId}" does not exist`); continue }
  if (u.bedrooms !== undefined && u.bedrooms !== p.bedrooms)
    fail(w, `bedrooms ${u.bedrooms} != plan ${p.id} (${p.bedrooms})`)
  if (u.bathrooms !== undefined && u.bathrooms !== p.bathrooms)
    fail(w, `bathrooms ${u.bathrooms} != plan ${p.id} (${p.bathrooms})`)
  if (!(u.monthlyRent > 0)) fail(w, 'monthlyRent must be positive')
  if (Number.isNaN(Date.parse(u.availableFrom ?? ''))) fail(w, `availableFrom "${u.availableFrom}" unparseable`)
  if (property?.floors && u.floor > property.floors)
    fail(w, `floor ${u.floor} above the building's ${property.floors}`)
}

const available = (units ?? []).filter((u) => u.status === 'available')
if (available.length === 0) fail('inventory.json', 'nothing is available — the agent can never quote')

// ---- knowledge base
const RENT = /\$\s?\d{1,2},?\d{3}\b|\b\d{1,2},\d{3}\s?(?:a month|per month|\/month|monthly)/i
const seen = new Set()

for (const a of articles ?? []) {
  const w = `knowledge.json ${a.id ?? '(no id)'}`
  if (seen.has(a.id)) fail(w, 'duplicate article id')
  seen.add(a.id)

  if (VOLATILE.has(a.topic)) fail(w, `topic "${a.topic}" is volatile — must come from live inventory, never the KB`)
  else if (RESTRICTED.has(a.topic)) fail(w, `topic "${a.topic}" is restricted — must escalate, never be answered`)
  else if (!POLICY.has(a.topic)) fail(w, `topic "${a.topic}" is not a valid PolicyTopic`)

  if (a.status !== 'published') warn(w, `status "${a.status}" — will not be served`)
  if (!a.approvedBy) fail(w, 'approvedBy is null — an AI answer cannot become approved policy')
  if (Number.isNaN(Date.parse(a.reviewBy ?? ''))) fail(w, 'reviewBy unparseable')
  else if (new Date(a.reviewBy) <= NOW) fail(w, `reviewBy ${a.reviewBy} is past — will not be served`)
  if (!a.source) warn(w, 'no source cited')

  if (RENT.test(a.answer ?? '')) fail(w, `answer contains a rent figure: "${(a.answer.match(RENT) ?? [])[0]}" — rents come from live inventory only`)

  const q = (a.question ?? '').toLowerCase()
  for (const [pat, why] of [
    [/section 8|voucher|cityfheps|housing choice/, 'housing vouchers'],
    [/emotional support|service animal|accommodat/, 'reasonable accommodation'],
    [/\bdenied\b|\bdenial\b|credit score requirement/, 'eligibility or denial'],
  ]) if (pat.test(q)) fail(w, `question concerns ${why} — must escalate, not be answered by an article`)
}

if ((articles ?? []).length < 10) warn('knowledge.json', `only ${(articles ?? []).length} articles — the agent will refuse a lot`)

// ---- report
const errors = problems.filter((p) => p.severity === 'error')
const warns = problems.filter((p) => p.severity === 'warn')

console.log(`\nfloor plans ${plans?.length ?? 0} · units ${units?.length ?? 0} (${available.length} available) · articles ${articles?.length ?? 0}`)
for (const p of errors) console.log(`  ERROR  ${p.where}: ${p.msg}`)
for (const p of warns) console.log(`  warn   ${p.where}: ${p.msg}`)
console.log(errors.length === 0 ? '\nData valid.' : `\n${errors.length} errors, ${warns.length} warnings.`)
process.exit(errors.length === 0 ? 0 : 1)
