import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, cp, mkdir, readdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createTestPostgres } from '../../scripts/lib/postgres-test.mjs'
import { bootstrapHostedDemoDatabase } from '../../scripts/lib/hosted-demo-database.mjs'
import { hashPassword } from '../../src/ops/accounts.ts'

test('verified eight-migration hosted workspace upgrades without rotating credentials or repairing unsafe state', async () => {
  const db = await createTestPostgres(), oldRoot = await mkdtemp(join(tmpdir(), 'atrium-team-upgrade-'))
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url)), secret = () => randomBytes(36).toString('base64url')
  let maintenance
  try {
    await cp(join(sourceRoot, 'data'), join(oldRoot, 'data'), { recursive: true })
    const oldMigrations = join(oldRoot, 'supabase', 'migrations'); await mkdir(oldMigrations, { recursive: true })
    const files = (await readdir(join(sourceRoot, 'supabase', 'migrations'))).filter(name => name.endsWith('.sql')).sort()
    const addition = files.find(name => name.endsWith('_organization_administration.sql'))
    assert.ok(addition)
    const baseline = files.filter(name => name < addition)
    assert.equal(baseline.length, 8)
    for (const file of baseline) await copyFile(join(sourceRoot, 'supabase', 'migrations', file), join(oldMigrations, file))
    const adminPassword = secret()
    await db.admin.query(`CREATE ROLE hosted_team_provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB NOREPLICATION PASSWORD ${pg.escapeLiteral(adminPassword)}`)
    await db.admin.query('GRANT CREATE ON DATABASE postgres TO hosted_team_provisioner')
    maintenance = new pg.Client(db.connection('hosted_team_provisioner', adminPassword)); await maintenance.connect()
    const input = { client: maintenance, appPassword: secret(), authPassword: secret(), connectionMode: 'session',
      account: { username: 'larkin', displayName: 'Synthetic Upgrade Larkin', passwordHash: await hashPassword(secret()) },
      bindings: [{ id: 'synthetic-upgrade-channel', externalId: randomUUID() }] }
    const original = await bootstrapHostedDemoDatabase({ ...input, root: oldRoot })
    assert.equal(original.migrations.length, 8)
    // The old schema never uses the new executor. Remove only that empty role to
    // reconstruct the actual previous seven-role/eight-migration deployment.
    await db.admin.query('REVOKE atrium_organization_executor FROM atrium_admin')
    await db.admin.query('DROP ROLE atrium_organization_executor')
    const credentials = (await db.admin.query("SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('atrium_app','atrium_authenticator') ORDER BY rolname")).rows
    const users = (await db.admin.query('SELECT * FROM atrium.users')).rows
    const absent = async () => assert.equal((await db.admin.query("SELECT 1 FROM pg_roles WHERE rolname='atrium_organization_executor'")).rowCount, 0)
    await assert.rejects(bootstrapHostedDemoDatabase({ ...input, bindings: [{ ...input.bindings[0], externalId: randomUUID() }] }), { code: 'existing_state' })
    await absent()
    await db.admin.query('GRANT pg_read_all_data TO atrium_app')
    try { await assert.rejects(bootstrapHostedDemoDatabase(input), { code: 'existing_state' }); await absent() }
    finally { await db.admin.query('REVOKE pg_read_all_data FROM atrium_app') }
    await db.admin.query('INSERT INTO atrium_migrations.history(version,checksum) VALUES($1,$2)', [addition, 'synthetic-already-installed'])
    try { await assert.rejects(bootstrapHostedDemoDatabase(input), { code: 'existing_state' }); await absent() }
    finally { await db.admin.query('DELETE FROM atrium_migrations.history WHERE version=$1', [addition]) }
    const upgraded = await bootstrapHostedDemoDatabase({ ...input, appPassword: secret(), authPassword: secret() })
    assert.equal(upgraded.rolesCreated, false); assert.equal(upgraded.seeded, false); assert.equal(upgraded.credentialsPreserved, true)
    assert.deepEqual(upgraded.migrations, [addition])
    assert.deepEqual((await db.admin.query("SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('atrium_app','atrium_authenticator') ORDER BY rolname")).rows, credentials)
    assert.deepEqual((await db.admin.query('SELECT * FROM atrium.users')).rows, users)
    assert.deepEqual((await bootstrapHostedDemoDatabase(input)).migrations, [])
  } finally { await maintenance?.end(); await db.close(); await rm(oldRoot, { recursive: true, force: true }) }
})
