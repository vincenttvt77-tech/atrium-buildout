import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { concessionTerms, leaseRent, rentPhrase, concessionDeadline } from '../pricing.ts'

describe('net effective and lease rent agree with the website', () => {
  test('one month free on fourteen grosses up by 14/13', () => {
    const u = { monthlyRent: 5875, concession: 'One month free on a 14-month lease, signed by December 31, 2026' }
    assert.deepEqual(concessionTerms(u.concession), { freeMonths: 1, termMonths: 14 })
    assert.equal(leaseRent(u), 6327)
    assert.equal(concessionDeadline(u.concession), 'December 31, 2026')
    assert.match(rentPhrase(u), /^\$5,875\/month net effective with one month free on a 14-month lease if signed by December 31, 2026 \(\$6,327\/month on the lease itself\)$/)
  })
  test('six weeks free on eighteen is a month and a half', () => {
    const u = { monthlyRent: 4050, concession: 'Six weeks free on an 18-month lease' }
    assert.deepEqual(concessionTerms(u.concession), { freeMonths: 1.5, termMonths: 18 })
    assert.equal(leaseRent(u), 4418)
    assert.match(rentPhrase(u), /6 weeks free on a 18-month lease/)
  })
  test('no concession is just the rent', () => {
    assert.equal(leaseRent({ monthlyRent: 7000, concession: null }), 7000)
    assert.equal(rentPhrase({ monthlyRent: 7000, concession: null }), '$7,000/month')
    assert.equal(concessionTerms('Waived amenity fee'), null)
  })
})
