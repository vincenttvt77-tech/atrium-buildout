import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, cp, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { hashPassword } from '../../src/ops/accounts.ts'
import { mintUserSession } from '../../src/auth/session.ts'
import { openLocalDatabase, localImportStep, LOCAL_ORGANIZATION, LOCAL_PROPERTY, LOCAL_USER, LOCAL_SOURCE_AT } from '../../scripts/lib/local-database.mjs'
import { localDemoOperations } from '../../scripts/lib/local-demo-operations.mjs'
import { TEST_AUTH_ORIGIN, verifyMfaSession } from '../helpers/mfa-session.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const originalEnvironment = { ...process.env }
const originalFetch = globalThis.fetch
const password = randomBytes(24).toString('base64url')
const sessionSecret = randomBytes(36).toString('base64url')
let root, database, originalHash, rotatedPassword, originalConfig, fetchAttempts = 0

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'atrium-local-preview-test-'))
  await cp(join(repository, 'data'), join(root, 'data'), { recursive: true })
  originalHash = await hashPassword(password)
  await writeFile(join(root, '.env.demo-account.json'), JSON.stringify({ sessionSecret, accounts: [{
    username: 'larkin', passwordHash: originalHash, tenantId: 'demo-larkin', displayName: 'Synthetic Local Larkin', assistantIds: ['demo-larkin-assistant'],
  }] }), { mode: 0o600 })
  for (const key of ['OPS_ACCOUNTS_JSON', 'OPS_SESSION_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VAPI_API_KEY',
    'VAPI_PRIVATE_KEY', 'VAPI_WEBHOOK_SECRET', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL', 'RESEND_API_KEY', 'PGOPTIONS', 'PGPASSWORD']) {
    process.env[key] = 'synthetic-external-setting-must-be-ignored'
  }
  delete process.env.VERCEL; delete process.env.ATRIUM_SIMULATION; process.env.NODE_ENV = 'test'
  globalThis.fetch = async () => { fetchAttempts++; throw new Error('Unexpected external request during local bootstrap') }
  try { database = await openLocalDatabase({ root, authOrigin: TEST_AUTH_ORIGIN }) }
  catch (error) { throw new Error(error.cause?.message ?? error.message) }
})
after(async () => {
  await database?.close()
  if (root) await rm(root, { recursive: true, force: true })
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
})

test('local bootstrap imports the exact private account once with private files and separate local roles', async () => {
  assert.equal(database.imported, true)
  assert.equal(database.runtime.sessionSecret, sessionSecret)
  assert.equal(database.initialPassword, undefined)
  assert.equal((await stat(database.directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(database.directory, 'config.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(database.directory, 'data'))).mode & 0o777, 0o700)
  originalConfig = await readFile(join(database.directory, 'config.json'), 'utf8')
  const saved = JSON.parse(originalConfig)
  assert.equal(saved.sessionSecret, sessionSecret)
  assert.equal(new Set([saved.adminPassword, saved.appPassword, saved.authPassword]).size, 3)
  const stored = await database.admin.query('SELECT password_hash FROM atrium.user_credentials WHERE user_id=$1', [LOCAL_USER])
  assert.equal(stored.rows[0].password_hash, originalHash)
  const verified = await database.runtime.authorization.authenticatePassword('larkin', password)
  assert.ok(verified)
  const principal = await database.runtime.sessions.start(verified, { label: 'Synthetic local-preview session' })
  await verifyMfaSession(database.runtime, principal, password)
  const token = mintUserSession(principal, new Date(), sessionSecret)
  assert.match(token, /^a4\./)
  assert.ok(await database.runtime.authenticate({ cookie: `atrium_ops=${token}` }, new Date()))
  const properties = await database.runtime.authorization.listAuthorizedProperties(principal)
  assert.deepEqual(properties.map(property => [property.organizationId, property.id]), [[LOCAL_ORGANIZATION, LOCAL_PROPERTY]])
  const resolved = await database.runtime.loadUserProperty(principal, { organizationId: LOCAL_ORGANIZATION, propertyId: LOCAL_PROPERTY }, 'read')
  assert.equal(resolved.snapshot.inventoryReadAt, LOCAL_SOURCE_AT)
  assert.equal(resolved.snapshot.publishedAt, LOCAL_SOURCE_AT)
  assert.equal(resolved.snapshot.jurisdiction, 'NY')
  assert.equal(resolved.snapshot.timeZone, 'America/New_York')
  assert.ok(resolved.snapshot.inventory.units.length > 0)
  assert.equal(resolved.tourSettings.capacity, 2)
  assert.match(resolved.snapshot.inventorySource, /fictional.*no PMS/i)
  assert.equal(resolved.snapshot.inventory.provenance.sourceMode, 'demo')
  assert.equal(resolved.snapshot.inventory.provenance.catalogAsOf, LOCAL_SOURCE_AT)
  assert.equal(database.configurationPublished, false)
  assert.equal(database.configurationVersion, 1)
  assert.deepEqual((await database.admin.query('SHOW listen_addresses')).rows[0], { listen_addresses: '127.0.0.1' })
  const roles = await database.admin.query("SELECT rolname,rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname IN ('atrium_app','atrium_authenticator') ORDER BY rolname")
  assert.ok(roles.rows.every(role => !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole))
  for (const key of ['OPS_ACCOUNTS_JSON', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY',
    'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL', 'RESEND_API_KEY', 'PGOPTIONS', 'PGPASSWORD']) assert.equal(process.env[key], undefined)
  assert.equal(fetchAttempts, 0)
})

test('a second preview cannot concurrently open the same persistent data directory', async () => {
  await assert.rejects(openLocalDatabase({ root, authOrigin: TEST_AUTH_ORIGIN }), /already open/)
  assert.equal((await database.admin.query('SELECT 1 AS alive')).rows[0].alive, 1)
})

test('local template operations retain channel audit and never invent a human MFA session', async () => {
  const resolved = await database.runtime.loadChannel('vapi', 'demo-larkin-assistant')
  const stateBefore = await database.admin.query('SELECT count(*)::int n FROM atrium.mfa_factors')
  const sessionsBefore = await database.admin.query('SELECT count(*)::int n FROM atrium.user_sessions')
  const operate = localDemoOperations(resolved, { organizationId: LOCAL_ORGANIZATION, propertyId: LOCAL_PROPERTY })
  assert.throws(() => localDemoOperations(resolved, { organizationId: 'other-organization', propertyId: LOCAL_PROPERTY }), /exact fictional/)
  assert.throws(() => localDemoOperations({ ...resolved, scope: { ...resolved.scope, actor: { kind: 'user' } } },
    { organizationId: LOCAL_ORGANIZATION, propertyId: LOCAL_PROPERTY }), /exact fictional/)
  await assert.rejects(operate('POST', '/api/leads', { action: 'clear_leads' }), /Unsupported/)
  const calendar = await operate('GET', '/api/calendar')
  assert.ok(calendar.slots.length > 0)
  const target = calendar.slots[0].slotId
  await operate('POST', '/api/calendar', { action: 'block', target, reason: 'Synthetic import block' })
  assert.ok((await resolved.calendarStore.read()).blocks.some(block => block.target === target))
  await assert.rejects(operate('POST', '/api/calendar', { action: 'block', target }), /already exists/)
  await resolved.documents.set('lead:+15550000077', { phone: '+15550000077', notes: [] })
  const noted = await operate('POST', '/api/leads', { action: 'note', phone: '+15550000077', text: 'Synthetic template note' })
  assert.equal(noted.profile.notes.length, 1)
  await resolved.documents.set('followup:fu-template', { id: 'fu-template', superseded: true, status: 'done' })
  await assert.rejects(operate('POST', '/api/leads', { action: 'followup_status', id: 'fu-template', status: 'scheduled' }), /superseded/)
  assert.deepEqual(await database.admin.query('SELECT count(*)::int n FROM atrium.mfa_factors').then(result => result.rows), stateBefore.rows)
  assert.deepEqual(await database.admin.query('SELECT count(*)::int n FROM atrium.user_sessions').then(result => result.rows), sessionsBefore.rows)
  const audit = await database.admin.query('SELECT actor_user_id,actor_channel_binding_id FROM atrium.audit_events WHERE record_key=$1',
    ['sha256:' + createHash('sha256').update('lead:+15550000077').digest('hex')])
  assert.ok(audit.rows.length >= 2)
  assert.ok(audit.rows.every(row => row.actor_user_id === null && row.actor_channel_binding_id === 'channel-demo-larkin'))
})

test('stop and reopen preserve password rotation, grants, settings, records and original source dates', async () => {
  const principal = await database.runtime.authorization.authenticatePassword('larkin', password)
  const resolved = await database.runtime.loadUserProperty(principal, { organizationId: LOCAL_ORGANIZATION, propertyId: LOCAL_PROPERTY }, 'configure')
  await resolved.documents.set('local-restart-proof', { note: 'Staff changes must remain', at: LOCAL_SOURCE_AT })
  await resolved.calendarStore.mutate(state => ({ ...state, settings: { ...resolved.tourSettings, capacity: 3 }, settingsRevision: 1 }))
  rotatedPassword = randomBytes(24).toString('base64url')
  await database.admin.query('UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id=$2', [await hashPassword(rotatedPassword), LOCAL_USER])
  await database.admin.query("UPDATE atrium.property_grants SET status='revoked',permission_version=permission_version+1 WHERE membership_id='member-demo-larkin'")
  // A changed old file must never silently restore its credential or secret on restart.
  await writeFile(join(root, '.env.demo-account.json'), JSON.stringify({ sessionSecret: 'changed-local-file-secret-that-must-not-be-imported', accounts: [] }), { mode: 0o600 })
  const directory = database.directory
  await database.close(); database = null
  assert.ok(await stat(join(directory, 'data', 'PG_VERSION')))
  database = await openLocalDatabase({ root, authOrigin: TEST_AUTH_ORIGIN })
  assert.equal(database.imported, false)
  assert.deepEqual(database.migrations, [])
  assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), originalConfig)
  assert.equal(await database.runtime.authorization.authenticatePassword('larkin', password), null)
  const current = await database.runtime.authorization.authenticatePassword('larkin', rotatedPassword)
  assert.ok(current)
  assert.deepEqual(await database.runtime.authorization.listAuthorizedProperties(current), [])
  assert.equal((await database.admin.query('SELECT count(*)::int AS count FROM atrium.users')).rows[0].count, 1)
  assert.equal((await database.admin.query('SELECT count(*)::int AS count FROM atrium.memberships')).rows[0].count, 1)
  await database.admin.query("UPDATE atrium.property_grants SET status='active',permission_version=permission_version+1 WHERE membership_id='member-demo-larkin'")
  const persisted = await database.runtime.loadUserProperty(current, { organizationId: LOCAL_ORGANIZATION, propertyId: LOCAL_PROPERTY }, 'read')
  assert.deepEqual(await persisted.documents.get('local-restart-proof'), { note: 'Staff changes must remain', at: LOCAL_SOURCE_AT })
  assert.equal((await persisted.calendarStore.read()).settings.capacity, 3)
  assert.equal((await persisted.calendarStore.read()).settingsRevision, 1)
  assert.equal(persisted.snapshot.inventoryReadAt, LOCAL_SOURCE_AT)
  assert.equal(persisted.snapshot.publishedAt, LOCAL_SOURCE_AT)
  assert.equal(fetchAttempts, 0)
})

test('fixture checkpoints resume completed steps and preserve uncertain partial work without replaying it', async () => {
  let runs = 0
  await localImportStep(database, 'test-fixture-progress', 'completed-call', async () => { runs++; return { callId: 'synthetic-call-1' } })
  await database.close(); database = await openLocalDatabase({ root, authOrigin: TEST_AUTH_ORIGIN })
  assert.deepEqual(await localImportStep(database, 'test-fixture-progress', 'completed-call', async () => { runs++; }), { callId: 'synthetic-call-1' })
  assert.equal(runs, 1)
  await localImportStep(database, 'test-fixture-progress', 'next-call', async () => { runs++; return 'next checkpoint' })
  assert.equal(runs, 2)
  await assert.rejects(localImportStep(database, 'test-fixture-progress', 'uncertain-call', async () => {
    await database.writeImport('test-partial-result', { preserved: true })
    throw new Error('Simulated interruption after an operational write')
  }), /Simulated interruption/)
  await database.close(); database = await openLocalDatabase({ root, authOrigin: TEST_AUTH_ORIGIN })
  await assert.rejects(localImportStep(database, 'test-fixture-progress', 'uncertain-call', async () => { runs++ }), /Inspect that step before resuming/)
  assert.equal(runs, 2)
  assert.deepEqual(await database.readImport('test-partial-result'), { preserved: true })
})

test('invalid persistent configuration is preserved and never replaced with external configuration', async () => {
  const separate = join(root, 'invalid-state')
  await mkdir(separate, { mode: 0o700 })
  const malformed = '{"version":1,"adminPassword":"invalid"}'
  await writeFile(join(separate, 'config.json'), malformed, { mode: 0o600 })
  process.env.ATRIUM_DATABASE_URL = 'postgres://synthetic:synthetic@unreachable.invalid/not-used'
  await assert.rejects(openLocalDatabase({ root, directory: separate }), /files were preserved/)
  assert.equal(await readFile(join(separate, 'config.json'), 'utf8'), malformed)
  assert.equal(fetchAttempts, 0)
})
