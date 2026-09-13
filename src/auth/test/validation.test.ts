import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateUser } from '../validation.ts'
import { AuthorizationError } from '../model.ts'
import type { User } from '../model.ts'

const user: User = { id: 'synthetic-user', username: 'leasing.staff', displayName: 'Synthetic Staff',
  status: 'active', credentialVersion: 1 }
const invalidRecord = (error: unknown) => error instanceof AuthorizationError && error.code === 'invalid_record'

test('a null username from an untrusted record is rejected rather than matching the null normalization sentinel', () => {
  const malformed = { ...user, username: null } as unknown as User
  assert.throws(() => validateUser(malformed), invalidRecord)
})

test('canonical supported usernames validate without normalizing or changing the stored identity', () => {
  for (const username of ['abc', 'leasing.staff', 'site_admin', 'owner-nyc', 'u'.repeat(64)]) {
    const source = { ...user, username }
    const validated = validateUser(source)
    assert.deepEqual(validated, source)
    assert.notEqual(validated, source, 'validation returns a detached record')
  }
})

test('other malformed and noncanonical usernames are refused consistently', () => {
  for (const username of [undefined, false, 0, {}, [], '', 'ab', 'u'.repeat(65), ' STAFF ', 'Staff', 'staff name', 'équipe']) {
    const malformed = { ...user, username } as unknown as User
    assert.throws(() => validateUser(malformed), invalidRecord)
  }
})
