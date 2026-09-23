import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import pg from 'pg'
import { createTestPostgres } from '../../scripts/lib/postgres-test.mjs'
import { bootstrapHostedDemoDatabase, HOSTED_DEMO } from '../../scripts/lib/hosted-demo-database.mjs'
import { hashPassword } from '../../src/ops/accounts.ts'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import dashboard from '../../api/dashboard.ts'
import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'

const secret = () => randomBytes(36).toString('base64url')
let db, maintenance, app, auth, runtime, input, password, server, origin, cookie, property
const previousMode = process.env.ATRIUM_RUNTIME_MODE
const selection = `?organizationId=${HOSTED_DEMO.organizationId}&propertyId=${HOSTED_DEMO.propertyId}`
before(async () => {
  db = await createTestPostgres()
  const provisionerPassword = secret()
  await db.admin.query(`CREATE ROLE preview_provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB NOREPLICATION PASSWORD ${pg.escapeLiteral(provisionerPassword)}`)
  await db.admin.query('GRANT CREATE ON DATABASE postgres TO preview_provisioner')
  for (const role of ['anon', 'authenticated', 'service_role']) await db.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  maintenance = new pg.Client(db.connection('preview_provisioner', provisionerPassword))
  await maintenance.connect()
  password = secret()
  input = { client: maintenance, connectionMode: 'session', purpose: 'preview', appPassword: secret(), authPassword: secret(),
    account: { username: 'larkin', displayName: 'Synthetic isolated preview', passwordHash: await hashPassword(password) }, bindings: [] }
})
after(async () => {
  if (server?.listening) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  previousMode === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = previousMode
  await app?.close(); await auth?.close(); await maintenance?.end(); await db?.close()
})

test('preview refuses channel attachments and invalid purpose before touching a database', async () => {
  for (const changed of [{ purpose: null }, { purpose: 'production' }, { purpose: 'demo' },
    { bindings: [{ id: 'channel-should-not-exist', externalId: randomUUID() }] }]) {
    let touched = false
    await assert.rejects(bootstrapHostedDemoDatabase({ ...input, ...changed,
      client: { query() { touched = true; throw new Error('Unexpected IO') } } }), { code: 'invalid_input' })
    assert.equal(touched, false)
  }
})

test('a failed preview seed rolls back the whole workspace and can resume the same manifest', async () => {
  const failingClient = { query(sql, values) {
    if (typeof sql === 'string' && sql.startsWith('INSERT INTO atrium.property_configurations')) throw new Error(input.appPassword)
    return maintenance.query(sql, values)
  } }
  const error = await bootstrapHostedDemoDatabase({ ...input, client: failingClient }).then(() => null, error => error)
  assert.equal(error?.code, 'bootstrap_failed'); assert.equal(error?.stage, 'seed')
  assert.ok(!JSON.stringify(error).includes(input.appPassword))
  for (const table of ['users', 'user_credentials', 'organizations', 'properties', 'memberships', 'property_grants', 'channel_bindings', 'property_configurations']) {
    assert.equal((await db.admin.query(`SELECT count(*)::int n FROM atrium.${table}`)).rows[0].n, 0, table)
  }
  const marker = (await db.admin.query('SELECT manifest,complete FROM atrium_hosted.bootstrap')).rows[0]
  assert.equal(marker.complete, false); assert.equal(marker.manifest.purpose, 'preview')
  assert.deepEqual(marker.manifest.bindings, [])
  const result = await bootstrapHostedDemoDatabase(input)
  assert.equal(result.seeded, true); assert.equal(result.rolesCreated, false)
  assert.equal(result.purpose, 'preview'); assert.deepEqual(result.bindingIds, [])
  assert.equal(result.sourceMode, 'demo')
  const source = (await db.admin.query('SELECT configuration,inventory_read_at FROM atrium.property_configurations')).rows[0]
  assert.equal(source.configuration.inventoryProvenance.fictional, true)
  assert.equal(source.inventory_read_at.toISOString(), '2026-09-01T00:00:00.000Z')
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.channel_bindings')).rows[0].n, 0)
})

test('the actual portal requires saved credentials and a verified passkey before serving the preview', async () => {
  app = new DatabaseConnection(db.connection('atrium_app', input.appPassword), 'atrium_app')
  auth = new DatabaseConnection(db.connection('atrium_authenticator', input.authPassword), 'atrium_authenticator')
  runtime = createDatabaseRuntime({ app, auth, sessionSecret: secret(), authOrigin: TEST_AUTH_ORIGIN })
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      req.body = Buffer.concat(chunks).toString('utf8'); req.atriumRuntime = runtime
      res.status = status => { res.statusCode = status; return res }
      res.send = body => res.end(body)
      res.json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
      await dashboard(req, res)
    } catch { res.statusCode = 500; res.end('Synthetic fixture error') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://127.0.0.1:${server.address().port}`
  const anonymous = await fetch(origin + '/api/dashboard' + selection, { redirect: 'manual' })
  assert.equal(anonymous.status, 401); assert.match(await anonymous.text(), /name="username"/)
  const wrong = await fetch(origin + '/api/dashboard', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'larkin', password: secret() }) })
  assert.equal(wrong.status, 401); await wrong.text()
  const login = await fetch(origin + '/api/dashboard', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'larkin', password }) })
  assert.equal(login.status, 303); cookie = login.headers.get('set-cookie').split(';')[0]; await login.text()
  const pending = await fetch(origin + '/api/dashboard' + selection, { redirect: 'manual', headers: { cookie } })
  assert.equal(pending.status, 303); assert.equal(pending.headers.get('location'), '/api/mfa'); await pending.text()
  await verifyMfaCookie(runtime, cookie, password)
  const page = await fetch(origin + '/api/dashboard' + selection, { redirect: 'manual', headers: { cookie } })
  assert.equal(page.status, 200); assert.match(await page.text(), /window.ATRIUM_RUNTIME_MODE="postgres"/)
  const principal = await runtime.authenticate({ cookie }, new Date())
  property = await runtime.loadUserProperty(principal, HOSTED_DEMO, 'operate')
  assert.deepEqual(property.assistantIds, [])
  await property.documents.set('synthetic-preview-proof', { synthetic: true })
})

test('channel-free preview retains tenant refusals and restricted runtime database roles', async () => {
  for (const selection of ['?organizationId=foreign&propertyId=prop-demo', '?organizationId=org-demo-larkin&propertyId=foreign']) {
    const result = await fetch(origin + '/api/dashboard' + selection, { redirect: 'manual', headers: { cookie } })
    assert.equal(result.status, 403); assert.doesNotMatch(await result.text(), /window.ATRIUM_PROPERTY=/)
  }
  for (const id of [randomUUID(), 'preview-content-validator']) await assert.rejects(runtime.loadChannel('vapi', id), { code: 'forbidden' })
  for (const connection of [app, auth]) await assert.rejects(connection.transaction({}, client => client.query('SELECT * FROM atrium_hosted.bootstrap')), { code: '42501' })
  assert.equal((await app.transaction({}, client => client.query('SELECT count(*)::int n FROM atrium.operational_documents'))).rows[0].n, 0)
  assert.equal((await auth.transaction({}, client => client.query('SELECT count(*)::int n FROM atrium.user_credentials'))).rows[0].n, 0)
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await db.admin.query("SELECT has_schema_privilege($1,'atrium','USAGE') allowed", [role])).rows[0].allowed, false)
  }
})

test('repeating preview setup preserves data, credentials, passkeys and the immutable purpose', async () => {
  const before = (await db.admin.query(`SELECT (SELECT password_hash FROM atrium.user_credentials) hash,
    (SELECT count(*)::int FROM atrium.mfa_factors) factors,(SELECT manifest FROM atrium_hosted.bootstrap) manifest`)).rows[0]
  const result = await bootstrapHostedDemoDatabase({ ...input, appPassword: secret(), authPassword: secret() })
  assert.equal(result.seeded, false); assert.equal(result.credentialsPreserved, true)
  const after = (await db.admin.query(`SELECT (SELECT password_hash FROM atrium.user_credentials) hash,
    (SELECT count(*)::int FROM atrium.mfa_factors) factors,(SELECT manifest FROM atrium_hosted.bootstrap) manifest`)).rows[0]
  assert.deepEqual(after, before)
  assert.deepEqual(await property.documents.get('synthetic-preview-proof'), { synthetic: true })
  await assert.rejects(bootstrapHostedDemoDatabase({ ...input, purpose: 'demo',
    bindings: [{ id: 'channel-not-approved', externalId: randomUUID() }] }), { code: 'existing_state' })
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.channel_bindings')).rows[0].n, 0)
})

test('unexpected channel activation is reported and preserved without claiming preview readiness', async () => {
  await db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
    VALUES('unexpected-channel','vapi','synthetic-only',$1,$2,'active',ARRAY['read','operate'])`, [HOSTED_DEMO.organizationId, HOSTED_DEMO.propertyId])
  const history = (await db.admin.query('SELECT * FROM atrium_migrations.history ORDER BY version')).rows
  await assert.rejects(bootstrapHostedDemoDatabase(input), { code: 'existing_state' })
  assert.deepEqual((await db.admin.query('SELECT * FROM atrium_migrations.history ORDER BY version')).rows, history)
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.channel_bindings')).rows[0].n, 1)
})
