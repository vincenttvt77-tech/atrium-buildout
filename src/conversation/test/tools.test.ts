import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { checkEmergency, checkAvailability, answerQuestion, captureSignal } from '../tools.ts'
import type { ToolContext } from '../tools.ts'
import type { InventorySnapshot } from '../../inventory/types.ts'
import type { KnowledgeArticle } from '../../knowledge/article.ts'
import { emptyQualification, captureCore } from '../../leasing/qualification.ts'
import { extracted } from '../../leasing/captured.ts'
import { propertyId, interactionId, articleId, personId } from '../../domain/ids.ts'

const NOW = new Date('2026-09-07T12:00:00Z')
const PROP = propertyId('prop-demo')
const CALL = interactionId('int-1')
const HUMAN = personId('person-manager-1')

const inventory: InventorySnapshot = {
  readAt: NOW, source: 'test',
  floorPlans: [
    { id: 'S1', name: 'S1', bedrooms: 0, bathrooms: 1, sqft: 480, description: '', features: [] },
    { id: 'A1', name: 'A1', bedrooms: 1, bathrooms: 1, sqft: 700, description: '', features: [] },
  ],
  units: [
    { unitId: '08S', floorPlanId: 'S1', floor: 8, bedrooms: 0, bathrooms: 1, sqft: 480,
      monthlyRent: 3100, availableFrom: '2026-10-01', status: 'available' },
    { unitId: '21A', floorPlanId: 'A1', floor: 21, bedrooms: 1, bathrooms: 1, sqft: 700,
      monthlyRent: 4200, availableFrom: '2026-11-01', status: 'available',
      concession: 'One month free on a 14-month lease' },
  ],
}

const petArticle: KnowledgeArticle = {
  id: articleId('art-pets'), topic: 'pet_policy',
  question: 'Do you allow dogs?',
  answer: 'We do — two pets per home, with a 50 pound weight limit and a $500 one-time pet fee.',
  propertyScope: [PROP], jurisdictionScope: ['NY'], status: 'published', version: 1,
  source: 'House Rules rev 2026-03', ownerId: HUMAN, approvedBy: HUMAN,
  approvedAt: new Date('2026-03-01'), reviewBy: new Date('2027-03-01'),
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  propertyId: PROP, interactionId: CALL, inventory, articles: [petArticle],
  qualification: emptyQualification(), jurisdiction: 'NY',
  confidenceThreshold: 0.7, now: NOW, ...over,
})

const qualified = (budget: number, beds: number) => {
  let q = captureCore(emptyQualification(), 'budget',
    extracted({ maxMonthly: budget, stated: true }, 0.9, CALL, `${budget} max`, NOW))
  q = captureCore(q, 'bedrooms', extracted({ min: beds, max: beds }, 0.9, CALL, 'one bed', NOW))
  return q
}

describe('emergency pre-empts every other tool', () => {
  test('a gas report returns the fixed safety instruction and escalates', () => {
    const r = checkEmergency('I smell gas in my kitchen', ctx())
    assert.ok(r)
    assert.match(r!.say, /911/)
    assert.match(r!.say, /light switch/i)
    assert.equal(r!.escalate?.trigger, 'emergency')
  })

  test('a leasing question returns null so the normal flow proceeds', () => {
    assert.equal(checkEmergency('what is the rent on the one bedroom', ctx()), null)
  })
})

describe('the quote gate cannot be talked past', () => {
  test('availability refuses to quote before qualification', () => {
    const r = checkAvailability(ctx())
    assert.match(r.say, /Do NOT state any rent/i)
    assert.equal(r.record.allowed, false)
  })

  test('once qualified it returns only verified units', () => {
    const r = checkAvailability(ctx({ qualification: qualified(4500, 1) }))
    assert.match(r.say, /21A/)
    assert.match(r.say, /\$4,200/)
    assert.ok(!r.say.includes('08S'), 'a studio must not be offered to someone who asked for a one bed')
  })

  test('the concession is surfaced because it is a real lever', () => {
    const r = checkAvailability(ctx({ qualification: qualified(4500, 1) }))
    assert.match(r.say, /One month free/)
  })
})

describe('priced out is the branch that earns its keep', () => {
  test('a prospect under every rent is told the truth, not sold up', () => {
    const r = checkAvailability(ctx({ qualification: qualified(2500, 1) }))
    assert.equal(r.record.outcome, 'priced_out')
    assert.match(r.say, /Do NOT pitch a more expensive unit/i)
  })

  test('the gap is recorded as a number, which is what makes it countable', () => {
    const r = checkAvailability(ctx({ qualification: qualified(2500, 1) }))
    assert.equal(r.record.budgetMax, 2500)
    assert.equal(r.record.cheapestAvailable, 4200)
    assert.equal(r.record.gap, 1700)
  })
})

describe('questions are answered only from approved knowledge', () => {
  test('an approved policy question is answered verbatim with sources', () => {
    const r = answerQuestion({ question: 'do you allow dogs', topic: 'pet_policy' }, ctx())
    assert.match(r.say, /two pets per home/i)
    assert.deepEqual(r.record.sources, ['art-pets@v1'])
  })

  test('an unknown policy question refuses rather than improvising', () => {
    const r = answerQuestion({ question: 'is the roof deck heated', topic: 'amenities' }, ctx())
    assert.match(r.say, /do not want to guess/i)
    assert.match(r.say, /Do NOT improvise/i)
  })

  test('a voucher question escalates and is never characterised', () => {
    const r = answerQuestion({ question: 'do you take section 8', topic: 'fair_housing' }, ctx())
    assert.ok(r.escalate)
    // The question guard reclassifies this to protected_class_inquiry — source of income is
    // a protected class in New York City. Either way it escalates; the guard is more precise.
    assert.match(r.escalate!.trigger, /restricted:(fair_housing|protected_class_inquiry)/)
    assert.match(r.say, /do NOT attempt to answer/i)
  })

  test('a pet question mentioning a service animal escalates despite a pet_policy topic', () => {
    const r = answerQuestion(
      { question: 'do you allow German Shepherds, mine is a service dog', topic: 'pet_policy' },
      ctx())
    assert.ok(r.escalate, 'the model chose pet_policy; the guard must override it')
    assert.match(r.escalate!.trigger, /reasonable_accommodation/)
    assert.equal(r.record.guardedFrom, 'pet_policy')
  })

  test('an accommodation request escalates', () => {
    const r = answerQuestion({ question: 'I need a service animal exception', topic: 'reasonable_accommodation' }, ctx())
    assert.ok(r.escalate)
  })

  test('a pricing question is pushed to the live tool, never answered from knowledge', () => {
    const r = answerQuestion({ question: 'how much is a one bedroom', topic: 'pricing' }, ctx())
    assert.match(r.say, /availability tool/)
    assert.match(r.say, /Do NOT answer from memory/i)
  })
})

describe('captured signals carry their evidence forward', () => {
  test('a stated budget becomes a qualification value with its excerpt', () => {
    const r = captureSignal(
      { signal: 'budget', value: '$3,000', excerpt: 'I can go up to about three thousand' }, ctx())
    assert.equal(r.qualificationPatch?.budget?.value.maxMonthly, 3000)
    assert.equal(r.qualificationPatch?.budget?.excerpt, 'I can go up to about three thousand')
  })

  test('studio is understood as zero bedrooms', () => {
    const r = captureSignal({ signal: 'bedrooms', value: 'studio', excerpt: 'a studio' }, ctx())
    assert.equal(r.qualificationPatch?.bedrooms?.value.min, 0)
  })
})
