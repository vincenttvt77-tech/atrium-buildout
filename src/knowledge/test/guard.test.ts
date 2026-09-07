import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { guardTopic } from '../guard.ts'

describe('a misclassified question cannot be answered from the knowledge base', () => {
  const mustEscalate: [string, string][] = [
    ['I have a German Shepherd service dog, is that a problem', 'reasonable_accommodation'],
    ['my dog is an emotional support animal', 'reasonable_accommodation'],
    ['is the building wheelchair accessible', 'reasonable_accommodation'],
    ['I need a reasonable accommodation', 'reasonable_accommodation'],
    ['do you take section 8', 'protected_class_inquiry'],
    ['will you accept a housing voucher', 'protected_class_inquiry'],
    ['do you take CityFHEPS', 'protected_class_inquiry'],
    ['will I qualify with a 620 credit score', 'eligibility_or_denial'],
    ['I have an eviction on my record', 'eligibility_or_denial'],
    ['do you run a criminal background check', 'eligibility_or_denial'],
    ['is that even legal', 'legal_question'],
    ['can I break my lease early', 'legal_question'],
    ['is this apartment rent stabilized', 'legal_question'],
  ]

  for (const [question, topic] of mustEscalate) {
    test(`"${question}" → ${topic}`, () => {
      const g = guardTopic(question)
      assert.ok(g, 'must be guarded')
      assert.equal(g!.topic, topic)
    })
  }

  test('a breed question paired with a service animal never reaches the breed policy', () => {
    // The failure this exists for: the model classifies it pet_policy, retrieval finds the
    // breed restriction, and the agent denies housing over a disability.
    const g = guardTopic('do you allow pit bulls, mine is a service dog')
    assert.equal(g?.topic, 'reasonable_accommodation')
  })
})

describe('ordinary leasing questions are not guarded', () => {
  const safe = [
    'do you allow dogs',
    'is there a weight limit on dogs',
    'are there any breeds you do not allow',
    'what is the pet fee',
    'is there a dog run',
    'how much is parking',
    'what are the gym hours',
    'can I book the screening room',
    'when can I move in',
    'is there a doorman',
  ]
  for (const question of safe) {
    test(`"${question}" is answered normally`, () => {
      assert.equal(guardTopic(question), null,
        `false escalation on: ${JSON.stringify(guardTopic(question))}`)
    })
  }
})
