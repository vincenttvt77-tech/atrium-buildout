import { test } from 'node:test'
import assert from 'node:assert/strict'
import { databasePoolConfig, DatabaseConfigurationError, DatabaseConnection } from './connection.ts'

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

test('a failed transaction-local safety configuration refuses identity lookup and work, then rolls back', async () => {
  const connection = new DatabaseConnection({}, 'atrium_app')
  const queries: string[] = []
  const released: boolean[] = []
  let worked = false
  const failure = new Error('Synthetic setting refusal')
  const client = { async query(sql: string) {
    queries.push(sql)
    if (sql.includes("set_config('statement_timeout'")) throw failure
    assert.ok(sql.startsWith('BEGIN') || sql === 'ROLLBACK', 'Identity/application SQL must not run without the safety limits')
    return { command: sql, rows: [] }
  }, release(discard: boolean) { released.push(discard) } }
  connection.pool.connect = (async () => client) as any
  try {
    await assert.rejects(connection.transaction({}, async () => { worked = true }), error => error === failure)
    assert.equal(worked, false)
    assert.ok(queries[0]?.startsWith('BEGIN'))
    assert.equal(queries.at(-1), 'ROLLBACK')
    assert.deepEqual(released, [false])
  } finally { await connection.close() }
})

test('failed safety configuration discards a connection whose rollback also fails', async () => {
  const connection = new DatabaseConnection({}, 'atrium_authenticator')
  const failure = new Error('Synthetic unavailable backend')
  let discarded = false, worked = false
  connection.pool.connect = (async () => ({
    async query(sql: string) { if (!sql.startsWith('BEGIN')) throw failure; return { rows: [] } },
    release(value: boolean) { discarded = value },
  })) as any
  try {
    await assert.rejects(connection.transaction({}, async () => { worked = true }), error => error === failure)
    assert.equal(worked, false)
    assert.equal(discarded, true)
  } finally { await connection.close() }
})
