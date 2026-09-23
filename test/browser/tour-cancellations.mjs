/** Actual Chromium, production HTTP handlers and disposable PostgreSQL.
 * Synthetic signed MFA fixture; no real browser profile, provider or live data.
 * Set ATRIUM_PLAYWRIGHT_MODULE / ATRIUM_CHROME_EXECUTABLE when not on PATH.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { createTourConfirmationsHandler } from '../../api/tour-confirmations.ts'
import { ResendTransport } from '../../src/email/render.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { verifyMfaCookie } from '../helpers/mfa-session.mjs'
import { buildAuthClient } from '../../scripts/build-auth.mjs'

const playwrightModule = process.env.ATRIUM_PLAYWRIGHT_MODULE
const { chromium } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : 'playwright')
await buildAuthClient()
const routes = new Map(await Promise.all(['dashboard', 'mfa', 'account', 'properties', 'calendar', 'leads', 'vapi', 'health', 'workflows', 'tour-contacts', 'tour-cancellations']
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
    timeZone: 'America/New_York', address: '1 Synthetic Avenue', jurisdiction: 'NY', tourSettings: defaultSettings(),
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
  let providerReady = false, sends = 0
  const messages = new Map()
  routes.set('/api/tour-confirmations', createTourConfirmationsHandler({ provider: {
    get configured() { return providerReady }, transport: () => new ResendTransport('browser-fixture-only', { fetch: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.resend.com')
      if (options.method === 'POST') { sends++; const id=randomUUID(); messages.set(id,JSON.parse(options.body)); return Response.json({ id }) }
      const id=new URL(url).pathname.split('/').at(-1), body=messages.get(id)
      return Response.json({ object:'email',id,...body,cc:[],bcc:[],reply_to:body.reply_to??[],last_event:'delivered' })
    } }),
  } }))
  const start=new Date(Date.now()+86400000); start.setUTCHours(14,0,0,0)
  const booking={externalId:'browser-tour',slotId:'slot-'+start.toISOString().slice(0,16),startsAt:start.toISOString(),endsAt:new Date(start.getTime()+1800000).toISOString(),
    interactionId:'browser-original-call',prospectName:'Test Visitor',prospectEmail:'visitor@example.test',prospectPhone:'+12025550101',unitId:null,bookedAt:new Date().toISOString(),revision:0}
  async function seedBooking() {
    await db.admin.query(`INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES('organization-a','property-a1',$1::jsonb)
      ON CONFLICT(organization_id,property_id) DO UPDATE SET state=EXCLUDED.state`,[JSON.stringify({bookings:[booking],blocks:[]})])
  }
  await seedBooking()
  globalThis.fetch = async () => { throw new Error('External services are disabled in this browser fixture') }
  browser = await chromium.launch({ headless: true, ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
  const context = await browser.newContext({ viewport:{width:1280,height:900},reducedMotion:'reduce' })
  let loseReply=false
  const commands=[]
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    if(url.origin!==origin){await route.fulfill({status:204,body:''});return}
    if(url.pathname==='/api/tour-cancellations'&&request.method()==='POST') {
      commands.push(request.postDataJSON())
      if(loseReply){loseReply=false;const response=await route.fetch();assert.equal(response.status(),200);await response.dispose();await route.abort('connectionreset');return}
    }
    await route.continue()
  })
  const page=await context.newPage();page.setDefaultTimeout(12000)
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`${origin}/api/dashboard?reauthenticate=1`)
  await page.getByLabel('Username',{exact:true}).fill('owner-a');await page.getByLabel('Password',{exact:true}).fill(password)
  await page.getByRole('button',{name:'Sign in to workspace'}).click();await page.waitForURL('**/api/mfa')
  const cookie=(await context.cookies(origin)).map(({name,value})=>`${name}=${value}`).join('; ')
  await verifyMfaCookie(runtime,cookie,password)
  const calendarUrl=()=>`${origin}/api/dashboard?organizationId=organization-a&propertyId=property-a1#/calendar?date=${start.toISOString().slice(0,10)}`
  async function waitWorkspace(){await page.waitForFunction(()=>{const s=window.Atrium?.state;return s&&['calendar','leads','calls'].every(key=>s.loaded[key]&&!s.errors[key])})}
  async function reset(){booking.revision++;await seedBooking();await db.admin.query('DELETE FROM atrium.operational_documents');await page.goto(calendarUrl());await page.reload();await waitWorkspace();await page.waitForFunction(revision=>window.Atrium.state.calendar.bookings[0]?.revision===revision,booking.revision);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
  async function open(){await waitWorkspace();await page.waitForFunction(()=>document.querySelector('.cal-tour,[data-action="agenda-tour"]') && !window.Atrium.busyNow('calendar'));await page.locator('.cal-tour,[data-action="agenda-tour"]').first().press('Enter');await page.getByRole('button',{name:'Cancel tour',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Cancel tour',exact:true});await dialog.getByLabel('Cancellation reason',{exact:true}).waitFor();return dialog}
  async function fill(dialog){await dialog.getByLabel('Cancellation reason',{exact:true}).fill('Prospect can no longer attend');await dialog.getByLabel('I verified this is the reservation to cancel.',{exact:true}).check()}
  const saved=async()=> (await db.admin.query("SELECT state FROM atrium.calendars WHERE property_id='property-a1'")).rows[0].state
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:900});await reset();const dialog=await open()
    assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    await dialog.getByLabel('Cancellation reason',{exact:true}).fill('Prospect can no longer attend')
    assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    await dialog.getByLabel('I verified this is the reservation to cancel.',{exact:true}).check()
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    await dialog.locator('.dlg-primary').click();await dialog.getByText('Tour cancelled. Its capacity is available again. Cancelling does not automatically send a message.',{exact:true}).waitFor()
    assert.equal((await saved()).bookings.length,0);assert.equal((await saved()).cancelledBookings.length,1)
    assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    assert.equal(await dialog.getByLabel('Cancellation reason',{exact:true}).count(),0)
    if(artifacts&&width!==390)await page.screenshot({path:`${artifacts}/cancelled-${width}.png`,fullPage:true})
    await dialog.locator('.dlg-secondary').click();await page.waitForFunction(()=>window.Atrium.state.calendar.cancelledBookings.length===1)
    await page.locator('.cal-tour,[data-action="agenda-tour"]').first().waitFor({state:'detached'})
    assert.equal(await page.locator('.cal-tour,[data-action="agenda-tour"]').count(),0)
    await page.getByRole('button',{name:'Cancellations',exact:true}).click()
    const history=page.getByRole('dialog',{name:'Recent cancellations',exact:true});await history.locator('[data-cancel-history]').click()
    const detail=page.getByRole('dialog',{name:'Cancel tour',exact:true});await detail.getByText('Prospect can no longer attend',{exact:true}).waitFor()
    assert.match(await detail.innerText(),/owner-a/);await detail.locator('.dlg-secondary').click()
    checks.push(`${width}px: exact reservation review, required attestation, actual cancellation, released capacity and durable history without horizontal overflow`)
  }
  await reset();let dialog=await open();await fill(dialog);loseReply=true;await dialog.locator('.dlg-primary').click()
  await dialog.getByRole('button',{name:'Check saved cancellation',exact:true}).waitFor()
  assert.ok(await dialog.getByLabel('Cancellation reason',{exact:true}).isDisabled())
  await dialog.locator('.dlg-primary').click();await dialog.getByText('Tour cancelled. Its capacity is available again. Cancelling does not automatically send a message.',{exact:true}).waitFor()
  assert.deepEqual(commands.at(-1),commands.at(-2));assert.equal((await saved()).cancelledBookings.length,1)
  await dialog.locator('.dlg-secondary').click();checks.push('lost committed reply recovers one cancellation through the identical frozen request')
  await reset();dialog=await open();await fill(dialog);booking.prospectName='New staff-reviewed contact';booking.revision++;await seedBooking()
  await dialog.locator('.dlg-primary').click();await dialog.getByRole('button',{name:'Reload reservation',exact:true}).waitFor()
  assert.equal((await saved()).bookings.length,1);await dialog.locator('.dlg-primary').click()
  await dialog.getByText('New staff-reviewed contact',{exact:true}).waitFor()
  assert.equal(await dialog.getByLabel('I verified this is the reservation to cancel.',{exact:true}).isChecked(),false)
  assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
  await dialog.locator('.dlg-secondary').click();checks.push('stale reservation refuses cancellation and reload requires fresh staff review')
  await reset();dialog=await open();await dialog.getByRole('button',{name:'Review work queue',exact:true}).click()
  await page.waitForURL('**/api/dashboard?organizationId=organization-a&propertyId=property-a1#/workflows')
  assert.equal(await page.getByRole('dialog',{name:'Cancel tour',exact:true}).count(),0)
  checks.push('work-queue link opens the real queue and closes the cancellation form')
  await reset()
  let releaseRead,readStarted,readDone
  const holdRead=new Promise(r=>releaseRead=r),startedRead=new Promise(r=>readStarted=r),doneRead=new Promise(r=>readDone=r)
  await page.route('**/api/tour-cancellations?*',async route=>{readStarted();await holdRead;await route.continue();readDone()})
  await page.locator('.cal-tour,[data-action="agenda-tour"]').first().press('Enter');await page.getByRole('button',{name:'Cancel tour',exact:true}).click();await startedRead
  await page.evaluate(()=>window.Atrium.navigate('leads'));assert.equal(await page.getByRole('dialog',{name:'Cancel tour',exact:true}).count(),0)
  releaseRead();await doneRead;await page.unroute('**/api/tour-cancellations?*');assert.equal(await page.getByRole('dialog',{name:'Cancel tour',exact:true}).count(),0)
  checks.push('navigation retires an in-flight cancellation preview and its late response')
  await reset()
  await page.route('**/api/tour-cancellations?*',async route=>{const response=await route.fetch(),body=await response.json();body.scope.propertyId='different-property';await route.fulfill({response,json:body});await response.dispose()})
  await page.locator('.cal-tour,[data-action="agenda-tour"]').first().press('Enter');await page.getByRole('button',{name:'Cancel tour',exact:true}).click()
  await page.getByText('The property or your access changed.',{exact:false}).waitFor()
  assert.equal(await page.getByRole('dialog',{name:'Cancel tour',exact:true}).count(),0);assert.equal(await page.locator('.view:not([hidden])').count(),0)
  checks.push('mismatched property response retires the form and cached workspace')
  assert.deepEqual(errors,[]);assert.equal(sends,0)
  console.log(JSON.stringify({status:'passed',checks,syntheticProviderSends:sends,realEmailsSent:0},null,2))
}catch(error){
  const pages=browser?.contexts()[0]?.pages()??[];const failed=pages[0];if(failed){console.log((await failed.locator('body').innerText()).slice(-6000));if(artifacts)await failed.screenshot({path:artifacts+'/failure.png',fullPage:true})}throw error
}finally{
  globalThis.fetch=originalFetch;await browser?.close()
  if(server){server.close();server.closeAllConnections();await once(server,'close')}
  await db?.close();if(oldMode===undefined)delete process.env.ATRIUM_RUNTIME_MODE;else process.env.ATRIUM_RUNTIME_MODE=oldMode
}
