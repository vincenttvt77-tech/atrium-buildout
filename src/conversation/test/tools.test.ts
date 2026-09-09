import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { checkEmergency, checkAvailability, answerQuestion, captureSignal, parseBudget } from '../tools.ts'
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
    assert.match(r.say, /one month free/i)
  })
})

describe('priced out is the branch that earns its keep', () => {
  test('a prospect under every rent is told the truth, not sold up', () => {
    const r = checkAvailability(ctx({ qualification: qualified(2500, 1) }))
    assert.equal(r.record.outcome, 'priced_out')
    assert.match(r.say, /Do NOT pitch it as though it met their budget/i)
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

describe('a caller can ask about a residence by name', () => {
  test('a named available unit is quoted directly, no qualification needed', () => {
    const r = checkAvailability(ctx(), { unitId: '21A' })
    assert.match(r.say, /Residence 21A is available/)
    assert.match(r.say, /\$4,200/)
    assert.equal(r.record.outcome, 'unit_lookup')
  })

  test('"unit 21A" and "21a" resolve the same residence', () => {
    assert.match(checkAvailability(ctx(), { unitId: 'unit 21A' }).say, /Residence 21A/)
    assert.match(checkAvailability(ctx(), { unitId: '21a' }).say, /Residence 21A/)
  })

  test('a residence that does not exist is said not to exist — never guessed at', () => {
    const r = checkAvailability(ctx(), { unitId: '99Q' })
    assert.match(r.say, /no residence 99Q/i)
    assert.match(r.say, /do not guess/i)
    assert.equal(r.record.outcome, 'unit_not_found')
  })

  test('a named unit later than the caller\'s date is quoted with the date, not called unavailable', () => {
    const q = captureCore(emptyQualification(), 'moveInTiming',
      extracted({ earliest: new Date('2026-09-15'), latest: null }, 0.9, CALL, 'mid September', NOW))
    const r = checkAvailability(ctx({ qualification: q }), { unitId: '21A' }) // 21A frees Nov 1
    assert.match(r.say, /Residence 21A is available/)
    assert.match(r.say, /not free until November 1/)
    assert.ok(!/unavailable/i.test(r.say))
  })
})

describe('a floor plan named as if it were a residence', () => {
  const plans: InventorySnapshot = {
    ...inventory,
    floorPlans: [
      ...inventory.floorPlans,
      { id: 'A2', name: 'One Bedroom with Balcony', bedrooms: 1, bathrooms: 1, sqft: 731, description: '', features: ['Private balcony'] },
      { id: 'B1', name: 'Two Bedroom', bedrooms: 2, bathrooms: 2, sqft: 1100, description: '', features: [] },
    ],
    units: [
      ...inventory.units,
      { unitId: '12H', floorPlanId: 'A2', floor: 12, bedrooms: 1, bathrooms: 1, sqft: 731,
        monthlyRent: 4650, availableFrom: '2026-10-15', status: 'available' },
      { unitId: '15H', floorPlanId: 'A2', floor: 15, bedrooms: 1, bathrooms: 1, sqft: 731,
        monthlyRent: 4700, availableFrom: '2026-12-01', status: 'leased' },
    ],
  }

  test('"is an A2 open" lists what is open in that layout instead of "no residence A2"', () => {
    const r = checkAvailability(ctx({ inventory: plans }), { unitId: 'A2' })
    assert.equal(r.record.outcome, 'plan_lookup')
    assert.match(r.say, /One Bedroom with Balcony/)
    assert.match(r.say, /12H/)
    assert.doesNotMatch(r.say, /15H/, 'a leased residence is not offered')
    assert.doesNotMatch(r.say, /no residence/i)
  })

  test('the plan can be named by its name or with "the … floor plan" around it', () => {
    for (const said of ['the A2 floor plan', 'one bedroom with balcony', 'A2 layout']) {
      const r = checkAvailability(ctx({ inventory: plans }), { unitId: said })
      assert.equal(r.record.outcome, 'plan_lookup', said)
    }
  })

  test('a plan with nothing open says so and offers the size, never a rent', () => {
    const r = checkAvailability(ctx({ inventory: plans }), { unitId: 'B1' })
    assert.equal(r.record.outcome, 'plan_none_open')
    assert.doesNotMatch(r.say, /\$/)
  })

  test('a real residence still wins over a plan, and an unknown code is still not found', () => {
    assert.equal(checkAvailability(ctx({ inventory: plans }), { unitId: '21A' }).record.outcome, 'unit_lookup')
    assert.equal(checkAvailability(ctx({ inventory: plans }), { unitId: 'Z9' }).record.outcome, 'unit_not_found')
  })
})

describe('a question filed under the wrong policy topic', () => {
  const broker: KnowledgeArticle = {
    ...petArticle, id: articleId('art-broker'), topic: 'application_requirements',
    question: 'Is there a broker fee?', answer: 'No. The building is leased in-house, so there is no broker fee.',
    keywords: ['broker', 'fee'],
  }
  const packages: KnowledgeArticle = {
    ...petArticle, id: articleId('art-packages'), topic: 'general_property_fact',
    question: 'How do packages work?', answer: 'Lockers behind the lobby, open 24 hours with your fob.',
  }

  test('is answered from the article under the topic where it actually lives', () => {
    const r = answerQuestion({ question: 'is there a broker fee?', topic: 'general_property_fact' },
      ctx({ articles: [petArticle, broker, packages] }))
    assert.equal(r.record.decision, 'answer')
    assert.match(r.say, /no broker fee/i)
    assert.equal(r.record.topic, 'application_requirements')
    assert.equal(r.record.topicAsked, 'general_property_fact')
  })

  test('never widens into a restricted or volatile topic', () => {
    const guarded = answerQuestion({ question: 'do you take section 8 vouchers?', topic: 'general_property_fact' },
      ctx({ articles: [petArticle, broker, packages] }))
    assert.equal(guarded.record.decision, 'escalate')
    // A fee is policy, not a live price: filed under pricing it is still answered from the article.
    const live = answerQuestion({ question: 'is there a broker fee?', topic: 'pricing' },
      ctx({ articles: [petArticle, broker, packages] }))
    assert.equal(live.record.decision, 'answer')
    const rent = answerQuestion({ question: 'how much is the rent on a two bedroom?', topic: 'pricing' },
      ctx({ articles: [petArticle, broker, packages] }))
    assert.equal(rent.record.decision, 'defer')
  })

  test('still refuses when no article anywhere clears the threshold', () => {
    const r = answerQuestion({ question: 'is there a helipad?', topic: 'general_property_fact' },
      ctx({ articles: [petArticle, broker, packages] }))
    assert.equal(r.record.kind, 'question_refused')
  })
})

describe('a budget as the transcriber writes it', () => {
  test('"$4. 000" is four thousand, not four', () => {
    assert.equal(parseBudget('4', "I'm not looking to spend over. $4. 000."), 4000)
    assert.equal(parseBudget('$4. 000', ''), 4000)
    assert.equal(parseBudget('4k', ''), 4000)
    assert.equal(parseBudget('four thousand', ''), 4000)
    assert.equal(parseBudget('forty-two hundred', 'forty-two hundred a month'), 4200)
    assert.equal(parseBudget('4,200', ''), 4200)
    assert.equal(parseBudget('nothing', 'whatever it takes'), null)
  })
  test('captured through capture_signal it gates a real quote', () => {
    const r = captureSignal({ signal: 'budget', value: '4', excerpt: 'not over $4. 000.' }, ctx())
    assert.equal(r.record.captured, true)
    assert.equal(r.qualificationPatch?.budget?.value.maxMonthly, 4000)
  })
})

describe('quotes say the net effective figure and the lease figure', () => {
  test('a match names both, in that order', () => {
    const r = checkAvailability(ctx({ qualification: qualified(4500, 1) }))
    assert.equal(r.record.outcome, 'matches')
    assert.match(r.say, /\$4,200\/month — say "four thousand two hundred dollars a month" net effective with one month free on a 14-month lease \(\$4,523\/month on the lease itself — say "four thousand five hundred twenty-three dollars"\)/)
  })
  test('priced out names the residence, the gap, and what the money does buy', () => {
    const r = checkAvailability(ctx({ qualification: qualified(3500, 1) }))
    assert.equal(r.record.outcome, 'priced_out')
    assert.match(r.say, /Unit 21A/)
    assert.match(r.say, /\$700\/month above/)
    assert.match(r.say, /a size down[\s\S]*Unit 08S/)
    assert.deepEqual(r.record.unitsOffered, ['21A', '08S'])
  })
  test('signals passed inline to check_availability are captured and used in one call', () => {
    const r = checkAvailability(ctx(), { moveIn: 'within the next, uh, 2. Months.', bedrooms: '1', budget: 'not over $4. 500' })
    assert.equal(r.record.outcome, 'matches')
    assert.match(r.say, /Unit 21A/)
    assert.equal(r.qualificationPatch?.budget?.value.maxMonthly, 4500)
    assert.equal(r.qualificationPatch?.bedrooms?.value.min, 1)
    assert.ok(r.qualificationPatch?.moveInTiming)
  })
})

describe('a policy question the model filed under a live topic', () => {
  const gym: KnowledgeArticle = {
    ...petArticle, id: articleId('art-gym'), topic: 'amenities',
    question: 'Do you have a gym?', answer: 'The Works is 4,200 square feet on three with Technogym strength and cardio.',
    keywords: ['gym', 'fitness'],
  }
  test('"do you have a gym" under pricing is answered, not deferred', () => {
    const r = answerQuestion({ question: 'do you have a gym?', topic: 'pricing' }, ctx({ articles: [petArticle, gym] }))
    assert.equal(r.record.decision, 'answer')
    assert.match(r.say, /Technogym/)
  })
  test('"how much is a one bedroom" under pricing still defers to the live tool', () => {
    const r = answerQuestion({ question: 'how much is a one bedroom?', topic: 'pricing' }, ctx({ articles: [petArticle, gym] }))
    assert.equal(r.record.decision, 'defer')
  })
  test('a guarded question under a live topic still escalates', () => {
    const r = answerQuestion({ question: 'do you take section 8?', topic: 'unit_availability' }, ctx({ articles: [petArticle, gym] }))
    assert.equal(r.record.decision, 'escalate')
  })
})
