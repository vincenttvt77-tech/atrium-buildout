import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { hashPassword, readAccountsConfig } from '../../src/ops/accounts.ts'
import { defaultSettings, validateSettings } from '../../src/calendar/settings.ts'
import { applyDatabaseMigrations } from './database-migrations.mjs'
import { validateInventoryProvenance } from '../../src/inventory/source.ts'

export const LOCAL_ORGANIZATION = 'org-demo-larkin'
export const LOCAL_PROPERTY = 'prop-demo'
export const LOCAL_USER = 'user-demo-larkin'
export const LOCAL_ASSISTANT = 'demo-larkin-assistant'
// This is bundled fictional source data, not a new PMS observation on each launch.
export const LOCAL_SOURCE_AT = '2026-09-01T00:00:00.000Z'
const LOCAL_INVENTORY_SOURCE = 'Bundled fictional demo inventory; no PMS connection'
const IMPORT_ID = 'legacy-demo-larkin-v1'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Local preview is an explicit environment boundary, never a deployment configuration. */
export function prepareLocalPreviewEnvironment(env = process.env) {
  if (env.VERCEL || env.NODE_ENV === 'production' || env.ATRIUM_SIMULATION) throw new Error('The local preview cannot run in hosted or simulation mode.')
  for (const name of Object.keys(env)) {
    if (/^(?:OPS_|DASHBOARD_TOKEN$|KV_|UPSTASH_|VAPI_|RESEND_|SMTP_|EMAIL_|PG[A-Z_]*$|ATRIUM_(?:DATABASE|AUTH_DATABASE|RUNTIME))/.test(name)) delete env[name]
  }
  env.ATRIUM_RUNTIME_MODE = 'postgres'
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local database directory must be a private directory, not a link.')
  await chmod(path, 0o700)
}
async function readPrivateJson(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Local configuration must be a regular private file.')
  await chmod(path, 0o600)
  return JSON.parse(await readFile(path, 'utf8'))
}
const secret = () => randomBytes(36).toString('base64url')

async function localAccount(root) {
  const path = join(root, '.env.demo-account.json')
  let saved, initialPassword
  try { saved = await readPrivateJson(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('The private local demo account file is invalid; it was not replaced.')
    initialPassword = secret()
    saved = { sessionSecret: secret(), accounts: [{ username: 'larkin', tenantId: 'demo-larkin', displayName: 'The Larkin · Demo',
      passwordHash: await hashPassword(initialPassword), assistantIds: [LOCAL_ASSISTANT] }] }
    await writeFile(path, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  const parsed = readAccountsConfig({ OPS_ACCOUNTS_JSON: JSON.stringify(saved.accounts), OPS_SESSION_SECRET: saved.sessionSecret })
  const account = parsed.mode === 'accounts' && parsed.accounts.find(account => account.username === 'larkin' && account.tenantId === 'demo-larkin')
  if (!account) throw new Error('The private local file needs the existing larkin account in demo-larkin; no other account is imported.')
  return { account, sessionSecret: saved.sessionSecret, initialPassword }
}

async function acquireLock(directory) {
  const path = join(directory, 'preview.lock'), token = secret()
  const write = () => writeFile(path, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 })
  try { await write() }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const current = await readPrivateJson(path)
    if (!Number.isSafeInteger(current.pid) || current.pid < 1) throw new Error('Local database lock needs manual inspection.')
    try { process.kill(current.pid, 0); throw new Error('This local database is already open in another preview. Stop that preview before reopening it.') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
    await unlink(path)
    await write()
  }
  return async () => {
    try { if ((await readPrivateJson(path)).token === token) await unlink(path) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
async function unusedPort() {
  const server = createServer()
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const port = server.address().port
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
  return port
}

async function bootstrap(admin, root) {
  await admin.query('BEGIN')
  try {
    await admin.query('CREATE SCHEMA IF NOT EXISTS atrium_local AUTHORIZATION atrium_admin')
    await admin.query('REVOKE ALL ON SCHEMA atrium_local FROM PUBLIC')
    await admin.query('CREATE TABLE IF NOT EXISTS atrium_local.imports (id text PRIMARY KEY, value jsonb NOT NULL)')
    await admin.query('ALTER TABLE atrium_local.imports OWNER TO atrium_admin')
    await admin.query('REVOKE ALL ON atrium_local.imports FROM PUBLIC')
    const prior = await admin.query('SELECT value FROM atrium_local.imports WHERE id=$1', [IMPORT_ID])
    if (prior.rows.length) { await admin.query('COMMIT'); return { imported: false } }
    const { account } = await localAccount(root)
    const [property, inventory, floorplans, knowledge, rawProvenance] = await Promise.all(['property', 'inventory', 'floorplans', 'knowledge', 'inventory-source']
      .map(name => readFile(join(root, 'data', `${name}.json`), 'utf8').then(JSON.parse)))
    if (property.id !== LOCAL_PROPERTY || property.timeZone !== 'America/New_York') throw new Error('The local import requires the explicit fictional Larkin property and New York timezone.')
    const tourSettings = validateSettings(defaultSettings())
    const inventoryProvenance = validateInventoryProvenance(rawProvenance, new Date(LOCAL_SOURCE_AT))
    if (inventoryProvenance?.sourceMode !== 'demo') throw new Error('The local fixture requires explicitly fictional demo inventory.')
    const configuration = { property: { ...property, organizationId: LOCAL_ORGANIZATION, jurisdiction: 'NY', tourSettings }, inventory, floorplans, knowledge, inventoryProvenance }
    await admin.query("INSERT INTO atrium.organizations(id,name,status) VALUES($1,'The Larkin · Local Demo','active')", [LOCAL_ORGANIZATION])
    await admin.query("INSERT INTO atrium.properties(id,organization_id,name,time_zone,status) VALUES($1,$2,'The Larkin · Local Demo','America/New_York','active')", [LOCAL_PROPERTY, LOCAL_ORGANIZATION])
    await admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1,$2,$3,'active')", [LOCAL_USER, account.username, account.displayName])
    await admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)', [LOCAL_USER, account.passwordHash])
    await admin.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,status,access) VALUES('member-demo-larkin',$1,$2,'owner','active','properties')", [LOCAL_USER, LOCAL_ORGANIZATION])
    await admin.query("INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status) VALUES('member-demo-larkin',$1,$2,'active')", [LOCAL_ORGANIZATION, LOCAL_PROPERTY])
    await admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
      VALUES('channel-demo-larkin','vapi',$1,$2,$3,'active',ARRAY['read','operate'])`, [LOCAL_ASSISTANT, LOCAL_ORGANIZATION, LOCAL_PROPERTY])
    await admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,schema_version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,1,'published',$3,$4,'Bundled fictional demo inventory; no PMS connection',$4)`,
    [LOCAL_ORGANIZATION, LOCAL_PROPERTY, JSON.stringify(configuration), LOCAL_SOURCE_AT])
    await admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1 AND organization_id=$2', [LOCAL_PROPERTY, LOCAL_ORGANIZATION])
    await admin.query('INSERT INTO atrium_local.imports(id,value) VALUES($1,$2)', [IMPORT_ID, JSON.stringify({
      importedAt: new Date().toISOString(), oldTenantId: 'demo-larkin', organizationId: LOCAL_ORGANIZATION, propertyId: LOCAL_PROPERTY,
      synthetic: true, source: 'Bundled fictional demo property; no PMS connection',
    })])
    const commit = await admin.query('COMMIT')
    if (commit.command !== 'COMMIT') throw new Error('Local import did not commit.')
    return { imported: true }
  } catch (error) { await admin.query('ROLLBACK'); throw error }
}

/** One local upgrade: append source metadata without replacing any existing content. */
export async function publishLocalDemoProvenance(admin, root = ROOT) {
  const rawProvenance = JSON.parse(await readFile(join(root, 'data', 'inventory-source.json'), 'utf8'))
  const expected = validateInventoryProvenance(rawProvenance, new Date(LOCAL_SOURCE_AT))
  if (expected?.sourceMode !== 'demo') throw new Error('Local inventory requires explicit fictional demo metadata.')
  await admin.query('BEGIN')
  try {
    const marker = (await admin.query('SELECT value FROM atrium_local.imports WHERE id=$1', [IMPORT_ID])).rows[0]?.value
    if (marker?.organizationId !== LOCAL_ORGANIZATION || marker?.propertyId !== LOCAL_PROPERTY || marker?.synthetic !== true) {
      throw new Error('Local inventory source upgrade requires the original fictional Larkin import.')
    }
    const row = (await admin.query(`SELECT p.time_zone, p.status AS property_status,
        c.version, c.schema_version, c.configuration, c.inventory_read_at, c.inventory_source
      FROM atrium.properties p JOIN atrium.property_configurations c
        ON c.organization_id=p.organization_id AND c.property_id=p.id AND c.version=p.published_configuration_version
      WHERE p.organization_id=$1 AND p.id=$2 AND c.status='published' FOR UPDATE OF p`,
    [LOCAL_ORGANIZATION, LOCAL_PROPERTY])).rows[0]
    const property = row?.configuration?.property
    if (!row || row.schema_version !== 1 || row.time_zone !== 'America/New_York' || row.property_status !== 'active'
      || row.inventory_read_at?.toISOString() !== LOCAL_SOURCE_AT || row.inventory_source !== LOCAL_INVENTORY_SOURCE
      || property?.id !== LOCAL_PROPERTY || property?.organizationId !== LOCAL_ORGANIZATION
      || typeof property.sourceNote !== 'string' || !property.sourceNote.startsWith('DEMO PROPERTY — FICTIONAL.')
      || !property.sourceNote.includes('The Larkin does not exist.')) {
      throw new Error('The current property source differs from the original fictional local fixture; it was not changed.')
    }
    if (Object.hasOwn(row.configuration, 'inventoryProvenance')) {
      if (!isDeepStrictEqual(row.configuration.inventoryProvenance, expected)) {
        throw new Error('The existing inventory provenance differs; it was not overwritten.')
      }
      await admin.query('COMMIT')
      return { configurationPublished: false, configurationVersion: Number(row.version) }
    }
    const highest = Number((await admin.query('SELECT max(version) AS version FROM atrium.property_configurations WHERE organization_id=$1 AND property_id=$2',
      [LOCAL_ORGANIZATION, LOCAL_PROPERTY])).rows[0].version)
    if (!Number.isSafeInteger(highest) || highest < 1 || highest >= Number.MAX_SAFE_INTEGER) throw new Error('Local configuration version needs manual inspection.')
    const next = highest + 1
    const configuration = { ...row.configuration, inventoryProvenance: expected }
    await admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,schema_version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,$3,$4,'published',$5,$6,$7,clock_timestamp())`,
    [LOCAL_ORGANIZATION, LOCAL_PROPERTY, next, row.schema_version, JSON.stringify(configuration), row.inventory_read_at, row.inventory_source])
    await admin.query('UPDATE atrium.properties SET published_configuration_version=$3 WHERE organization_id=$1 AND id=$2',
      [LOCAL_ORGANIZATION, LOCAL_PROPERTY, next])
    const commit = await admin.query('COMMIT')
    if (commit.command !== 'COMMIT') throw new Error('Local inventory source publication did not commit.')
    return { configurationPublished: true, configurationVersion: next }
  } catch (error) { await admin.query('ROLLBACK'); throw error }
}

/** Persistent loopback database owned by this preview; close never removes its data. */
export async function openLocalDatabase({ root = ROOT, directory = join(root, '.atrium-local') } = {}) {
  prepareLocalPreviewEnvironment()
  root = resolve(root); directory = resolve(directory)
  await privateDirectory(directory)
  const release = await acquireLock(directory)
  let postgres, admin, app, auth, started = false, initialPassword
  try {
    const configPath = join(directory, 'config.json')
    let config
    try { config = await readPrivateJson(configPath) }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Private local database configuration is invalid; it was not replaced.')
      const source = await localAccount(root)
      initialPassword = source.initialPassword
      config = { version: 1, adminPassword: secret(), appPassword: secret(), authPassword: secret(),
        sessionSecret: source.sessionSecret, webhookSecret: secret() }
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    }
    if (config.version !== 1 || ['adminPassword', 'appPassword', 'authPassword', 'sessionSecret', 'webhookSecret']
      .some(key => typeof config[key] !== 'string' || config[key].trim().length < 32)) throw new Error('Private local database configuration is invalid; it was not replaced.')
    const port = await unusedPort()
    postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'data'), port, user: 'postgres', password: config.adminPassword,
      authMethod: 'scram-sha-256', persistent: true, createPostgresUser: false,
      postgresFlags: ['-h', '127.0.0.1', '-k', '', '-c', 'max_connections=30'], onLog: () => {}, onError: () => {} })
    let initialized = true
    try { await lstat(join(directory, 'data', 'PG_VERSION')) } catch (error) { if (error.code !== 'ENOENT') throw error; initialized = false }
    if (!initialized) {
      // embedded-postgres uses a temporary password file; a private umask protects it too.
      const previousMask = process.umask(0o077)
      try { await postgres.initialise() } finally { process.umask(previousMask) }
    }
    await postgres.start(); started = true
    admin = postgres.getPgClient('postgres', '127.0.0.1'); await admin.connect()
    await admin.query('BEGIN')
    try {
      for (const [role, password] of [['atrium_admin', null], ['atrium_app', config.appPassword], ['atrium_authenticator', config.authPassword]]) {
        const exists = await admin.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1', [role])
        if (!exists.rows.length) await admin.query(`CREATE ROLE ${role} ${password ? `LOGIN PASSWORD ${pg.escapeLiteral(password)}` : 'NOLOGIN'} NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`)
      }
      await admin.query('COMMIT')
    } catch (error) { await admin.query('ROLLBACK'); throw error }
    const migrations = await applyDatabaseMigrations(admin)
    const imported = await bootstrap(admin, root)
    const publication = await publishLocalDemoProvenance(admin, root)
    const connection = (user, password) => ({ host: '127.0.0.1', port, user, password, database: 'postgres', ssl: false,
      max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
      options: '-c search_path=pg_catalog -c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000' })
    app = new DatabaseConnection(connection('atrium_app', config.appPassword), 'atrium_app')
    auth = new DatabaseConnection(connection('atrium_authenticator', config.authPassword), 'atrium_authenticator')
    const runtime = createDatabaseRuntime({ app, auth, sessionSecret: config.sessionSecret })
    process.env.OPS_SESSION_SECRET = config.sessionSecret
    process.env.VAPI_WEBHOOK_SECRET = config.webhookSecret
    let closed = false
    return { runtime, admin, directory, port, migrations, ...imported, ...publication, initialPassword,
      async readImport(id) { return (await admin.query('SELECT value FROM atrium_local.imports WHERE id=$1', [id])).rows[0]?.value ?? null },
      async writeImport(id, value) { await admin.query('INSERT INTO atrium_local.imports(id,value) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value', [id, JSON.stringify(value)]) },
      async close() {
        if (closed) return; closed = true
        try { await app.close(); await auth.close(); await admin.end(); await postgres.stop() } finally { await release() }
      },
    }
  } catch (error) {
    try { await app?.close(); await auth?.close(); await admin?.end(); if (started) await postgres.stop() } finally { await release() }
    throw new Error('The persistent local database could not open. Its files were preserved; inspect local configuration and migration status.', { cause: error })
  }
}

/** Resume only at a known committed checkpoint; never replay an uncertain mutation. */
export async function localImportStep(database, importId, stepId, work) {
  const state = await database.readImport(importId) ?? { completed: {} }
  if (Object.hasOwn(state.completed, stepId)) return state.completed[stepId]
  if (state.inFlight) throw new Error(`Local fixture import stopped during ${state.inFlight}. Inspect that step before resuming; existing data was preserved.`)
  await database.writeImport(importId, { ...state, inFlight: stepId })
  const result = await work()
  const value = result === undefined ? null : result
  await database.writeImport(importId, { completed: { ...state.completed, [stepId]: value } })
  return value
}
