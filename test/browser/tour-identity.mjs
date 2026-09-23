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
  const start = new Date(Date.now()+86400000); start.setUTCHours(17,0,0,0)
  const date = start.toISOString().slice(0,10), slotId = 'slot-'+start.toISOString().slice(0,16)
  const booking = (externalId, interactionId) => ({externalId,interactionId,slotId,startsAt:start.toISOString(),
    endsAt:new Date(start.getTime()+1800000).toISOString(),prospectName:'Same Name',prospectPhone:'unknown',
    prospectEmail:null,unitId:null,bookedAt:new Date().toISOString(),revision:0})
  const rows = [booking('reservation-a','call-a'),booking('reservation-b','call-b'),booking('anonymous-reservation','anonymous-call'),booking('other-anonymous','other-anonymous-call')]
  const profile = (row,phone,email) => ({...emptyProfile(phone,new Date()),name:'Same Name',email,
    calls:[{callId:row.interactionId,at:row.bookedAt,durationSeconds:null,outcome:'Booked',toolsCalled:['book_tour']}],
    bookings:[{externalId:row.externalId,slotId,startsAt:row.startsAt,unitId:null,status:'confirmed',callId:row.interactionId}]})
  const profiles = [profile(rows[1],'+12025550202','two@example.test'),profile(rows[0],'+12025550101','one@example.test'),profile(rows[2],'unknown','anonymous@example.test'),profile(rows[3],'unknown','other-anonymous@example.test')]
  async function seed() {
    await db.admin.query(`INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES('organization-a','property-a1',$1::jsonb)
      ON CONFLICT(organization_id,property_id) DO UPDATE SET state=EXCLUDED.state`,[JSON.stringify({bookings:rows,blocks:[]})])
    for (const p of profiles) await db.admin.query(`INSERT INTO atrium.operational_documents(organization_id,property_id,key,value)
      VALUES('organization-a','property-a1',$1,$2::jsonb) ON CONFLICT(organization_id,property_id,key) DO UPDATE SET value=EXCLUDED.value`,
      [p.phone==='unknown'?'lead:anonymous:'+p.calls[0].callId:'lead:'+p.phone,JSON.stringify(p)])
  }
  await seed()
  globalThis.fetch = async () => { throw new Error('External services are disabled in this browser fixture') }
  browser = await chromium.launch({headless:true,...(process.env.ATRIUM_CHROME_EXECUTABLE?{executablePath:process.env.ATRIUM_CHROME_EXECUTABLE}:{})})
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'})
  let mutations=0
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url())
    if(url.origin!==origin){await route.fulfill({status:204,body:''});return}
    if(request.method()==='POST'&&url.pathname==='/api/calendar')mutations++
    await route.continue()
  })
  const page=await context.newPage();page.setDefaultTimeout(12000)
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`${origin}/api/dashboard?reauthenticate=1`)
  await page.getByLabel('Username',{exact:true}).fill('owner-a')
  await page.getByLabel('Password',{exact:true}).fill(password)
  await page.getByRole('button',{name:'Sign in to workspace'}).click()
  await page.waitForURL('**/api/mfa')
  await verifyMfaCookie(runtime,(await context.cookies(origin)).map(({name,value})=>`${name}=${value}`).join('; '),password)
  const root=`${origin}/api/dashboard?organizationId=organization-a&propertyId=property-a1`
  const calendarUrl=(extra='')=>`${root}#/calendar?date=${date}&view=day${extra}`
  const tour=id=>page.locator(`[data-key="tour:reservation:${encodeURIComponent(id)}"]`).filter({visible:true}).first()
  const dialog=()=>page.getByRole('dialog',{name:'Same Name',exact:true})
  async function ready(){await tour('reservation-a').waitFor();await page.waitForFunction(()=>window.Atrium.state.loaded.leads)}
  async function close(){await dialog().getByRole('button',{name:'Close',exact:true}).first().click()}
  async function refresh(){await page.evaluate(()=>window.Atrium.refresh())}
  for(const width of [1280,390,320]){
    await page.setViewportSize({width,height:900});await page.goto(calendarUrl());await ready()
    while(await page.locator('.toast-close').count())await page.locator('.toast-close').first().click()
    await tour('reservation-b').press('Enter')
    await dialog().locator('a[href="mailto:two@example.test"]').waitFor()
    assert.equal(await dialog().locator('a[href="mailto:one@example.test"]').count(),0)
    assert.match(await dialog().getByRole('link',{name:'Open lead',exact:true}).getAttribute('href'),/phone=%2B12025550202/)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    assert.ok(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth+1))
    if(artifacts)await page.screenshot({path:`${artifacts}/reservation-${width}.png`})
    await close()
    await page.goto(calendarUrl('&booking=reservation-b'))
    await dialog().locator('a[href="mailto:two@example.test"]').waitFor();await close()
    // An older/wrong date still follows the exact reservation after loading its actual day.
    await page.goto(`${root}#/calendar?date=2032-06-01&view=day&booking=reservation-a`)
    await dialog().locator('a[href="mailto:one@example.test"]').waitFor();await close()
    await page.goto(calendarUrl('&slot='+encodeURIComponent(slotId)));await ready()
    await page.getByText('Several tours share that time. Choose the reservation you want.',{exact:true}).first().waitFor()
    assert.equal(await dialog().count(),0)
    await tour('anonymous-reservation').press('Enter')
    const link=dialog().getByRole('link',{name:'Open lead',exact:true})
    assert.match(await link.getAttribute('href'),/phone=unknown&call=anonymous-call/)
    await link.press('Enter');await page.waitForURL('**/*call=anonymous-call')
    await page.locator('.lead-panel a[href*="booking=anonymous-reservation"]').first().waitFor()
    assert.equal(await page.locator('.lead-panel a[href*="booking=other-anonymous"]').count(),0)
    console.log('Viewport passed:',width)
    checks.push(`${width}: keyboard opens exact contact; direct and wrong-date links follow reservation; ambiguous time refused; anonymous lead retains call; no horizontal overflow`)
  }
  await page.setViewportSize({width:1280,height:900});await page.goto(calendarUrl());await ready()
  await tour('reservation-b').press('Enter')
  rows.reverse();await seed();await refresh()
  await dialog().locator('a[href="mailto:two@example.test"]').waitFor()
  checks.push('reordering simultaneous saved reservations preserves the open reservation and contact')
  profiles[0].email='updated@example.test';await seed();await refresh()
  await dialog().waitFor({state:'hidden'})
  await tour('reservation-b').press('Enter')
  await dialog().locator('a[href="mailto:updated@example.test"]').waitFor();await close()
  checks.push('contact-only update closes stale details; reopening shows current saved contact')
  rows.splice(0,rows.length,booking('reservation-a','call-a'),booking('reservation-a','call-a'))
  await seed();await refresh()
  await page.locator('.cal-tour, [data-action="agenda-tour"]').filter({visible:true}).first().press('Enter')
  await dialog().getByText('This reservation could not be matched to one saved record.',{exact:false}).waitFor()
  assert.equal(await dialog().getByRole('button',{name:'Reschedule',exact:true}).count(),0)
  assert.equal(await dialog().getByRole('button',{name:'Email confirmation',exact:true}).count(),0)
  assert.equal(await dialog().getByRole('link',{name:'Open lead',exact:true}).count(),0)
  assert.equal(await dialog().locator('a[href^="tel:"]').count(),0)
  await close()
  await page.goto(calendarUrl('&booking=reservation-b'))
  await page.getByText('That reservation is not uniquely available in the saved calendar.',{exact:true}).first().waitFor()
  assert.equal(await dialog().count(),0)
  checks.push('duplicate IDs are visibly nonactionable; removed reservation link never opens its replacement')
  assert.equal(mutations,0)
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({status:'passed',checks,realProviderCalls:0,calendarMutations:mutations},null,2))
} finally {
  globalThis.fetch=originalFetch
  await browser?.close()
  if(server){server.close();server.closeAllConnections();await once(server,'close')}
  await db?.close()
  if(oldMode===undefined)delete process.env.ATRIUM_RUNTIME_MODE;else process.env.ATRIUM_RUNTIME_MODE=oldMode
}
