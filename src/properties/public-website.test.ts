import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePublicShortlistWebsite, publicShortlistLink } from './public-website.ts'
import { PropertyConfigurationError } from './model.ts'
const scope = { organizationId: 'org-one', propertyId: 'building-one', inventorySource: 'reviewed-feed-one' }
const publication = '2026-09-22T10:00:00Z', now = new Date('2026-09-22T12:00:00Z')
const binding = () => ({ ...scope, format: 'atrium-shortlist-v1' as const, baseUrl: 'https://one.example/leasing/',
  reviewedAt: '2026-09-22T09:00:00Z', reviewExpiresAt: '2026-10-01T09:00:00Z' })
test('website binding is an explicit frozen publication matching organization, property and source', () => {
  assert.equal(validatePublicShortlistWebsite(undefined, scope, publication), null)
  const website = validatePublicShortlistWebsite(binding(), scope, publication)!
  assert.ok(Object.isFrozen(website))
  assert.equal(publicShortlistLink(website, scope, ['4A', '9l'], now), 'https://one.example/leasing/#availability?units=4A%2C9L')
  for (const changed of [{ organizationId: 'org-two' }, { propertyId: 'building-two' }, { inventorySource: 'other-feed' }]) {
    assert.throws(() => validatePublicShortlistWebsite({ ...binding(), ...changed }, scope, publication), PropertyConfigurationError)
    assert.equal(publicShortlistLink(website, { ...scope, ...changed }, ['4A'], now), null)
  }
})
test('binding rejects credentials, query, fragment, local addresses and ambiguous URLs', () => {
  for (const baseUrl of ['http://one.example/', 'javascript:alert(1)', 'https://name:secret@one.example/',
    'https://one.example/?email=private', 'https://one.example/#other', 'https://localhost/', 'https://127.0.0.1/',
    'https://[::1]/', 'https://foo.local/', 'https://foo.internal/', 'https://one.example:8443/', 'https://one.example./',
    'https://one.example/a/../', 'https://one.example/%0a', 'https://one.example\\evil/', ' https://one.example/',
    'https://one.example/?', 'https://one.example/#']) {
    assert.throws(() => validatePublicShortlistWebsite({ ...binding(), baseUrl }, scope, publication), PropertyConfigurationError, baseUrl)
  }
})
test('reviews have strict instants, cannot be future-dated and expire within thirty days', () => {
  for (const change of [{ reviewedAt: '2026-09-23T00:00:00Z' }, { reviewedAt: '2026-02-30T00:00:00Z' },
    { reviewExpiresAt: '2026-09-22T09:00:00Z' }, { reviewExpiresAt: '2027-01-01T00:00:00Z' },
    { reviewExpiresAt: 'tomorrow' }, { secret: 'unrecognized-field' }, { format: 'unknown' }]) {
    assert.throws(() => validatePublicShortlistWebsite({ ...binding(), ...change }, scope, publication), PropertyConfigurationError)
  }
  const website = validatePublicShortlistWebsite(binding(), scope, publication)!
  assert.equal(publicShortlistLink(website, scope, ['4A'], new Date(website.reviewExpiresAt)), null)
  assert.equal(publicShortlistLink(website, scope, ['4A'], new Date('2026-09-22T08:00:00Z')), null)
  assert.equal(publicShortlistLink(website, scope, ['4A'], new Date('bad')), null)
})
test('unbound and invalid selections never produce a generic building link', () => {
  const website = validatePublicShortlistWebsite(binding(), scope, publication)!
  assert.equal(publicShortlistLink(undefined, scope, ['4A'], now), null)
  for (const ids of [[], ['A', 'B', 'C', 'D', 'E', 'F'], ['4A', '4a'], ['../other'], ['<script>'], ['A&B']]) {
    assert.equal(publicShortlistLink(website, scope, ids, now), null)
  }
})
