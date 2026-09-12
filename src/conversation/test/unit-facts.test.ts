import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerQuestion, type ToolContext } from '../tools.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'
import type { Topic } from '../../knowledge/topics.ts'
import { emptyQualification } from '../../leasing/qualification.ts'

const now = new Date('2032-06-01T12:00:00Z')
const context = (): ToolContext => ({
  propertyId: propertyId('synthetic-property'), interactionId: interactionId('synthetic-unit-question'),
  inventory: { readAt: now, source: 'synthetic-authoritative-inventory', floorPlans: [],
    units: [{ unitId: '19A', floorPlanId: 'three-bed', floor: 19, bedrooms: 3, bathrooms: 2,
      sqft: 1332, monthlyRent: 7615, availableFrom: '2032-12-01', status: 'available' },
    { unitId: '09F', floorPlanId: 'studio', floor: 9, bedrooms: 0, bathrooms: 1,
      sqft: 496, monthlyRent: 3350, availableFrom: '2032-06-01', status: 'leased' }] },
  articles: [], qualification: emptyQualification(), jurisdiction: 'NY', confidenceThreshold: 0.7, now,
})
const ask = (question: string, ctx = context(), topic: Topic = 'general_property_fact') => answerQuestion({ question, topic }, ctx)

test('the failed-call bedroom question uses the exact apartment record without a knowledge article or quote intake', () => {
  const result = ask('How many bedrooms is Residence 19A?')
  assert.equal(result.say, 'Residence 19A has 3 bedrooms.')
  assert.equal(result.record.kind, 'unit_facts_answered')
  assert.equal(result.record.unitId, '19A')
  assert.equal(result.record.source, 'synthetic-authoritative-inventory')
  assert.equal(result.record.sourceReadAt, now.toISOString())
  assert.doesNotMatch(result.say, /rent|available|7,615|budget|approved answer/i)
})

test('bathroom, size, floor and combined dimensions use unit values, with case-insensitive exact IDs', () => {
  for (const [question, expected] of [
    ['How many bathrooms does apartment 19a have?', '2 bathrooms'],
    ['How big is 19A?', '1,332 square feet'],
    ['Which floor is Unit #19A on?', 'floor 19'],
    ['How many bedrooms and bathrooms in 19A?', '3 bedrooms and 2 bathrooms'],
  ] as const) assert.ok(ask(question).say.includes(expected), question)
})

test('a studio is described correctly, and dimensions do not imply a leased apartment is available', () => {
  const result = ask('How many bedrooms does 09F have?')
  assert.match(result.say, /studio.*no separate bedrooms/i)
  assert.doesNotMatch(result.say, /available|rent|3,350/i)
})

test('unknown or ambiguous apartment references cannot borrow another apartment facts or a general article', () => {
  for (const question of ['How many bedrooms in Unit 119A?', 'How many bedrooms in Unit 99Z?',
    'How many bedrooms in 19A and 09F?', 'How many bedrooms in Unit 99Z and 19A?']) {
    const result = ask(question)
    assert.notEqual(result.record.kind, 'unit_facts_answered', question)
    assert.doesNotMatch(result.say, /3 bedrooms|1,332 square feet/, question)
  }
})

test('dimensions are scoped to the supplied property snapshot, not the bundled Larkin data', () => {
  const other = context()
  other.inventory.units[0] = { ...other.inventory.units[0]!, bedrooms: 1, bathrooms: 1, sqft: 650 }
  assert.equal(ask('How many bedrooms in Residence 19A?', other).say, 'Residence 19A has 1 bedroom.')
  other.inventory.units = []
  assert.notEqual(ask('How many bedrooms in Residence 19A?', other).record.kind, 'unit_facts_answered')
})

test('stale, future-dated and invalid inventory cannot establish apartment facts', () => {
  for (const readAt of [new Date(now.getTime() - 3600000), new Date(now.getTime() + 1), new Date(NaN)]) {
    const ctx = context(); ctx.inventory.readAt = readAt
    const result = ask('How many bedrooms in Residence 19A?', ctx)
    assert.notEqual(result.record.kind, 'unit_facts_answered')
    assert.doesNotMatch(result.say, /3 bedrooms/)
  }
})

test('fictional catalogue facts retain their demo disclosure and original source timestamp', () => {
  const ctx = context()
  ctx.inventory.readAt = new Date('2032-01-01T00:00:00Z')
  ctx.inventory.provenance = { sourceMode: 'demo', fictional: true, catalogAsOf: ctx.inventory.readAt.toISOString(), catalogVersion: 'demo-one' }
  const result = ask('How many bedrooms in Residence 19A?', ctx)
  assert.match(result.say, /fictional demo catalogue/)
  assert.match(result.say, /Residence 19A has 3 bedrooms/)
  assert.equal(result.record.sourceReadAt, ctx.inventory.readAt.toISOString())
})

test('emergency and restricted question/topic routing still runs before apartment facts', () => {
  assert.equal(ask('There is a fire in the kitchen. How many bedrooms in 19A?').emergency?.kind, 'smoke_or_fire')
  assert.equal(ask('How many bedrooms in 19A, and will I qualify with my credit score?').record.decision, 'escalate')
  assert.equal(ask('How many bedrooms in 19A?', context(), 'reasonable_accommodation').record.decision, 'escalate')
  assert.notEqual(ask('How many bedrooms in 19A and what is the rent?').record.kind, 'unit_facts_answered')
})

test('a mistaken availability label on a dimensions-only question still resolves, but unrelated questions do not', () => {
  assert.equal(ask('How many bedrooms in 19A?', context(), 'unit_availability').say, 'Residence 19A has 3 bedrooms.')
  for (const question of ['Does 19A have a balcony?', 'Is 19A available?', 'Can I tour 19A?', 'What is the bedroom policy for guests?',
    'Does 19A have air conditioning in the bedrooms?', 'How many windows in the bedrooms of 19A?',
    'How big is the bedroom in 19A?', 'What is the bathroom size in Unit 19A?']) {
    assert.notEqual(ask(question).record.kind, 'unit_facts_answered', question)
  }
})

test('numeric and hyphenated unit IDs resolve exactly, and multiple numeric units remain ambiguous', () => {
  const ctx = context()
  ctx.inventory.units[0]!.unitId = '101'; ctx.inventory.units[1]!.unitId = '102'
  assert.equal(ask('How many bedrooms in Unit 101?', ctx).say, 'Residence 101 has 3 bedrooms.')
  assert.equal(ask('How many bedrooms in Unit 101 and 102?', ctx).record.reason, 'ambiguous_unit')
  ctx.inventory.units[0]!.unitId = '19-A'
  assert.equal(ask('How many bedrooms in Residence 19-A?', ctx).say, 'Residence 19-A has 3 bedrooms.')
})
