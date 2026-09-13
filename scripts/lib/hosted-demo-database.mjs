import pg from 'pg'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { applyDatabaseMigrations } from './database-migrations.mjs'
import { createAuthorizationService } from '../../src/auth/authorization.ts'
import { validateChannelBinding, validateUser } from '../../src/auth/validation.ts'
import { validatePublishedProperty } from '../../src/properties/snapshot.ts'
import { defaultSettings, validateSettings } from '../../src/calendar/settings.ts'

export const HOSTED_DEMO = Object.freeze({ organizationId: 'org-demo-larkin', propertyId: 'prop-demo',
  userId: 'user-demo-larkin', membershipId: 'member-demo-larkin', name: 'The Larkin · Demo' })
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const EXECUTORS = ['atrium_account_executor', 'atrium_login_executor', 'atrium_session_executor', 'atrium_mfa_executor', 'atrium_organization_executor', 'atrium_resident_services_executor']
const RUNTIME_ROLES = ['atrium_app', 'atrium_authenticator']
const ROLES = ['atrium_admin', ...EXECUTORS, ...RUNTIME_ROLES]
const LOCK = 'atrium-hosted-demo-bootstrap-v1'
const HASH = /^scrypt\$65536\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/
const check = value => { if (!value) throw new HostedDemoBootstrapError('invalid_input') }
export class HostedDemoBootstrapError extends Error {
  constructor(code, stage = null) {
    super(code === 'invalid_input' ? 'Hosted demo bootstrap input is invalid.'
      : code === 'existing_state' ? 'Existing Atrium state differs from this bootstrap; nothing was reset.'
        : 'Hosted demo bootstrap could not complete. Preserve the database and inspect the reported stage before retrying.')
    this.name = 'HostedDemoBootstrapError'; this.code = code; this.stage = stage
  }
}
const failState = () => { throw new HostedDemoBootstrapError('existing_state') }
function password(value) { return typeof value === 'string' && value.length >= 32 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function accountInput(value) {
  check(value && Object.keys(value).sort().join(',') === 'displayName,passwordHash,username' && value.username === 'larkin')
  const match = typeof value.passwordHash === 'string' && HASH.exec(value.passwordHash)
  check(match && Buffer.from(match[1], 'base64url').toString('base64url') === match[1]
    && Buffer.from(match[2], 'base64url').toString('base64url') === match[2])
  try { validateUser({ id: HOSTED_DEMO.userId, username: value.username, displayName: value.displayName, status: 'active', credentialVersion: 1 }) }
  catch { check(false) }
  return { ...value }
}
/** Pure preflight for a CLI's --check path; no IO or environment access. */
export function validateHostedDemoInput(input) {
  try {
    check(input && password(input.appPassword) && password(input.authPassword) && input.appPassword !== input.authPassword)
    const account = accountInput(input.account)
    check(Array.isArray(input.bindings) && input.bindings.length >= 1 && input.bindings.length <= 10)
    const bindings = input.bindings.map(value => {
      check(value && Object.keys(value).sort().join(',') === 'externalId,id')
      return validateChannelBinding({ ...value, provider: 'vapi', organizationId: HOSTED_DEMO.organizationId,
        propertyId: HOSTED_DEMO.propertyId, status: 'active', capabilities: ['read', 'operate'], permissionVersion: 1 })
    }).sort((a,b) => a.id.localeCompare(b.id))
    check(new Set(bindings.map(b => b.id)).size === bindings.length && new Set(bindings.map(b => b.externalId)).size === bindings.length)
    return { account, bindings }
  } catch { throw new HostedDemoBootstrapError('invalid_input') }
}
async function template(root, bindings) {
  const [property, inventory, floorplans, knowledge, provenance] = await Promise.all(
    ['property', 'inventory', 'floorplans', 'knowledge', 'inventory-source'].map(name => readFile(join(root, 'data', `${name}.json`), 'utf8').then(JSON.parse)))
  check(property.id === HOSTED_DEMO.propertyId && property.timeZone === 'America/New_York'
    && typeof property.sourceNote === 'string' && property.sourceNote.startsWith('DEMO PROPERTY — FICTIONAL.')
    && property.sourceNote.includes('The Larkin does not exist.') && provenance.sourceMode === 'demo' && provenance.fictional === true)
  const bundle = { property: { ...property, organizationId: HOSTED_DEMO.organizationId, jurisdiction: 'NY',
    tourSettings: validateSettings(defaultSettings()) }, inventory, floorplans, knowledge, inventoryProvenance: provenance }
  const source = { organizationId: HOSTED_DEMO.organizationId, propertyId: HOSTED_DEMO.propertyId, version: 1,
    timeZone: property.timeZone, inventoryReadAt: provenance.catalogAsOf,
    inventorySource: 'Bundled fictional demo inventory; no PMS connection', bundle }
  // This maintenance-only proposed-record repository issues a scope solely for the
  // existing content validator. It is never returned, bound or used for runtime IO.
  const scope = await createAuthorizationService({
    findChannelBinding: async () => bindings[0],
    getOrganization: async () => ({ id: HOSTED_DEMO.organizationId, name: HOSTED_DEMO.name, status: 'active', permissionVersion: 1 }),
    getProperty: async () => ({ id: HOSTED_DEMO.propertyId, organizationId: HOSTED_DEMO.organizationId,
      name: HOSTED_DEMO.name, timeZone: property.timeZone, status: 'active', permissionVersion: 1 }),
  }).authorizeChannel('vapi', bindings[0].externalId, 'read')
  validatePublishedProperty({ ...source, publishedAt: new Date().toISOString() }, scope)
  return source
}
async function transaction(client, work) {
  await client.query('BEGIN')
  try {
    const result = await work()
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('Uncommitted bootstrap')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error }
}
async function roleSafety(client, executors = EXECUTORS) {
  const checkedRoles = ['atrium_admin', ...executors, ...RUNTIME_ROLES]
  const roles = (await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication
    FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`, [checkedRoles])).rows
  if (roles.length !== checkedRoles.length || roles.some(role => role.rolcanlogin !== RUNTIME_ROLES.includes(role.rolname)
    || role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolcreatedb || role.rolreplication)) failState()
  const memberships = (await client.query(`SELECT m.rolname member,p.rolname parent FROM pg_catalog.pg_auth_members a
    JOIN pg_catalog.pg_roles m ON m.oid=a.member JOIN pg_catalog.pg_roles p ON p.oid=a.roleid
    WHERE m.rolname=ANY($1::text[])`, [checkedRoles])).rows
  if (memberships.some(edge => edge.member !== 'atrium_admin' || !executors.includes(edge.parent))) failState()
  for (const executor of executors) {
    if (!(await client.query('SELECT pg_catalog.pg_has_role($1,$2,\'MEMBER\') allowed', ['atrium_admin', executor])).rows[0].allowed) failState()
  }
  // Empty-table queries cannot prove isolation. Refuse catalogue drift before
  // trusting a previous bootstrap marker; never repair production ACLs implicitly.
  const unsafe = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='atrium' AND c.relkind IN ('r','p')
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR pg_catalog.pg_get_userbyid(c.relowner)<>'atrium_admin'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('atrium','atrium_migrations','atrium_hosted')
      AND (pg_catalog.pg_get_userbyid(n.nspowner)<>'atrium_admin' OR EXISTS(
        SELECT 1 FROM pg_catalog.aclexplode(coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) acl WHERE acl.grantee=0)))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
      WHERE n.nspname IN ('atrium','atrium_migrations','atrium_hosted') AND c.relkind IN ('r','p','v','m','S') AND acl.grantee=0)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE n.nspname IN ('atrium','atrium_migrations','atrium_hosted') AND acl.grantee=0)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_namespace n
      WHERE r.rolname IN ('anon','authenticated','service_role') AND n.nspname IN ('atrium','atrium_migrations','atrium_hosted')
      AND (pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE') OR pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE r.rolname IN ('anon','authenticated','service_role') AND n.nspname IN ('atrium','atrium_migrations','atrium_hosted')
      AND c.relkind IN ('r','p','v','m') AND pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE r.rolname IN ('anon','authenticated','service_role') AND n.nspname IN ('atrium','atrium_migrations','atrium_hosted')
      AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) AS unsafe`)).rows[0].unsafe
  if (unsafe) failState()
}
async function prepareRoles(client, manifest, secrets) {
  return transaction(client, async () => {
    const identity = (await client.query(`SELECT current_user current_role,session_user login_role,current_database() database_name,
      r.rolcanlogin,r.rolcreaterole,has_database_privilege(current_user,current_database(),'CREATE') can_create
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`)).rows[0]
    if (!identity || identity.current_role !== identity.login_role || !identity.rolcanlogin || !identity.rolcreaterole || !identity.can_create
      || ROLES.includes(identity.current_role)) failState()
    const marker = (await client.query("SELECT to_regclass('atrium_hosted.bootstrap') marker")).rows[0].marker
    if (marker) {
      const additions = [
        ['atrium_organization_executor', '%organization_administration%'],
        ['atrium_resident_services_executor', '%resident_services%'],
      ]
      const missing = []
      for (const [role, migration] of additions) {
        if (!(await client.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1', [role])).rowCount) missing.push([role, migration])
      }
      await roleSafety(client, EXECUTORS.filter(role => !missing.some(([absent]) => absent === role)))
      await client.query('SET LOCAL ROLE atrium_admin')
      const prior = (await client.query('SELECT manifest FROM atrium_hosted.bootstrap WHERE id=1')).rows[0]
      if (!prior || !isDeepStrictEqual(prior.manifest, manifest)) failState()
      for (const [, migration] of missing) {
        // Extend a verified older bootstrap, never repair a removed installed role.
        if ((await client.query('SELECT 1 FROM atrium_migrations.history WHERE version LIKE $1 LIMIT 1', [migration])).rowCount) failState()
      }
      if (missing.length) {
        await client.query('RESET ROLE')
        for (const [role] of missing) {
          await client.query(`CREATE ROLE ${pg.escapeIdentifier(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`)
          await client.query(`GRANT ${pg.escapeIdentifier(role)} TO atrium_admin`)
        }
        await roleSafety(client)
      }
      return false
    }
    const existing = (await client.query(`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])
      UNION ALL SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname IN ('atrium','atrium_migrations','atrium_hosted','atrium_local') LIMIT 1`, [ROLES])).rows
    if (existing.length) failState()
    for (const role of ROLES) {
      const secret = role === 'atrium_app' ? secrets.appPassword : role === 'atrium_authenticator' ? secrets.authPassword : null
      await client.query(`CREATE ROLE ${role} ${secret ? `LOGIN PASSWORD ${pg.escapeLiteral(secret)}` : 'NOLOGIN'} NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`)
    }
    await client.query(`GRANT atrium_admin TO ${pg.escapeIdentifier(identity.current_role)}`)
    for (const executor of EXECUTORS) await client.query(`GRANT ${executor} TO atrium_admin`)
    await client.query(`GRANT CREATE ON DATABASE ${pg.escapeIdentifier(identity.database_name)} TO atrium_admin`)
    await client.query('CREATE SCHEMA atrium_hosted AUTHORIZATION atrium_admin')
    await client.query('SET LOCAL ROLE atrium_admin')
    await client.query('REVOKE ALL ON SCHEMA atrium_hosted FROM PUBLIC')
    await client.query(`CREATE TABLE atrium_hosted.bootstrap(id integer PRIMARY KEY CHECK(id=1),manifest jsonb NOT NULL,
      complete boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz)`)
    await client.query('ALTER TABLE atrium_hosted.bootstrap ENABLE ROW LEVEL SECURITY')
    await client.query('ALTER TABLE atrium_hosted.bootstrap FORCE ROW LEVEL SECURITY')
    await client.query('CREATE POLICY maintenance ON atrium_hosted.bootstrap TO atrium_admin USING(true) WITH CHECK(true)')
    await client.query('REVOKE ALL ON atrium_hosted.bootstrap FROM PUBLIC')
    await client.query('INSERT INTO atrium_hosted.bootstrap(id,manifest) VALUES(1,$1)', [JSON.stringify(manifest)])
    return true
  })
}
async function seed(client, account, bindings, source) {
  return transaction(client, async () => {
    await client.query('SET LOCAL ROLE atrium_admin')
    const marker = (await client.query('SELECT complete FROM atrium_hosted.bootstrap WHERE id=1 FOR UPDATE')).rows[0]
    if (!marker) failState()
    if (marker.complete) return false
    // This is a fresh demo, never an upsert into a global identity or an import of
    // existing staff/customer records. Any conflicting row rolls the whole seed back.
    await client.query("INSERT INTO atrium.organizations(id,name,status) VALUES($1,$2,'active')", [HOSTED_DEMO.organizationId, HOSTED_DEMO.name])
    await client.query("INSERT INTO atrium.properties(id,organization_id,name,time_zone,status) VALUES($1,$2,$3,$4,'active')", [HOSTED_DEMO.propertyId, HOSTED_DEMO.organizationId, HOSTED_DEMO.name, source.timeZone])
    await client.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1,$2,$3,'active')", [HOSTED_DEMO.userId, account.username, account.displayName])
    await client.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)', [HOSTED_DEMO.userId, account.passwordHash])
    await client.query("INSERT INTO atrium.memberships(id,user_id,organization_id,role,status,access) VALUES($1,$2,$3,'owner','active','properties')", [HOSTED_DEMO.membershipId, HOSTED_DEMO.userId, HOSTED_DEMO.organizationId])
    await client.query("INSERT INTO atrium.property_grants(membership_id,organization_id,property_id,status) VALUES($1,$2,$3,'active')", [HOSTED_DEMO.membershipId, HOSTED_DEMO.organizationId, HOSTED_DEMO.propertyId])
    for (const binding of bindings) await client.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
      VALUES($1,'vapi',$2,$3,$4,'active',ARRAY['read','operate'])`, [binding.id, binding.externalId, HOSTED_DEMO.organizationId, HOSTED_DEMO.propertyId])
    await client.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,schema_version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,1,'published',$3,$4,$5,clock_timestamp())`, [HOSTED_DEMO.organizationId, HOSTED_DEMO.propertyId,
      JSON.stringify(source.bundle), source.inventoryReadAt, source.inventorySource])
    await client.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1 AND organization_id=$2', [HOSTED_DEMO.propertyId, HOSTED_DEMO.organizationId])
    await client.query('UPDATE atrium_hosted.bootstrap SET complete=true,completed_at=clock_timestamp() WHERE id=1')
    return true
  })
}
async function verifySeed(client, bindings) {
  return transaction(client, async () => {
    await client.query('SET LOCAL ROLE atrium_admin')
    const row = (await client.query(`SELECT p.published_configuration_version version FROM atrium.properties p
      JOIN atrium.organizations o ON o.id=p.organization_id AND o.status='active'
      JOIN atrium.property_configurations c ON c.organization_id=p.organization_id AND c.property_id=p.id
        AND c.version=p.published_configuration_version AND c.status='published'
      JOIN atrium.memberships m ON m.id=$3 AND m.organization_id=o.id AND m.user_id=$4
        AND m.status='active' AND m.role='owner' AND m.access='properties'
      JOIN atrium.property_grants g ON g.membership_id=m.id AND g.organization_id=o.id AND g.property_id=p.id AND g.status='active'
      JOIN atrium.users u ON u.id=m.user_id AND u.status='active' AND u.username='larkin'
      JOIN atrium.user_credentials k ON k.user_id=u.id
      WHERE p.id=$1 AND p.organization_id=$2 AND p.status='active'`,
    [HOSTED_DEMO.propertyId, HOSTED_DEMO.organizationId, HOSTED_DEMO.membershipId, HOSTED_DEMO.userId])).rows[0]
    const version = Number(row?.version)
    if (!Number.isSafeInteger(version) || version < 1) failState()
    for (const binding of bindings) {
      const actual = (await client.query(`SELECT 1 FROM atrium.channel_bindings WHERE id=$1 AND provider='vapi' AND external_id=$2
        AND organization_id=$3 AND property_id=$4 AND status='active' AND capabilities=ARRAY['read','operate']::text[]`,
      [binding.id, binding.externalId, HOSTED_DEMO.organizationId, HOSTED_DEMO.propertyId])).rows[0]
      if (!actual) failState()
    }
    return version
  })
}

/**
 * Dedicated, trusted maintenance client only (direct or session pooler, never a
 * transaction pooler). The caller owns TLS, credentials, connection lifecycle and
 * explicit deployment approval. No global environment, logging or local-preview
 * helper is used. Passwords provision new roles only; reruns never rotate them.
 * The durable nonsecret manifest permits safe resumption after a failed phase.
 */
export async function bootstrapHostedDemoDatabase({ client, appPassword, authPassword, account, bindings, root = ROOT, connectionMode }) {
  let stage = 'validate', locked = false
  try {
    check(client && typeof client.query === 'function' && ['direct', 'session'].includes(connectionMode))
    const validated = validateHostedDemoInput({ appPassword, authPassword, account, bindings })
    account = validated.account; bindings = validated.bindings
    const source = await template(root, bindings)
    const manifest = { version: 1, organizationId: HOSTED_DEMO.organizationId, propertyId: HOSTED_DEMO.propertyId,
      userId: HOSTED_DEMO.userId, username: account.username, displayName: account.displayName,
      bindings: bindings.map(({id,externalId}) => ({id,externalId})), sourceSha256: createHash('sha256').update(JSON.stringify(source)).digest('hex') }
    stage = 'lock'
    await client.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))', [LOCK]); locked = true
    stage = 'roles'; const rolesCreated = await prepareRoles(client, manifest, { appPassword, authPassword })
    stage = 'migrations'; const migrations = await applyDatabaseMigrations(client, join(root, 'supabase', 'migrations'))
    stage = 'seed'; const seeded = await seed(client, account, bindings, source)
    stage = 'verify'; await roleSafety(client)
    const configurationVersion = await verifySeed(client, bindings)
    return Object.freeze({ rolesCreated, seeded, migrations, ...HOSTED_DEMO, configurationVersion,
      bindingIds: bindings.map(binding => binding.id), sourceMode: 'demo', credentialsPreserved: !rolesCreated })
  } catch (error) {
    if (error instanceof HostedDemoBootstrapError) throw error
    throw new HostedDemoBootstrapError(stage === 'validate' ? 'invalid_input' : 'bootstrap_failed', stage)
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0))', [LOCK]) }
      catch { /* Caller closes this dedicated client; no unsafe reconnect/retry. */ }
    }
  }
}
