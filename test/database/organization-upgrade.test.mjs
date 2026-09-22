import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, cp, mkdir, readdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createTestPostgres } from '../../scripts/lib/postgres-test.mjs'
import { bootstrapHostedDemoDatabase } from '../../scripts/lib/hosted-demo-database.mjs'
import { hashPassword } from '../../src/ops/accounts.ts'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { createAuthorizationService } from '../../src/auth/authorization.ts'

for (const baselineSpec of [{ count: 8, next: '_organization_administration.sql' }, { count: 9, next: '_resident_services.sql' }, { count: 10, next: '_maintenance_planning.sql' }, { count: 11, next: '_session_audience.sql' }, { count: 12, next: '_resident_enrollment.sql' }, { count: 13, next: '_resident_consent.sql' }]) {
test(`verified ${baselineSpec.count}-migration hosted workspace upgrades without rotating credentials or repairing unsafe state`, async () => {
  const db = await createTestPostgres(), oldRoot = await mkdtemp(join(tmpdir(), 'atrium-team-upgrade-'))
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url)), secret = () => randomBytes(36).toString('base64url')
  let maintenance, auth
  try {
    await cp(join(sourceRoot, 'data'), join(oldRoot, 'data'), { recursive: true })
    const oldMigrations = join(oldRoot, 'supabase', 'migrations'); await mkdir(oldMigrations, { recursive: true })
    const files = (await readdir(join(sourceRoot, 'supabase', 'migrations'))).filter(name => name.endsWith('.sql')).sort()
    const addition = files.find(name => name.endsWith(baselineSpec.next))
    assert.ok(addition)
    const baseline = files.filter(name => name < addition)
    assert.equal(baseline.length, baselineSpec.count)
    for (const file of baseline) await copyFile(join(sourceRoot, 'supabase', 'migrations', file), join(oldMigrations, file))
    const adminPassword = secret()
    await db.admin.query(`CREATE ROLE hosted_team_provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB NOREPLICATION PASSWORD ${pg.escapeLiteral(adminPassword)}`)
    await db.admin.query('GRANT CREATE ON DATABASE postgres TO hosted_team_provisioner')
    maintenance = new pg.Client(db.connection('hosted_team_provisioner', adminPassword)); await maintenance.connect()
    const input = { client: maintenance, appPassword: secret(), authPassword: secret(), connectionMode: 'session',
      account: { username: 'larkin', displayName: 'Synthetic Upgrade Larkin', passwordHash: await hashPassword(secret()) },
      bindings: [{ id: 'synthetic-upgrade-channel', externalId: randomUUID() }] }
    const original = await bootstrapHostedDemoDatabase({ ...input, root: oldRoot })
    assert.equal(original.migrations.length, baselineSpec.count)
    // Reconstruct the actual prior role set, without touching records or credentials.
    const missingRoles = ['atrium_consent_executor', ...(baselineSpec.count < 13 ? ['atrium_enrollment_executor'] : []), ...(baselineSpec.count === 8
      ? ['atrium_organization_executor', 'atrium_resident_services_executor', 'atrium_maintenance_approval_reader']
      : baselineSpec.count === 9 ? ['atrium_resident_services_executor', 'atrium_maintenance_approval_reader']
      : baselineSpec.count === 10 ? ['atrium_maintenance_approval_reader'] : [])]
    for (const role of missingRoles) {
      await db.admin.query(`REVOKE ${pg.escapeIdentifier(role)} FROM atrium_admin`)
      await db.admin.query(`DROP ROLE ${pg.escapeIdentifier(role)}`)
    }
    const credentials = (await db.admin.query("SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('atrium_app','atrium_authenticator') ORDER BY rolname")).rows
    const users = (await db.admin.query('SELECT * FROM atrium.users')).rows
    const legacyId = randomUUID(), legacyUser = users[0]
    const legacy = (await db.admin.query(`WITH stamp AS MATERIALIZED (SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms)
      INSERT INTO atrium.user_sessions(id,user_id,credential_version,label,created_at_ms,last_seen_at_ms,expires_at_ms)
      SELECT $1,$2,$3,'Synthetic retained staff session',ms,ms,ms+28800000 FROM stamp RETURNING *`,
    [legacyId, legacyUser.id, legacyUser.credential_version])).rows[0]
    const cookieSecret = secret(), payload = Buffer.from(JSON.stringify({ userId: legacy.user_id, credentialVersion: Number(legacy.credential_version), sessionId: legacy.id, expiresAt: Number(legacy.expires_at_ms) })).toString('base64url')
    const legacyCookie = `a4.${payload}.${createHmac('sha256', cookieSecret).update(`atrium-database-user-session-v4|${payload}`).digest('base64url')}`
    const absent = async () => assert.equal((await db.admin.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [missingRoles])).rowCount, 0)
    await assert.rejects(bootstrapHostedDemoDatabase({ ...input, bindings: [{ ...input.bindings[0], externalId: randomUUID() }] }), { code: 'existing_state' })
    await absent()
    await db.admin.query('GRANT pg_read_all_data TO atrium_app')
    try { await assert.rejects(bootstrapHostedDemoDatabase(input), { code: 'existing_state' }); await absent() }
    finally { await db.admin.query('REVOKE pg_read_all_data FROM atrium_app') }
    await db.admin.query('INSERT INTO atrium_migrations.history(version,checksum) VALUES($1,$2)', [addition, 'synthetic-already-installed'])
    // Immutable history is checked before a newly required role can be committed.
    try { await assert.rejects(bootstrapHostedDemoDatabase(input), { code: 'existing_state' }); await absent() }
    finally { await db.admin.query('DELETE FROM atrium_migrations.history WHERE version=$1', [addition]) }
    const upgraded = await bootstrapHostedDemoDatabase({ ...input, appPassword: secret(), authPassword: secret() })
    assert.equal(upgraded.rolesCreated, false); assert.equal(upgraded.seeded, false); assert.equal(upgraded.credentialsPreserved, true)
    assert.deepEqual(upgraded.migrations, files.filter(file => file >= addition))
    assert.deepEqual((await db.admin.query("SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('atrium_app','atrium_authenticator') ORDER BY rolname")).rows, credentials)
    assert.deepEqual((await db.admin.query('SELECT * FROM atrium.users')).rows, users)
    assert.deepEqual((await db.admin.query('SELECT * FROM atrium.user_sessions WHERE id=$1', [legacyId])).rows[0], { ...legacy, audience: 'staff' })
    auth = new DatabaseConnection(db.connection('atrium_authenticator', input.authPassword), 'atrium_authenticator')
    const retained = await createAuthorizationService(new PgAuthorizationRepository(auth)).authenticateSession(legacyCookie, new Date(), cookieSecret)
    assert.equal(retained?.userId, legacyUser.id)
    assert.equal(retained?.sessionId, legacyId)
    assert.equal(retained?.audience, 'staff')
    assert.deepEqual((await bootstrapHostedDemoDatabase(input)).migrations, [])
  } finally { await auth?.close(); await maintenance?.end(); await db.close(); await rm(oldRoot, { recursive: true, force: true }) }
})
}

test('a failed first migration can resume from only the bootstrap marker, but missing installed history cannot be repaired implicitly', async () => {
  const db = await createTestPostgres(), root = await mkdtemp(join(tmpdir(), 'atrium-enrollment-bootstrap-resume-'))
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url)), secret = () => randomBytes(36).toString('base64url')
  let client
  try {
    await cp(join(sourceRoot, 'data'), join(root, 'data'), { recursive: true })
    const directory = join(root, 'supabase', 'migrations')
    await cp(join(sourceRoot, 'supabase', 'migrations'), directory, { recursive: true })
    const first = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()[0]
    await writeFile(join(directory, first), 'SELECT synthetic_missing_migration_function();\n')
    const adminPassword = secret()
    await db.admin.query(`CREATE ROLE hosted_resume_provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB NOREPLICATION PASSWORD ${pg.escapeLiteral(adminPassword)}`)
    await db.admin.query('GRANT CREATE ON DATABASE postgres TO hosted_resume_provisioner')
    client = new pg.Client(db.connection('hosted_resume_provisioner', adminPassword)); await client.connect()
    const input = { client, root, appPassword: secret(), authPassword: secret(), connectionMode: 'session',
      account: { username: 'larkin', displayName: 'Synthetic Resume Larkin', passwordHash: await hashPassword(secret()) },
      bindings: [{ id: 'synthetic-resume-channel', externalId: randomUUID() }] }
    await assert.rejects(bootstrapHostedDemoDatabase(input), { code: 'bootstrap_failed', stage: 'migrations' })
    assert.equal((await db.admin.query("SELECT to_regnamespace('atrium') application_schema")).rows[0].application_schema, null)
    assert.equal((await db.admin.query('SELECT complete FROM atrium_hosted.bootstrap')).rows[0].complete, false)
    await copyFile(join(sourceRoot, 'supabase', 'migrations', first), join(directory, first))
    const resumed = await bootstrapHostedDemoDatabase(input)
    assert.equal(resumed.rolesCreated, false); assert.equal(resumed.seeded, true)
    const before = (await db.admin.query('SELECT * FROM atrium.users')).rows
    await db.admin.query('ALTER TABLE atrium_migrations.history RENAME TO missing_history_fixture')
    await assert.rejects(bootstrapHostedDemoDatabase(input), { code: 'existing_state' })
    assert.deepEqual((await db.admin.query('SELECT * FROM atrium.users')).rows, before)
    assert.equal((await db.admin.query("SELECT to_regclass('atrium_migrations.history') history")).rows[0].history, null)
  } finally { await client?.end(); await db.close(); await rm(root, { recursive: true, force: true }) }
})
