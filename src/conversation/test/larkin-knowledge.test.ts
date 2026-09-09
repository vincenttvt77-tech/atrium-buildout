import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { answerQuestion, type ToolContext } from '../tools.ts'
import type { KnowledgeArticle } from '../../knowledge/article.ts'
import { articleId, interactionId, propertyId } from '../../domain/ids.ts'
import { emptyQualification } from '../../leasing/qualification.ts'

const NOW = new Date('2026-09-09T12:00:00Z')
const articles: KnowledgeArticle[] = JSON.parse(readFileSync(new URL('../../../data/knowledge.json', import.meta.url), 'utf8'))
  .map((a: KnowledgeArticle & { approvedAt: string | null; reviewBy: string }) => ({
    ...a, approvedAt: a.approvedAt ? new Date(a.approvedAt) : null, reviewBy: new Date(a.reviewBy),
  }))
const context = (over: Partial<ToolContext> = {}): ToolContext => ({
  propertyId: propertyId('prop-demo'), interactionId: interactionId('larkin-knowledge-test'),
  inventory: { readAt: NOW, source: 'test', units: [], floorPlans: [] },
  articles, qualification: emptyQualification(), jurisdiction: 'NY', confidenceThreshold: 0.7, now: NOW,
  ...over,
})

test('Larkin fee answers agree with the canonical no-deposit policies', () => {
  const move = answerQuestion({ question: 'Is there a move-in deposit?', topic: 'general_property_fact' }, context())
  assert.equal(move.record.decision, 'answer')
  assert.match(move.say, /no move(?:-in)? fee and no move(?:-in)? deposit/i)
  assert.doesNotMatch(move.say, /\$500|five hundred/)
  const pet = answerQuestion({ question: 'How much is the pet fee?', topic: 'pet_policy' }, context())
  assert.equal(pet.record.decision, 'answer')
  assert.match(pet.say, /no pet fee/i)
  assert.doesNotMatch(pet.say, /\$350|three hundred fifty/)
})

test('approved ordinary breed and pool questions have specific answers', () => {
  const breed = answerQuestion({ question: 'Are German Shepherds allowed?', topic: 'pet_policy' }, context())
  assert.equal(breed.record.decision, 'answer')
  assert.match(breed.say, /restricted pet breed list includes.*German Shepherd/)
  const pool = answerQuestion({ question: 'Is there a pool?', topic: 'amenities' }, context())
  assert.equal(pool.record.decision, 'answer')
  assert.match(pool.say, /62-foot pool/)
  assert.doesNotMatch(pool.say, /^It is not\./)
})

test('promotions use current inventory regardless of the model topic', () => {
  for (const question of ['Do you have any specials right now?', 'Are there any free months?', 'Is there one month free?']) {
    const result = answerQuestion({ question, topic: 'general_property_fact' }, context())
    assert.equal(result.record.decision, 'defer', question)
    assert.match(result.say, /availability tool/)
    assert.doesNotMatch(result.say, /December 31|October 31/)
  }
})

test('knowledge completeness does not bypass restricted questions or invent unknown features', () => {
  const restricted = answerQuestion({ question: 'My German Shepherd is a service dog. Is that okay?', topic: 'pet_policy' }, context())
  assert.equal(restricted.record.decision, 'escalate')
  assert.match(restricted.escalate!.trigger, /reasonable_accommodation/)
  assert.doesNotMatch(restricted.say, /restricted pet breed list/)
  const unknown = answerQuestion({ question: 'Does the building have a helipad?', topic: 'amenities' }, context())
  assert.match(unknown.say, /do not want to guess/i)
})

test('expired and other-property articles cannot lend confidence to an unrelated answer', () => {
  const current = { ...articles.find(a => a.id === 'art-pets-breeds')!, question: 'Do you allow cats?', keywords: [], answer: 'Cats are allowed.' }
  const forbidden: KnowledgeArticle[] = [
    { ...current, id: articleId('expired'), question: 'Is the helipad open?', answer: 'The helipad is open.', reviewBy: new Date('2026-01-01') },
    { ...current, id: articleId('foreign'), question: 'Is the helipad open?', answer: 'The helipad is open.', propertyScope: [propertyId('different-property')] },
  ]
  const result = answerQuestion({ question: 'Is the helipad open?', topic: 'pet_policy' }, context({ articles: [...forbidden, current] }))
  assert.match(result.say, /do not want to guess/i)
  assert.doesNotMatch(result.say, /Cats are allowed|The helipad is open/)
})
