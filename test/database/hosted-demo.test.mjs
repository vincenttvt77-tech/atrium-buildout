import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { createTestPostgres } from '../../scripts/lib/postgres-test.mjs'
import { bootstrapHostedDemoDatabase, validateHostedDemoInput, HOSTED_DEMO } from '../../scripts/lib/hosted-demo-database.mjs'
import { hashPassword } from '../../src/ops/accounts.ts'
import { DatabaseConnection } from '../../src/database/connection.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'

let db,maintenance,app,auth,runtime,input,userPassword,initialHash
const sqlFailures=[]
const query=async(...args)=>{try{return await maintenance.query(...args)}catch(error){sqlFailures.push({code:error.code,routine:error.routine});throw error}}
const client={query}
const secret=()=>randomBytes(36).toString('base64url')
before(async()=>{
 db=await createTestPostgres()
 const provisionerPassword=secret()
 await db.admin.query(`CREATE ROLE hosted_provisioner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB NOREPLICATION PASSWORD ${pg.escapeLiteral(provisionerPassword)}`)
 await db.admin.query('GRANT CREATE ON DATABASE postgres TO hosted_provisioner')
 for(const role of ['anon','authenticated','service_role'])await db.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
 maintenance=new pg.Client(db.connection('hosted_provisioner',provisionerPassword));await maintenance.connect()
 userPassword=secret();initialHash=await hashPassword(userPassword)
 input={client,connectionMode:'session',appPassword:secret(),authPassword:secret(),account:{username:'larkin',passwordHash:initialHash,displayName:'Synthetic Hosted Larkin'},
  bindings:[{id:'channel-hosted-larkin',externalId:randomUUID()}]}
})
after(async()=>{await app?.close();await auth?.close();await maintenance?.end();await db?.close()})

test('bootstrap input and transaction-pooler refusal occurs before any database writes',async()=>{
 const normalized=validateHostedDemoInput(input)
 assert.notEqual(normalized.account,input.account);assert.notEqual(normalized.bindings,input.bindings)
 assert.equal(normalized.bindings[0].organizationId,HOSTED_DEMO.organizationId)
 assert.throws(()=>validateHostedDemoInput({...input,account:{...input.account,username:null}}),{code:'invalid_input'})
 for(const override of [{connectionMode:'transaction'},{account:{...input.account,username:'other'}},{account:{...input.account,passwordHash:'invalid'}},
  {appPassword:input.authPassword},{bindings:[{id:'bad-id',externalId:'unbounded unsafe input\n'}]},
  {bindings:[input.bindings[0],input.bindings[0]]},{bindings:[{...input.bindings[0],capabilities:['manage_organization']}]}]){
  let touched=false
  await assert.rejects(bootstrapHostedDemoDatabase({...input,...override,client:{query(){touched=true;throw new Error('Should not query')}}}),{code:'invalid_input'})
  assert.equal(touched,false)
 }
 assert.equal((await db.admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname LIKE 'atrium_%'")).rows[0].n,0)
})

test('preexisting Atrium roles are refused and preserved instead of adopted or reset',async()=>{
 await db.admin.query('CREATE ROLE atrium_app NOLOGIN NOSUPERUSER NOBYPASSRLS')
 try{
  await assert.rejects(bootstrapHostedDemoDatabase(input),{code:'existing_state'})
  assert.equal((await db.admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='atrium_app'")).rows[0].rolcanlogin,false)
  assert.equal((await db.admin.query("SELECT to_regnamespace('atrium_hosted') n")).rows[0].n,null)
 }finally{await db.admin.query('DROP ROLE atrium_app')}
})

test('non-superuser maintenance provisions roles/migrations and a failed seed rolls back every demo row',async()=>{
 const identity=(await maintenance.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
 assert.deepEqual(identity,{rolsuper:false,rolbypassrls:false})
 const failClient={async query(sql,values){
  if(typeof sql==='string'&&sql.startsWith('INSERT INTO atrium.channel_bindings'))throw new Error(`Synthetic seed failure must redact ${input.appPassword}`)
  return query(sql,values)
 }}
 const failure=await bootstrapHostedDemoDatabase({...input,client:failClient}).then(()=>null,error=>error)
 assert.equal(failure?.code,'bootstrap_failed',JSON.stringify(sqlFailures));assert.equal(failure?.stage,'seed',JSON.stringify(sqlFailures))
 assert.ok(!JSON.stringify(failure).includes(input.appPassword));assert.equal(failure.cause,undefined)
 for(const table of ['users','user_credentials','organizations','properties','memberships','property_grants','property_configurations','channel_bindings']){
  assert.equal((await db.admin.query(`SELECT count(*)::int n FROM atrium.${table}`)).rows[0].n,0,table)
 }
 assert.equal((await db.admin.query('SELECT complete FROM atrium_hosted.bootstrap')).rows[0].complete,false)
 assert.ok((await db.admin.query('SELECT count(*)::int n FROM atrium_migrations.history')).rows[0].n>0)
})

test('resumption seeds the exact dated fictional property, account and caller-supplied channel atomically',async()=>{
 const beforePublication=(await maintenance.query('SELECT clock_timestamp() at')).rows[0].at
 const result=await bootstrapHostedDemoDatabase(input)
 const afterPublication=(await maintenance.query('SELECT clock_timestamp() at')).rows[0].at
 assert.equal(result.rolesCreated,false);assert.equal(result.seeded,true);assert.deepEqual(result.migrations,[])
 assert.deepEqual(result.bindingIds,[input.bindings[0].id]);assert.equal(result.sourceMode,'demo')
 const current=(await db.admin.query(`SELECT p.organization_id,p.published_configuration_version,c.inventory_read_at,c.inventory_source,c.configuration,c.published_at
  FROM atrium.properties p JOIN atrium.property_configurations c ON c.property_id=p.id AND c.organization_id=p.organization_id AND c.version=p.published_configuration_version`)).rows[0]
 assert.equal(current.organization_id,HOSTED_DEMO.organizationId);assert.equal(Number(current.published_configuration_version),1)
 assert.equal(current.inventory_read_at.toISOString(),'2026-09-01T00:00:00.000Z')
 assert.ok(current.published_at>=beforePublication&&current.published_at<=afterPublication)
 assert.deepEqual(current.configuration.inventoryProvenance,{sourceMode:'demo',catalogAsOf:'2026-09-01T00:00:00.000Z',catalogVersion:'larkin-demo-v1',fictional:true})
 assert.match(current.inventory_source,/fictional.*no PMS/);assert.equal(current.configuration.property.timeZone,'America/New_York')
 assert.equal(current.configuration.property.tourSettings.capacity,2)
 const commit=(await db.admin.query(`SELECT (SELECT xmin::text FROM atrium.users WHERE id=$1) account,
  (SELECT xmin::text FROM atrium.property_configurations WHERE property_id=$2) configuration,
  (SELECT xmin::text FROM atrium.channel_bindings WHERE id=$3) binding,(SELECT xmin::text FROM atrium_hosted.bootstrap) marker`,[HOSTED_DEMO.userId,HOSTED_DEMO.propertyId,input.bindings[0].id])).rows[0]
 assert.equal(commit.account,commit.configuration);assert.equal(commit.account,commit.binding);assert.equal(commit.account,commit.marker)
 assert.equal((await db.admin.query('SELECT password_hash FROM atrium.user_credentials')).rows[0].password_hash,initialHash)
 const marker=JSON.stringify((await db.admin.query('SELECT manifest FROM atrium_hosted.bootstrap')).rows[0].manifest)
 for(const value of [input.appPassword,input.authPassword,initialHash,userPassword])assert.ok(!marker.includes(value))
 for(const table of ['user_sessions','mfa_factors','operational_documents','calendars'])assert.equal((await db.admin.query(`SELECT count(*)::int n FROM atrium.${table}`)).rows[0].n,0)
})

test('actual restricted connections preserve authentication, required MFA and scoped channel operations without Data API access',async()=>{
 app=new DatabaseConnection(db.connection('atrium_app',input.appPassword),'atrium_app')
 auth=new DatabaseConnection(db.connection('atrium_authenticator',input.authPassword),'atrium_authenticator')
 runtime=createDatabaseRuntime({app,auth,sessionSecret:secret(),authOrigin:'https://hosted.atrium.example'})
 const identity=await runtime.authorization.authenticatePassword('larkin',userPassword);assert.equal(identity.userId,HOSTED_DEMO.userId)
 const principal=await runtime.sessions.start(identity,{label:'Synthetic hosted browser'})
 assert.equal((await runtime.mfa.state(principal)).required,true)
 await assert.rejects(runtime.loadUserProperty(principal,HOSTED_DEMO,'read'),{code:'mfa_required'})
 const channel=await runtime.loadChannel('vapi',input.bindings[0].externalId)
 assert.equal(channel.scope.organizationId,HOSTED_DEMO.organizationId);assert.equal(channel.scope.propertyId,HOSTED_DEMO.propertyId)
 assert.ok(channel.snapshot.inventory.units.length>0)
 await channel.documents.set('hosted-bootstrap-proof',{synthetic:true})
 assert.deepEqual(await channel.documents.get('hosted-bootstrap-proof'),{synthetic:true})
 await assert.rejects(runtime.loadChannel('vapi',randomUUID()))
 for(const connection of [app,auth]){
  for(const query of ['SELECT * FROM atrium_hosted.bootstrap','SELECT * FROM atrium_migrations.history','UPDATE atrium.user_credentials SET password_hash=password_hash']){
   await assert.rejects(connection.transaction({},client=>client.query(query)),{code:'42501'})
  }
 }
 const roles=(await db.admin.query("SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolcanlogin FROM pg_roles WHERE rolname LIKE 'atrium_%' ORDER BY rolname")).rows
 assert.equal(roles.length,9);assert.ok(roles.every(role=>!role.rolsuper&&!role.rolbypassrls&&!role.rolcreaterole&&!role.rolcreatedb&&!role.rolreplication))
 assert.deepEqual(roles.filter(role=>role.rolcanlogin).map(role=>role.rolname),['atrium_app','atrium_authenticator'])
 for(const role of ['anon','authenticated','service_role']){
  assert.equal((await db.admin.query("SELECT has_schema_privilege($1,'atrium','USAGE') allowed",[role])).rows[0].allowed,false)
 }
 assert.ok((await db.admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='atrium' AND c.relkind='r'")).rows.every(row=>row.relrowsecurity&&row.relforcerowsecurity))
})

test('reruns preserve current credential/settings and reject changed binding manifests',async()=>{
 const rotated=await hashPassword(secret())
 await db.admin.query('UPDATE atrium.user_credentials SET password_hash=$1 WHERE user_id=$2',[rotated,HOSTED_DEMO.userId])
 const channel=await runtime.loadChannel('vapi',input.bindings[0].externalId)
 await channel.documents.set('staff-owned-setting',{preserve:true})
 const result=await bootstrapHostedDemoDatabase({...input,appPassword:secret(),authPassword:secret()})
 assert.equal(result.seeded,false);assert.equal(result.credentialsPreserved,true);assert.deepEqual(result.migrations,[])
 assert.equal((await db.admin.query('SELECT password_hash FROM atrium.user_credentials WHERE user_id=$1',[HOSTED_DEMO.userId])).rows[0].password_hash,rotated)
 assert.deepEqual(await channel.documents.get('staff-owned-setting'),{preserve:true})
 await assert.rejects(bootstrapHostedDemoDatabase({...input,bindings:[{...input.bindings[0],externalId:randomUUID()}]}),{code:'existing_state'})
 assert.equal((await db.admin.query('SELECT external_id FROM atrium.channel_bindings')).rows[0].external_id,input.bindings[0].externalId)
 await auth.transaction({},client=>client.query('SELECT 1'))
})

test('unexpected runtime inheritance is refused without repairing or weakening roles',async()=>{
 await db.admin.query('GRANT atrium_admin TO atrium_app')
 try{await assert.rejects(bootstrapHostedDemoDatabase(input),{code:'existing_state'})}
 finally{await db.admin.query('REVOKE atrium_admin FROM atrium_app')}
 await db.admin.query('GRANT pg_read_all_data TO atrium_mfa_executor')
 try{await assert.rejects(bootstrapHostedDemoDatabase(input),{code:'existing_state'})}
 finally{await db.admin.query('REVOKE pg_read_all_data FROM atrium_mfa_executor')}
 assert.equal((await db.admin.query('SELECT complete FROM atrium_hosted.bootstrap')).rows[0].complete,true)
})

test('empty-table RLS, ownership and public/API privilege drift refuses readiness without implicit repair',async()=>{
 assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.calendars')).rows[0].n,0)
 for(const [weaken,restore,verify] of [
  ['ALTER TABLE atrium.calendars DISABLE ROW LEVEL SECURITY','ALTER TABLE atrium.calendars ENABLE ROW LEVEL SECURITY',"SELECT NOT relrowsecurity changed FROM pg_class WHERE oid='atrium.calendars'::regclass"],
  ['ALTER TABLE atrium.calendars NO FORCE ROW LEVEL SECURITY','ALTER TABLE atrium.calendars FORCE ROW LEVEL SECURITY',"SELECT NOT relforcerowsecurity changed FROM pg_class WHERE oid='atrium.calendars'::regclass"],
  ['ALTER TABLE atrium.calendars OWNER TO hosted_provisioner','ALTER TABLE atrium.calendars OWNER TO atrium_admin',"SELECT pg_get_userbyid(relowner)='hosted_provisioner' changed FROM pg_class WHERE oid='atrium.calendars'::regclass"],
  ['GRANT USAGE ON SCHEMA atrium TO PUBLIC','REVOKE USAGE ON SCHEMA atrium FROM PUBLIC',"SELECT has_schema_privilege('anon','atrium','USAGE') changed"],
  ['GRANT SELECT ON atrium.calendars TO authenticated','REVOKE SELECT ON atrium.calendars FROM authenticated',"SELECT has_table_privilege('authenticated','atrium.calendars','SELECT') changed"],
  ['GRANT EXECUTE ON FUNCTION atrium.context(text) TO PUBLIC','REVOKE EXECUTE ON FUNCTION atrium.context(text) FROM PUBLIC',"SELECT has_function_privilege('anon','atrium.context(text)','EXECUTE') changed"],
 ]){
  await db.admin.query(weaken)
  try{
   await assert.rejects(bootstrapHostedDemoDatabase(input),{code:'existing_state'})
   assert.equal((await db.admin.query(verify)).rows[0].changed,true)
  }finally{await db.admin.query(restore)}
 }
 assert.equal((await bootstrapHostedDemoDatabase(input)).seeded,false)
})

test('disabled seeded membership is reported without regranting access on a rerun',async()=>{
 await db.admin.query("UPDATE atrium.memberships SET status='revoked',permission_version=permission_version+1 WHERE id=$1",[HOSTED_DEMO.membershipId])
 await assert.rejects(bootstrapHostedDemoDatabase(input),{code:'existing_state'})
 assert.equal((await db.admin.query('SELECT status FROM atrium.memberships WHERE id=$1',[HOSTED_DEMO.membershipId])).rows[0].status,'revoked')
})
