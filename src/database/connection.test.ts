import { test } from 'node:test'
import assert from 'node:assert/strict'
import { databasePoolConfig, DatabaseConfigurationError } from './connection.ts'

test('database connections require explicit role credentials and never inherit PG environment defaults', () => {
  assert.throws(() => databasePoolConfig('atrium_app', {}), DatabaseConfigurationError)
  assert.throws(() => databasePoolConfig('atrium_authenticator', { ATRIUM_DATABASE_URL: 'postgres://app:secret@localhost/demo' }), DatabaseConfigurationError)
  const config = databasePoolConfig('atrium_app', { ATRIUM_DATABASE_URL: 'postgres://app:secret@localhost/demo', PGOPTIONS: '-c atrium.actor_user_id=admin' })
  assert.equal(config.ssl, false)
  assert.equal(config.max, 4)
  assert.equal(config.options?.includes('actor_user_id'), false)
})
test('hosted and remote database connections verify TLS; URL options cannot disable it', () => {
  const url = 'postgres://app:secret@localhost/demo'
  assert.deepEqual(databasePoolConfig('atrium_app', { NODE_ENV: 'production', ATRIUM_DATABASE_URL: url }).ssl, { rejectUnauthorized: true })
  assert.deepEqual(databasePoolConfig('atrium_app', { ATRIUM_DATABASE_URL: 'postgres://app:secret@database.example/demo' }).ssl, { rejectUnauthorized: true })
  for (const suffix of ['?sslmode=disable', '?options=-c+role=postgres', '#fragment']) {
    assert.throws(() => databasePoolConfig('atrium_app', { ATRIUM_DATABASE_URL: url + suffix }), DatabaseConfigurationError)
  }
  assert.throws(() => databasePoolConfig('atrium_app', { ATRIUM_SIMULATION: 'isolated-v1', ATRIUM_DATABASE_URL: url }), DatabaseConfigurationError)
})
