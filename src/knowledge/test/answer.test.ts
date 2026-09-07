import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { decideAnswer, type AnswerRequest } from '../answer.ts'
import type { KnowledgeArticle } from '../article.ts'
import { articleId, personId, propertyId } from '../../domain/ids.ts'

const NOW = new Date('2026-09-07T12:00:00Z')
const PROP = propertyId('prop-riverside')
const OTHER = propertyId('prop-elsewhere')
const HUMAN = personId('person-manager-1')

function article(over: Partial<KnowledgeArticle> = {}): KnowledgeArticle {
  return {
    id: articleId('art-1'),
    topic: 'pet_policy',
    question: 'Do you allow dogs?',
    answer: 'Two pets per unit, 50 lb limit, $300 non-refundable fee.',
    propertyScope: [PROP],
    jurisdictionScope: [],
    status: 'published',
    version: 3,
    source: 'Lease addendum B, 2026-01',
    ownerId: HUMAN,
    approvedBy: HUMAN,
    approvedAt: new Date('2026-01-15T00:00:00Z'),
    reviewBy: new Date('2027-01-15T00:00:00Z'),
    ...over,
  }
}

function req(over: Partial<AnswerRequest> = {}): AnswerRequest {
  return {
    question: 'Do you allow dogs?',
    topic: 'pet_policy',
    propertyId: PROP,
    jurisdiction: 'NY',
    candidates: [article()],
    confidence: 0.9,
    confidenceThreshold: 0.7,
    now: NOW,
    ...over,
  }
}

describe('restricted topics always escalate', () => {
  const restricted = [
    'fair_housing', 'reasonable_accommodation', 'eligibility_or_denial',
    'legal_question', 'dispute', 'money_movement', 'protected_class_inquiry',
  ] as const

  for (const topic of restricted) {
    test(`${topic} escalates`, () => {
      const d = decideAnswer(req({ topic }))
      assert.equal(d.kind, 'escalate')
    })

    test(`${topic} escalates even with a perfect article and full confidence`, () => {
      const d = decideAnswer(req({
        topic,
        confidence: 1,
        confidenceThreshold: 0,
        candidates: [article({ topic: 'general_property_fact' })],
      }))
      assert.equal(d.kind, 'escalate', 'a restricted topic must not be answerable at any confidence')
    })
  }
})

describe('volatile topics never come from the knowledge base', () => {
  test('pricing defers to inventory even when a published article exists', () => {
    const d = decideAnswer(req({
      topic: 'pricing',
      candidates: [article({ answer: 'One-bedrooms start at $2,400.' })],
      confidence: 1,
    }))
    assert.equal(d.kind, 'defer_to_live_source')
    assert.equal(d.kind === 'defer_to_live_source' && d.source, 'inventory')
  })

  test('tour slot availability defers to the calendar', () => {
    const d = decideAnswer(req({ topic: 'tour_slot_availability' }))
    assert.equal(d.kind === 'defer_to_live_source' && d.source, 'tour_calendar')
  })

  test('a stale quote is never served as an answer', () => {
    const d = decideAnswer(req({ topic: 'unit_availability', confidence: 1, confidenceThreshold: 0 }))
    assert.notEqual(d.kind, 'answer')
  })
})

describe('policy topics require an approved, in-scope, current article', () => {
  test('answers from a servable article and cites its sources', () => {
    const d = decideAnswer(req())
    assert.equal(d.kind, 'answer')
    if (d.kind !== 'answer') return
    assert.match(d.text, /Two pets per unit/)
    assert.deepEqual(d.sources, [{ id: 'art-1', version: 3 }])
  })

  test('refuses when the article is only a draft', () => {
    const d = decideAnswer(req({ candidates: [article({ status: 'draft' })] }))
    assert.equal(d.kind, 'refuse')
    assert.equal(d.kind === 'refuse' && d.reason, 'no_approved_answer')
  })

  test('refuses when no human approved it', () => {
    const d = decideAnswer(req({ candidates: [article({ approvedBy: null })] }))
    assert.equal(d.kind, 'refuse')
  })

  test('refuses when the article is past its review date', () => {
    const d = decideAnswer(req({
      candidates: [article({ reviewBy: new Date('2026-08-01T00:00:00Z') })],
    }))
    assert.equal(d.kind, 'refuse')
  })

  test('refuses when the article belongs to a different property', () => {
    const d = decideAnswer(req({ candidates: [article({ propertyScope: [OTHER] })] }))
    assert.equal(d.kind, 'refuse')
  })

  test('refuses when the article is out of jurisdiction', () => {
    const d = decideAnswer(req({ candidates: [article({ jurisdictionScope: ['CA'] })] }))
    assert.equal(d.kind, 'refuse')
  })

  test('portfolio-wide articles serve any property', () => {
    const d = decideAnswer(req({ candidates: [article({ propertyScope: [] })] }))
    assert.equal(d.kind, 'answer')
  })

  test('refuses below the property confidence threshold', () => {
    const d = decideAnswer(req({ confidence: 0.4, confidenceThreshold: 0.7 }))
    assert.equal(d.kind, 'refuse')
    assert.equal(d.kind === 'refuse' && d.reason, 'below_confidence_threshold')
  })

  test('refuses when retrieval found nothing at all', () => {
    const d = decideAnswer(req({ candidates: [] }))
    assert.equal(d.kind, 'refuse')
  })
})

describe('knowledge gaps become human review tasks', () => {
  test('a refusal proposes an article scoped to the asking property', () => {
    const d = decideAnswer(req({ candidates: [], question: 'Is the roof deck heated?' }))
    assert.equal(d.kind, 'refuse')
    if (d.kind !== 'refuse') return
    assert.equal(d.propose.question, 'Is the roof deck heated?')
    assert.equal(d.propose.propertyId, PROP)
    assert.equal(d.propose.status, 'proposed')
  })

  test('repeat asks increment so review can be prioritised', () => {
    const d = decideAnswer(req({ candidates: [], timesAsked: 4 }))
    assert.equal(d.kind === 'refuse' && d.propose.timesAsked, 5)
  })
})
