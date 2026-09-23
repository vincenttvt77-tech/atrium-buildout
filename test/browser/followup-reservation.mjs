/** Actual Chromium, production HTTP handlers and disposable PostgreSQL.
 * Synthetic signed MFA fixture; no real browser profile, provider or live data.
 * Set ATRIUM_PLAYWRIGHT_MODULE / ATRIUM_CHROME_EXECUTABLE when not on PATH.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { emptyProfile } from '../../src/leads/profile.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { verifyMfaCookie } from '../helpers/mfa-session.mjs'
import { buildAuthClient } from '../../scripts/build-auth.mjs'

const playwrightModule = process.env.ATRIUM_PLAYWRIGHT_MODULE
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright')
await buildAuthClient()
const routes = new Map(await Promise.all(['dashboard', 'mfa', 'account', 'properties', 'calendar', 'leads', 'vapi', 'health', 'workflows']
  .map(async name => [`/api/${name}`, (await import(`../../api/${name}.ts`)).default])))
const originalFetch = globalThis.fetch
const oldMode = process.env.ATRIUM_RUNTIME_MODE
let db, server, browser, runtime, origin
const errors = [], checks = []
const artifacts = process.env.ATRIUM_BROWSER_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
try {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  const { password } = await seedFoundationTestDatabase(db.admin)
  const bundle = { property: { id: 'property-a1', organizationId: 'organization-a', buildingName: 'Synthetic browser building',
    timeZone: 'America/New_York', address: '1 Synthetic Avenue', jurisdiction: 'NY', tourSettings: { ...defaultSettings(), capacity: 4, sameUnitPolicy: 'shared', hours: Object.fromEntries([0,1,2,3,4,5,6].map(day=>[day,{openHour:8,closeHour:20}])) },
    tourConfirmationEmail: { provider: 'resend', organizationId: 'organization-a', propertyId: 'property-a1', from: 'Fixture <leasing@example.test>', replyTo: 'leasing@example.test', reviewExpiresAt: new Date(Date.now()+7*86400000).toISOString() } }, inventory: [], floorplans: [], knowledge: [] }
  await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    VALUES('organization-a','property-a1',1,'published',$1,now(),'synthetic-browser',now())`, [JSON.stringify(bundle)])
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
  // The fixture has no voice integration. Both browser and server deny outbound transport.
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE property_id='property-a1'")
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin)
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return }
      const handler = routes.get(url.pathname)
      if (!handler) { res.statusCode = 404; res.end('Not found'); return }
      req.atriumRuntime = runtime
      let body = ''
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 70000) throw new Error('Oversized test request') }
      req.body = req.headers['content-type']?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body)) : body
      req.query = Object.fromEntries(url.searchParams)
      res.status = code => { res.statusCode = code; return res }
      res.send = value => { res.end(value); return res }
      res.json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res }
      await handler(req, res)
    } catch (error) { errors.push({ name: error.name, code: error.code }); res.statusCode = 500; res.end('Synthetic handler failed') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://localhost:${server.address().port}`
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: randomBytes(40).toString('base64url'), authOrigin: origin })
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
  const start=today+'T17:00:00.000Z',slotId='slot-'+start.slice(0,16)
  const booked=id=>({externalId:id,interactionId:'call-'+id,slotId,startsAt:start,endsAt:today+'T17:30:00.000Z',prospectName:'Test Visitor',prospectPhone:'+12025550101',prospectEmail:null,unitId:null,bookedAt:new Date().toISOString(),revision:0})
  const rows=[booked('one'),booked('two')]
  const profile={...emptyProfile('+12025550101',new Date()),name:'Test Visitor',email:null,
    calls:rows.map(row=>({callId:row.interactionId,at:row.bookedAt,durationSeconds:null,outcome:'Booked',toolsCalled:['book_tour']})),
    bookings:rows.map(row=>({externalId:row.externalId,callId:row.interactionId,slotId,startsAt:start,unitId:null,status:'confirmed'}))}
  const task={id:'confirmation-one',phone:profile.phone,kind:'confirm_tour',channel:'call',dueAt:new Date().toISOString(),reason:'Confirm saved tour',
    status:'scheduled',createdAt:new Date().toISOString(),createdFromCall:'call-one',executable:false,
    source:{version:2,kind:'booking',key:'fixture-source',callId:'call-one',at:rows[0].bookedAt,booking:{...profile.bookings[0],revision:0}}}
  await db.admin.query(`INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES('organization-a','property-a1',$1)`,[JSON.stringify({blocks:[],bookings:rows})])
  await db.admin.query(`INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-a','property-a1',$1,$2)`,['lead:'+profile.phone,JSON.stringify(profile)])
  async function saveTask(){await db.admin.query(`INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-a','property-a1',$1,$2)
    ON CONFLICT(organization_id,property_id,key) DO UPDATE SET value=EXCLUDED.value`,['followup:'+task.id,JSON.stringify(task)])}
  await saveTask()
  globalThis.fetch=async()=>{throw new Error('External services disabled')}
  browser=await chromium.launch({headless:true,...(process.env.ATRIUM_CHROME_EXECUTABLE?{executablePath:process.env.ATRIUM_CHROME_EXECUTABLE}:{})})
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'})
  let mutations=0
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin){await route.fulfill({status:204,body:''});return}
    if(req.method()==='POST'&&['/api/leads','/api/calendar'].includes(url.pathname))mutations++
    await route.continue()})
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`${origin}/api/dashboard?reauthenticate=1`);await page.getByLabel('Username',{exact:true}).fill('owner-a');await page.getByLabel('Password',{exact:true}).fill(password)
  await page.getByRole('button',{name:'Sign in to workspace'}).click();await page.waitForURL('**/api/mfa')
  await verifyMfaCookie(runtime,(await context.cookies(origin)).map(({name,value})=>`${name}=${value}`).join('; '),password)
  const root=`${origin}/api/dashboard?organizationId=organization-a&propertyId=property-a1`
  const tour=id=>page.locator(`.view:not([hidden]) [data-key="tour:${id}"]`)
  for(const width of [1280,390,320]){
    delete task.reconciliation;await saveTask();await page.setViewportSize({width,height:900});await page.goto(root+'#/today')
    await tour('one').waitFor();await tour('two').waitFor()
    await tour('one').getByRole('link',{name:'Call to confirm',exact:true}).waitFor()
    assert.equal(await tour('two').getByRole('link',{name:'Call to confirm',exact:true}).count(),0)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    task.reconciliation={status:'needs_review',code:'legacy_followup_identity_ambiguous',candidateIds:['one','two']};await saveTask()
    await page.evaluate(()=>window.Atrium.refresh())
    assert.equal(await tour('one').getByRole('link',{name:'Call to confirm',exact:true}).count(),0)
    await page.getByText('This older task may refer to more than one tour. Check the booking before contacting the caller.',{exact:true}).first().waitFor()
    await tour('two').getByRole('link',{name:'Open lead',exact:true}).press('Enter')
    await page.locator('.lead-panel .warn-text').waitFor()
    await page.locator('.lead-panel .warn-text').scrollIntoViewIfNeeded()
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    if(artifacts)await page.screenshot({path:`${artifacts}/followup-${width}.png`})
    checks.push(`${width}: one caller's two tours remain distinct; only exact task gets confirmation shortcut; review metadata removes shortcut after real refresh; keyboard Opens lead with visible review warning; no overflow`)
  }
  assert.deepEqual(errors,[]);assert.equal(mutations,0)
  console.log(JSON.stringify({status:'passed',checks,realProviderCalls:0,staffMutations:mutations},null,2))
} finally {
  globalThis.fetch=originalFetch;await browser?.close()
  if(server){server.close();server.closeAllConnections();await once(server,'close')}
  await db?.close()
  if(oldMode===undefined)delete process.env.ATRIUM_RUNTIME_MODE;else process.env.ATRIUM_RUNTIME_MODE=oldMode
}
