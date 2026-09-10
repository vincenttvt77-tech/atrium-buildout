import { TEST_AUTH_ORIGIN, verifyMfaSession } from '../helpers/mfa-session.mjs'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService, mintUserSession, hashPassword } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'

let db, repository, authorization, credentials, runtime
const sessionSecret = 'synthetic-postgres-session-test-secret-not-a-live-credential'
before(async () => {
  db = await createFoundationTestDatabase()
  credentials = await seedFoundationTestDatabase(db.admin)
  repository = new PgAuthorizationRepository(db.auth)
  authorization = createAuthorizationService(repository)
  runtime = createDatabaseRuntime({ authOrigin: TEST_AUTH_ORIGIN, app: db.app, auth: db.auth, sessionSecret })
})
after(async () => { if (db) await db.close() })
async function login(username) {
  const principal = await authorization.authenticatePassword(username, credentials.password)
  assert.ok(principal, `synthetic ${username} should authenticate`)
  return principal
}
const contextFor = principal => Object.freeze({ kind: 'user', userId: principal.userId, credentialVersion: principal.credentialVersion })

test('credential reads are exact, use the authenticator role, and do not survive transaction context reset', async () => {
  assert.equal(await repository.findCredentialByUsername('missing-user'), null)
  assert.equal(await repository.findCredentialByUsername('OWNER-A'), null)
  const credential = await repository.findCredentialByUsername('owner-a')
  assert.equal(credential.userId, 'owner-a')
  assert.equal(Number.isSafeInteger(credential.credentialVersion), true)
  assert.ok(credential.passwordHash.startsWith('scrypt$'))
  const selected = await db.auth.transaction({ loginUsername: 'owner-a' }, client => client.query('SELECT user_id FROM atrium.user_credentials ORDER BY user_id'))
  assert.deepEqual(selected.rows.map(row => row.user_id), ['owner-a'])
  const empty = await db.auth.transaction({}, client => client.query('SELECT user_id FROM atrium.user_credentials'))
  assert.deepEqual(empty.rows, [])
  const ownUser = await db.auth.transaction({ actorUserId: 'owner-b' }, client => client.query('SELECT id FROM atrium.users'))
  assert.deepEqual(ownUser.rows.map(row => row.id), ['owner-b'])
  await assert.rejects(db.app.transaction({}, client => client.query('SELECT user_id FROM atrium.user_credentials')), { code: '42501' })
  assert.throws(() => new PgAuthorizationRepository(db.app), /authenticator database role/)
})

test('an aborted transaction cannot report success when its callback handled a SQL error', async () => {
  let errorHandled = false
  await assert.rejects(db.auth.transaction({}, async client => {
    try { await client.query('SELECT 1 / 0') }
    catch (error) { assert.equal(error.code, '22012'); errorHandled = true }
    return 'must-not-be-reported-as-committed'
  }))
  assert.equal(errorHandled, true, 'exercise a real aborted transaction, not an earlier connection failure')
})

test('database-backed property lookup respects every role and explicit property grants', async () => {
  for (const [username, expected] of [
    ['owner-a', ['property-a1', 'property-a2']], ['owner-b', ['property-b1', 'property-b2']],
    ['viewer-a', ['property-a1', 'property-a2']], ['staff-a', ['property-a1']],
  ]) {
    const principal = await login(username)
    assert.deepEqual((await authorization.listAuthorizedProperties(principal)).map(property => property.id), expected)
  }
  const viewer = await login('viewer-a'), staff = await login('staff-a')
  await assert.rejects(authorization.authorizeProperty(viewer, 'property-a1', 'operate'), { code: 'forbidden' })
  assert.equal(await repository.getProperty('property-a2', contextFor(staff)), null, 'RLS itself hides a property lacking a grant')
  assert.equal(await repository.getProperty('property-b1', contextFor(staff)), null)
  await assert.rejects(repository.getMembership('owner-b', 'organization-b', contextFor(staff)), { code: 'forbidden' })
  const anonymous = await db.auth.transaction({}, client => client.query('SELECT id FROM atrium.properties'))
  assert.deepEqual(anonymous.rows, [])
})

test('concurrent lookups on reused connections keep actor and organization contexts separate', async () => {
  const [ownerA, ownerB] = await Promise.all([login('owner-a'), login('owner-b')])
  const a = contextFor(ownerA), b = contextFor(ownerB)
  await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const context = index % 2 ? a : b
    const allowed = index % 2 ? 'property-a1' : 'property-b1'
    const denied = index % 2 ? 'property-b1' : 'property-a1'
    assert.equal((await repository.getProperty(allowed, context))?.id, allowed)
    assert.equal(await repository.getProperty(denied, context), null)
  }))
  const afterReuse = await db.auth.transaction({}, client => client.query('SELECT id FROM atrium.properties'))
  assert.deepEqual(afterReuse.rows, [])
})

test('real password rotation increments credential version and invalidates registered sessions', async () => {
  const principal = await runtime.sessions.start(await login('owner-a'), { label: 'Synthetic rotation session' })
  await verifyMfaSession(runtime, principal, credentials.password)
  const now = new Date()
  const session = mintUserSession(principal, now, sessionSecret)
  const replacement = randomBytes(24).toString('base64url')
  const replacementHash = await hashPassword(replacement)
  try {
    await db.admin.query('UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id=$2', [replacementHash, principal.userId])
    const current = await repository.getUser(principal.userId)
    assert.equal(current.credentialVersion, principal.credentialVersion + 1, 'database trigger owns rotation versioning')
    assert.equal(await authorization.authenticateSession(session, now, sessionSecret), null)
    assert.equal(await authorization.authenticatePassword('owner-a', credentials.password), null)
    assert.ok(await authorization.authenticatePassword('owner-a', replacement))
    await assert.rejects(authorization.authorizeProperty(principal, 'property-a1', 'read'), { code: 'unauthenticated' })
  } finally {
    await db.admin.query('UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id=$2', [await hashPassword(credentials.password), principal.userId])
  }
})

test('deactivating a user blocks an already-issued session and credential lookup', async () => {
  const principal = await runtime.sessions.start(await login('owner-b'), { label: 'Synthetic deactivation session' })
  await verifyMfaSession(runtime, principal, credentials.password)
  const now = new Date()
  const session = mintUserSession(principal, now, sessionSecret)
  try {
    await db.admin.query("UPDATE atrium.users SET status='inactive' WHERE id=$1", [principal.userId])
    assert.equal(await authorization.authenticateSession(session, now, sessionSecret), null)
    assert.equal(await repository.findCredentialByUsername('owner-b'), null)
    assert.equal(await authorization.authenticatePassword('owner-b', credentials.password), null)
    assert.equal((await repository.getUser(principal.userId)).status, 'inactive')
    await assert.rejects(authorization.authorizeProperty(principal, 'property-b1', 'read'), { code: 'unauthenticated' })
  } finally { await db.admin.query("UPDATE atrium.users SET status='active' WHERE id=$1", [principal.userId]) }
})

test('channel routing matches the exact binding and honors current status, ownership, and capabilities', async () => {
  const scope = await authorization.authorizeChannel('vapi', 'synthetic-assistant-a', 'operate')
  assert.equal(scope.organizationId, 'organization-a'); assert.equal(scope.propertyId, 'property-a1')
  assert.equal(scope.actor.bindingId, 'channel-a'); assert.equal(scope.actor.bindingVersion, 1)
  await assert.rejects(authorization.authorizeChannel('vapi', 'synthetic-assistant-a', 'configure'), { code: 'forbidden' })
  await assert.rejects(authorization.authorizeChannel('vapi', 'synthetic-assistant-b', 'read'), { code: 'forbidden' })
  await assert.rejects(authorization.authorizeChannel('VAPI', 'synthetic-assistant-a', 'read'), { code: 'forbidden' })
  await assert.rejects(authorization.authorizeChannel('vapi', 'synthetic assistant a', 'read'), { code: 'forbidden' })
  const context = Object.freeze({ kind: 'channel', provider: 'vapi', externalId: 'synthetic-assistant-a' })
  assert.equal(await repository.getProperty('property-a2', context), null)
  assert.equal(await repository.getProperty('property-b1', context), null)
  try {
    await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive',permission_version=permission_version+1 WHERE id='channel-a'")
    await assert.rejects(authorization.authorizeChannel('vapi', 'synthetic-assistant-a', 'read'), { code: 'forbidden' })
  } finally { await db.admin.query("UPDATE atrium.channel_bindings SET status='active',permission_version=permission_version+1 WHERE id='channel-a'") }
})
