import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFile, readdir, mkdtemp, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createTestPostgres } from '../../scripts/lib/postgres-test.mjs'
import { applyDatabaseMigrations, migrationsDirectory } from '../../scripts/lib/database-migrations.mjs'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { mintUserSession, verifyUserSessionClaims } from '../../src/auth/session.ts'
import { PostgresUserSessionRepository } from '../../src/database/user-sessions.ts'
import { issueAuthenticatedUser } from '../../src/auth/identity.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { TEST_AUTH_ORIGIN, verifyMfaSession } from '../helpers/mfa-session.mjs'

let db, repo, password, hash, runtime
before(async () => {
  db = await createFoundationTestDatabase(); ({ password } = await seedFoundationTestDatabase(db.admin))
  repo = new PostgresUserSessionRepository(db.auth)
  hash = (await db.admin.query("SELECT password_hash FROM atrium.user_credentials WHERE user_id='owner-a'")).rows[0].password_hash
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: randomBytes(40).toString('base64url'), authOrigin: TEST_AUTH_ORIGIN })
})
after(async () => { if (db) await db.close() })
function principal(id, audience, record) {
  return issueAuthenticatedUser({ id, username:id, displayName:id, status:'active', credentialVersion:1 },
    record ? { id:record.id, expiresAt:record.expiresAt } : undefined, audience)
}
async function user() {
  const id = `audience-${randomBytes(6).toString('hex')}`
  await db.admin.query("INSERT INTO atrium.users(id,username,display_name,status) VALUES($1::text,$1::text,$1::text,'active')",[id])
  await db.admin.query('INSERT INTO atrium.user_credentials(user_id,password_hash) VALUES($1,$2)',[id,hash])
  return id
}
const start = (id,audience) => repo.start(principal(id,audience),{ id:randomUUID(),label:'Synthetic browser',audience })
const claims = row => ({ userId:row.userId, credentialVersion:row.credentialVersion, sessionId:row.id, expiresAt:row.expiresAt, audience:row.audience })
const context = (row, audience=row.audience) => ({ actorUserId:row.userId, credentialVersion:row.credentialVersion, actorSessionId:row.id, ...(audience ? {sessionAudience:audience} : {}) })
const property = row => ({...context(row),organizationId:'organization-a',propertyId:'property-a1'})

test('additive migration preserves applied SQL and keeps exact finite privileges and immutable audience',async()=>{
  const migration='20260913091003_session_audience.sql'
  assert.equal(await readFile(new URL('../../db/session-audience.sql',import.meta.url),'utf8'),await readFile(new URL(`../../supabase/migrations/${migration}`,import.meta.url),'utf8'))
  for(const name of await readdir(new URL('../../supabase/migrations/',import.meta.url))) {
    if(!name.endsWith('.sql') || name>=migration)continue
    const expected=execFileSync('git',['show',`HEAD:supabase/migrations/${name}`],{cwd:new URL('../../',import.meta.url),encoding:'utf8'})
    assert.equal(await readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8'),expected,name)
  }
  const id=await user(), row=await start(id,'resident')
  await assert.rejects(db.admin.query("UPDATE atrium.user_sessions SET audience='staff' WHERE id=$1",[row.id]),{code:'23514'})
  await assert.rejects(db.app.transaction(context(row),client=>client.query("UPDATE atrium.user_sessions SET audience='staff'")),{code:'42501'})
  const privileges=(await db.admin.query(`SELECT has_column_privilege('atrium_maintenance_approval_reader','atrium.user_sessions','audience','SELECT') AS audience,
    has_column_privilege('atrium_maintenance_approval_reader','atrium.users','username','SELECT') AS pii,
    has_table_privilege('atrium_session_executor','atrium.user_credentials','SELECT') AS credentials,
    pg_has_role('atrium_authenticator','atrium_session_executor','MEMBER') AS inherited`)).rows[0]
  assert.deepEqual(privileges,{audience:true,pii:false,credentials:false,inherited:false})
})

test('legacy finite start defaults only to staff; strict repository refuses absent or mismatched audiences',async()=>{
  const id=await user(), key=randomUUID()
  const legacy=await db.auth.transaction({actorUserId:id,credentialVersion:1},async client=>(await client.query('SELECT * FROM atrium.start_user_session($1,$2)',[key,'Legacy browser'])).rows[0])
  assert.equal(legacy.audience,'staff')
  assert.ok(await repo.resolve({userId:id,credentialVersion:1,sessionId:key,expiresAt:Number(legacy.expires_at_ms),audience:'staff'}))
  for(const audience of [undefined,null,'admin',{},'']) {
    await assert.rejects(repo.start(principal(id,'staff'),{id:randomUUID(),label:'Invalid',audience}),{code:'invalid_session'})
  }
  await assert.rejects(repo.start(principal(id,'resident'),{id:randomUUID(),label:'Wrong audience',audience:'staff'}),{code:'invalid_session'})
  const resident=await start(id,'resident')
  assert.equal(await repo.resolve({...claims(resident),audience:'staff'}),null)
  assert.equal(await repo.resolve({...claims(resident),audience:undefined}),null)
  assert.equal(await repo.resolve({...claims(resident),expiresAt:resident.expiresAt+1}),null)
  assert.deepEqual(await repo.resolve(claims(resident)),resident)
})

test('resident SID never passes raw staff RLS with forged, omitted or resident context for the same owner',async()=>{
  const staff=await start('owner-a','staff'), resident=await start('owner-a','resident')
  await verifyMfaSession(runtime,principal('owner-a','staff',staff),password)
  await verifyMfaSession(runtime,principal('owner-a','resident',resident),password)
  const scope=await runtime.authorization.authorizeProperty(principal('owner-a','staff',staff),'property-a1','operate')
  assert.ok(scope)
  for(const audience of [null,'staff','resident']) {
    const scoped={...context(resident,audience),organizationId:'organization-a',propertyId:'property-a1'}
    const raw=await db.app.transaction(scoped,async client=>{
      const gates=(await client.query(`SELECT atrium.session_context_valid() AS valid,atrium.staff_context() AS staff,
        atrium.hold_current_session() AS fence,atrium.can_access_property('organization-a','property-a1','operate') AS access`)).rows[0]
      const members=(await client.query('SELECT id FROM atrium.memberships')).rows
      const properties=(await client.query('SELECT id FROM atrium.properties')).rows
      return {gates,members,properties}
    })
    assert.deepEqual(raw,{gates:{valid:audience==='resident',staff:false,fence:false,access:false},members:[],properties:[]})
    const auth=await db.auth.transaction(context(resident,audience),async client=>({
      sessions:(await client.query('SELECT id FROM atrium.user_sessions')).rows,
      members:(await client.query('SELECT id FROM atrium.memberships')).rows,
      properties:(await client.query('SELECT id FROM atrium.properties')).rows,
    }))
    assert.deepEqual(auth.members,[]);assert.deepEqual(auth.properties,[])
    assert.deepEqual(auth.sessions,audience==='resident'?[{id:resident.id}]:[])
  }
  assert.equal(await db.app.transaction(property(staff),async client=>(await client.query('SELECT atrium.hold_current_session() AS valid')).rows[0].valid),true)
})

test('resident context without SID cannot become internal staff or a provider channel',async()=>{
  const human={actorUserId:'owner-a',credentialVersion:1,sessionAudience:'resident',organizationId:'organization-a',propertyId:'property-a1'}
  const channel={sessionAudience:'resident',channelBindingId:'channel-a',channelBindingVersion:1,channelProvider:'vapi',channelExternalId:'synthetic-assistant-a',organizationId:'organization-a',propertyId:'property-a1'}
  for(const value of [human,channel]) {
    const gates=await db.app.transaction(value,async client=>(await client.query('SELECT atrium.staff_context() AS staff,atrium.channel_context() AS channel,atrium.session_context_valid() AS valid')).rows[0])
    assert.deepEqual(gates,{staff:false,channel:false,valid:false})
  }
  assert.deepEqual(await db.auth.transaction(channel,async client=>(await client.query('SELECT id FROM atrium.channel_bindings')).rows),[])
  await assert.rejects(db.auth.transaction({sessionAudience:'resident'},client=>client.query('SELECT * FROM atrium.reserve_login_attempt($1,$2)',['a'.repeat(64),'b'.repeat(64)])),{code:'42501'})
})

test('MFA self works for both audiences but resident session cannot request an organization proof',async()=>{
  const row=await start('owner-a','resident'), p=principal('owner-a','resident',row)
  await verifyMfaSession(runtime,p,password)
  const state=await runtime.mfa.state(p)
  assert.ok(state.assurances.some(a=>a.purpose==='session_login'))
  await assert.rejects(runtime.mfa.authenticationOptions(p,{purpose:'organization_administration',factorId:null}))
  const request={id:randomUUID(),challengeHash:'c'.repeat(64),kind:'authentication',intent:'verify',purpose:'organization_administration',expectedSecurityVersion:state.securityVersion}
  const raw=await db.auth.transaction(context(row),async client=>(await client.query('SELECT atrium.mfa_begin_ceremony($1,$2,$3,$4) AS result',[request,TEST_AUTH_ORIGIN,new URL(TEST_AUTH_ORIGIN).hostname,state.userHandle])).rows[0].result)
  assert.equal(raw.error,'invalid_input')
  assert.equal(await db.app.transaction({...context(row),organizationId:'organization-a',propertyId:'property-a1'},async client=>(await client.query("SELECT atrium.mfa_hold_proof($1,'organization_administration') AS valid",[randomUUID()])).rows[0].valid),false)
  for(const audience of [null,'staff']) {
    const result=await db.auth.transaction(context(row,audience),async client=>(await client.query('SELECT atrium.mfa_read_state($1,$2,$3,$4) AS value',[{},TEST_AUTH_ORIGIN,new URL(TEST_AUTH_ORIGIN).hostname,state.userHandle])).rows[0].value)
    assert.equal(result.error,'unauthenticated')
  }
})

test('session list and revoke are audience-local, including same-account foreign selection',async()=>{
  const id=await user(),s1=await start(id,'staff'),s2=await start(id,'staff'),r1=await start(id,'resident'),r2=await start(id,'resident')
  const sp=principal(id,'staff',s1),rp=principal(id,'resident',r1)
  assert.deepEqual(new Set((await repo.list(sp)).map(s=>s.id)),new Set([s1.id,s2.id]))
  assert.deepEqual(new Set((await repo.list(rp)).map(s=>s.id)),new Set([r1.id,r2.id]))
  await assert.rejects(repo.revoke(rp,s2.id),{code:'invalid_session'})
  await assert.rejects(repo.revoke(sp,r2.id),{code:'invalid_session'})
  assert.deepEqual(await repo.revoke(rp,'others'),{revokedIds:[r2.id],currentRevoked:false})
  assert.ok(await repo.resolve(claims(s2)));assert.equal(await repo.resolve(claims(r2)),null)
  assert.deepEqual(await repo.revoke(rp,r2.id),{revokedIds:[],currentRevoked:false})
  assert.deepEqual(await repo.revoke(rp,r1.id),{revokedIds:[r1.id],currentRevoked:true})
  assert.ok(await repo.resolve(claims(s1)))
})

test('twenty-active eviction is per audience and retains one atomic audit per evicted session',async()=>{
  const id=await user(),staff=[],resident=[]
  for(let i=0;i<20;i++){staff.push(await start(id,'staff'));resident.push(await start(id,'resident'))}
  const extra=await start(id,'resident')
  assert.equal((await repo.list(principal(id,'staff',staff[19]))).length,20)
  assert.equal((await repo.list(principal(id,'resident',extra))).length,20)
  const revoked=(await db.admin.query("SELECT s.audience,s.id,e.reason,s.xmin::text AS sx,e.xmin::text AS ex FROM atrium.user_sessions s JOIN atrium.user_session_events e ON e.session_id=s.id AND e.operation='revoked' WHERE s.user_id=$1",[id])).rows
  assert.equal(revoked.length,1);assert.equal(revoked[0].audience,'resident');assert.equal(revoked[0].reason,'session_limit');assert.equal(revoked[0].sx,revoked[0].ex)
  assert.ok(staff.every(s=>s.id!==revoked[0].id))
})

test('resident self-password change invalidates both audiences and preserves self-only account policy',async()=>{
  const id=await user(),s=await start(id,'staff'),r=await start(id,'resident'),p=principal(id,'resident',r)
  const before=(await db.admin.query("SELECT password_hash FROM atrium.user_credentials WHERE user_id='owner-b'")).rows[0].password_hash
  await runtime.passwordChanges.changeOwnPassword(p,{currentPassword:password,newPassword:'Synthetic replacement password 2026'})
  assert.equal(await repo.resolve(claims(s)),null);assert.equal(await repo.resolve(claims(r)),null)
  assert.equal(Number((await db.admin.query('SELECT credential_version FROM atrium.users WHERE id=$1',[id])).rows[0].credential_version),2)
  assert.equal((await db.admin.query("SELECT password_hash FROM atrium.user_credentials WHERE user_id='owner-b'")).rows[0].password_hash,before)
  const event=(await db.admin.query('SELECT * FROM atrium.account_security_events WHERE user_id=$1',[id])).rows
  assert.equal(event.length,1)
})

test('audit failure rolls resident start and revoke back without touching staff sessions',async()=>{
  const id=await user(),s=await start(id,'staff'),r=await start(id,'resident'),target=await start(id,'resident')
  await db.admin.query('REVOKE INSERT ON atrium.user_session_events FROM atrium_session_executor')
  try {
    await assert.rejects(start(id,'resident'),{code:'session_unavailable'})
    await assert.rejects(repo.revoke(principal(id,'resident',r),target.id),{code:'session_unavailable'})
  } finally {await db.admin.query('GRANT INSERT ON atrium.user_session_events TO atrium_session_executor')}
  for(const row of [s,r,target])assert.ok(await repo.resolve(claims(row)))
  assert.equal(Number((await db.admin.query('SELECT count(*) FROM atrium.user_sessions WHERE user_id=$1',[id])).rows[0].count),3)
})


test('additive upgrade preserves an already populated staff session and its existing a4 cookie',async()=>{
  const legacy=await createTestPostgres(),directory=await mkdtemp(join(tmpdir(),'atrium-audience-upgrade-'))
  let connection
  try {
    await legacy.admin.query('CREATE ROLE atrium_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE')
    for(const role of ['atrium_account_executor','atrium_login_executor','atrium_session_executor','atrium_mfa_executor','atrium_organization_executor','atrium_resident_services_executor','atrium_maintenance_approval_reader']) {
      await legacy.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`)
      await legacy.admin.query(`GRANT ${role} TO atrium_admin`)
    }
    const synthetic=randomBytes(32).toString('hex')
    for(const role of ['atrium_app','atrium_authenticator'])await legacy.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD '${synthetic}'`)
    const migration='20260913091003_session_audience.sql'
    for(const file of await readdir(migrationsDirectory))if(file.endsWith('.sql')&&file<migration)await copyFile(join(migrationsDirectory,file),join(directory,file))
    await applyDatabaseMigrations(legacy.admin,directory);await seedFoundationTestDatabase(legacy.admin)
    connection=new DatabaseConnection({...legacy.connection('atrium_authenticator',synthetic),max:1},'atrium_authenticator')
    const id=randomUUID(),created=await connection.transaction({actorUserId:'owner-a',credentialVersion:1},async c=>(await c.query('SELECT * FROM atrium.start_user_session($1,$2)',[id,'Existing browser'])).rows[0])
    assert.equal(Object.hasOwn(created,'audience'),false)
    const secret=randomBytes(40).toString('base64url'),current=principal('owner-a','staff',{id,expiresAt:Number(created.expires_at_ms)})
    const cookie=mintUserSession(current,new Date(),secret),claims=verifyUserSessionClaims(cookie,new Date(),secret)
    assert.ok(claims);assert.equal(claims.audience,'staff')
    const beforeAudit=(await legacy.admin.query('SELECT * FROM atrium.user_session_events WHERE session_id=$1',[id])).rows
    await copyFile(join(migrationsDirectory,migration),join(directory,migration))
    assert.deepEqual(await applyDatabaseMigrations(legacy.admin,directory),[migration])
    const saved=(await legacy.admin.query('SELECT * FROM atrium.user_sessions WHERE id=$1',[id])).rows[0]
    assert.equal(saved.audience,'staff')
    const {audience,...rest}=saved;assert.deepEqual(rest,created)
    assert.deepEqual((await legacy.admin.query('SELECT * FROM atrium.user_session_events WHERE session_id=$1',[id])).rows,beforeAudit)
    assert.ok(await new PostgresUserSessionRepository(connection).resolve(claims))
    assert.deepEqual(await applyDatabaseMigrations(legacy.admin,directory),[])
  } finally {if(connection)await connection.close();await legacy.close();await rm(directory,{recursive:true,force:true})}
})
