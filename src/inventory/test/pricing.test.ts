import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { concessionTerms, leaseRent, rentPhrase, concessionDeadline, spokenMoney } from '../pricing.ts'

describe('net effective and lease rent agree with the website', () => {
  test('one month free on fourteen grosses up by 14/13', () => {
    const u = { monthlyRent: 5875, concession: 'One month free on a 14-month lease, signed by December 31, 2026' }
    assert.deepEqual(concessionTerms(u.concession), { freeMonths: 1, termMonths: 14 })
    assert.equal(leaseRent(u), 6327)
    assert.equal(concessionDeadline(u.concession), 'December 31, 2026')
    assert.equal(rentPhrase(u), '$5,875/month — say "fifty-eight seventy-five a month" net effective with one month free on a 14-month lease if signed by December 31, 2026 ($6,327/month on the lease itself — say "sixty-three twenty-seven")')
  })
  test('six weeks free on eighteen is a month and a half', () => {
    const u = { monthlyRent: 4050, concession: 'Six weeks free on an 18-month lease' }
    assert.deepEqual(concessionTerms(u.concession), { freeMonths: 1.5, termMonths: 18 })
    assert.equal(leaseRent(u), 4418)
    assert.match(rentPhrase(u), /6 weeks free on a 18-month lease/)
  })
  test('no concession is just the rent', () => {
    assert.equal(leaseRent({ monthlyRent: 7000, concession: null }), 7000)
    assert.equal(rentPhrase({ monthlyRent: 7000, concession: null }), '$7,000/month — say "seven thousand a month"')
    assert.equal(concessionTerms('Waived amenity fee'), null)
  })
})

describe('rents the way they are said out loud', () => {
  test('digits with a comma become words the voice cannot split', () => {
    const cases: Array<[number, string]> = [
      [5440, 'fifty-four forty'], [5405, 'fifty-four oh-five'], [5400, 'fifty-four hundred'], [5000, 'five thousand'],
      [3255, 'thirty-two fifty-five'], [1010, 'ten ten'], [11200, 'eleven thousand two hundred'],
      [12062, 'twelve thousand sixty-two'], [425, 'four hundred twenty-five'], [1875, 'eighteen seventy-five'],
    ]
    for (const [n, words] of cases) assert.equal(spokenMoney(n), words, String(n))
  })
})
