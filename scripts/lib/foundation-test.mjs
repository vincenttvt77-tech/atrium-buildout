import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createTestPostgres } from './postgres-test.mjs'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { hashPassword } from '../../src/ops/accounts.ts'
import { applyDatabaseMigrations } from './database-migrations.mjs'

/** All identities and credentials in this fixture are synthetic, generated locally. */
export async function createFoundationTestDatabase() {
  const instance = await createTestPostgres()
  try {
    await instance.admin.query('CREATE ROLE atrium_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE')
    await instance.admin.query('CREATE ROLE atrium_account_executor NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION')
    await instance.admin.query('GRANT atrium_account_executor TO atrium_admin')
    const password = randomBytes(32).toString('base64url')
    for (const role of ['atrium_app', 'atrium_authenticator']) {
      await instance.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD ${pg.escapeLiteral(password)}`)
    }
    await applyDatabaseMigrations(instance.admin)
    const app = new DatabaseConnection({ ...instance.connection('atrium_app', password), max: 1 }, 'atrium_app')
    const auth = new DatabaseConnection({ ...instance.connection('atrium_authenticator', password), max: 2 }, 'atrium_authenticator')
    return { ...instance, app, auth,
      createAppConnection: () => new DatabaseConnection({ ...instance.connection('atrium_app', password), max: 8 }, 'atrium_app'),
      async close() { await app.close(); await auth.close(); await instance.close() } }
  } catch (error) { await instance.close(); throw error }
}

export async function seedFoundationTestDatabase(client) {
  const password = randomBytes(18).toString('base64url')
  const hash = await hashPassword(password)
  await client.query('BEGIN')
  try {
    for (const org of ['organization-a', 'organization-b']) {
      await client.query("INSERT INTO atrium.organizations(id,name,status) VALUES($1::text,$1::text,'active')", [org])
    }
    for (const [id, org, zone] of [
      ['property-a1','organization-a','America/New_York'], ['property-a2','organization-a','America/Chicago'],
      ['property-b1','organization-b','America/Los_Angeles'], ['property-b2','organization-b','Pacific/Honolulu'],
    ]) {
      await client.query("INSERT INTO atrium.properties(id,organization_id,name,time_zone,status) VALUES($1::text,$2,$1::text,$3,'active')", [id,org,zone])
    }
    for (const [id, org, role, access] of [
      ['owner-a','organization-a','owner','organization'], ['owner-b','organization-b','owner','organization'],
      ['viewer-a','organization-a','viewer','organization'], ['staff-a','organization-a','staff','properties'],
    ]) {
      await client.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,$1::text,'active')", [id])
      await client.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)', [id, hash])
      await client.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,access,status) VALUES($1,$2,$3,$4,$5,'active')", [`member-${id}`,id,org,role,access])
    }
    await client.query("INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status) VALUES('member-staff-a','organization-a','property-a1','active')")
    await client.query("INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities) VALUES('channel-a','vapi','synthetic-assistant-a','organization-a','property-a1','active',ARRAY['read','operate'])")
    await client.query('COMMIT')
    return { password }
  } catch (error) { await client.query('ROLLBACK'); throw error }
}
