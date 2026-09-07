import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { retrieve, tokenize } from '../retrieve.ts'
import type { KnowledgeArticle } from '../article.ts'
import { articleId, personId, propertyId } from '../../domain/ids.ts'

const HUMAN = personId('person-1')
const PROP = propertyId('prop-demo')

let seq = 0
function art(question: string, answer: string, keywords?: string[]): KnowledgeArticle {
  return {
    id: articleId(`art-${++seq}`), topic: 'amenities', question, answer,
    propertyScope: [PROP], jurisdictionScope: ['NY'], status: 'published', version: 1,
    source: 'test', ownerId: HUMAN, approvedBy: HUMAN,
    approvedAt: new Date('2026-01-01'), reviewBy: new Date('2027-01-01'),
    ...(keywords ? { keywords } : {}),
  }
}

const CORPUS = [
  art('What time does the gym open?', 'The fitness floor is open 5am to midnight daily.', ['gym', 'fitness']),
  art('What time is the leasing office open?', 'Monday to Friday 10 to 6, weekends 10 to 5.'),
  art('Is there a dog run?', 'The Green is a 1,400 square foot dog run on four.', ['dog', 'pet']),
  art('How do I reserve the screening room?', 'Eighteen seats, book up to 30 days ahead.', ['screening', 'theater']),
  art('Is there bike storage?', 'Two hundred twenty tagged spaces on three, no charge.', ['bike', 'bicycle']),
]

describe('tokenizing', () => {
  test('drops stopwords and stems plurals', () => {
    assert.deepEqual(tokenize('What are the gym hours?'), ['gym', 'hour'])
  })

  test('ties dogs to dog', () => {
    assert.ok(tokenize('do you allow dogs').includes('dog'))
  })
})

describe('the right article wins', () => {
  test('a gym question does not return the leasing office hours', () => {
    const { ranked } = retrieve('what are the gym hours', CORPUS)
    assert.match(ranked[0]!.article.question, /gym/i,
      'this exact confusion shipped once — an approved, fluent, wrong answer')
  })

  test('keywords reach an article the caller has no words in common with', () => {
    const { ranked } = retrieve('where do I put my bicycle', CORPUS)
    assert.match(ranked[0]!.article.question, /bike/i)
  })

  test('a question about nothing in the corpus ranks nothing', () => {
    const { ranked, confidence } = retrieve('is there a helipad', CORPUS)
    assert.ok(ranked.length === 0 || confidence < 0.5,
      'no article should confidently answer for something the building does not have')
  })
})

describe('confidence reflects how much of the question was found', () => {
  test('a well-matched question clears a 0.7 threshold', () => {
    const { confidence } = retrieve('what time does the gym open', CORPUS)
    assert.ok(confidence >= 0.7, `expected >= 0.7, got ${confidence.toFixed(2)}`)
  })

  test('an unrelated question does not clear it', () => {
    const { confidence } = retrieve('do you have a golf simulator', CORPUS)
    assert.ok(confidence < 0.7, `expected < 0.7, got ${confidence.toFixed(2)}`)
  })

  test('common words do not drag a specific match below threshold', () => {
    // "the", "in", "is" are stopped; "there" too. The signal word must carry it.
    const withNoise = retrieve('is there somewhere in the building for a bike', CORPUS)
    assert.match(withNoise.ranked[0]!.article.question, /bike/i)
  })

  test('an empty question retrieves nothing rather than the first article', () => {
    assert.equal(retrieve('', CORPUS).ranked.length, 0)
    assert.equal(retrieve('the a of', CORPUS).ranked.length, 0)
  })

  test('an empty corpus is handled', () => {
    const { ranked, confidence } = retrieve('anything', [])
    assert.deepEqual(ranked, [])
    assert.equal(confidence, 0)
  })
})

describe('words that name every article', () => {
  test('"units", "place" and filler do not pull a correct match under the threshold', () => {
    const corpus = [
      art('Do the residences have balconies?', 'Some do — the A2 and B2 lines.', ['balcony', 'balconies']),
      art('What floor plans do you have?', 'Ten plans, from a studio to a three bedroom.', ['floor plans', 'layouts']),
    ]
    const { ranked, confidence } = retrieve('so do the units have balconies?', corpus)
    assert.equal(ranked[0]!.article.question, 'Do the residences have balconies?')
    assert.ok(confidence >= 0.7, `confidence ${confidence}`)
    assert.deepEqual(tokenize('is there a place to wash my dog'), ['wash', 'dog'])
  })
})
