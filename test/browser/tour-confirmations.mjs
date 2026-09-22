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
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { createTourConfirmationsHandler } from '../../api/tour-confirmations.ts'
import { ResendTransport } from '../../src/email/render.ts'
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
    prospectName:'Test Visitor',prospectEmail:'visitor@example.test',prospectPhone:'+12025550101',unitId:null,bookedAt:new Date().toISOString(),revision:0}
  async function seedBooking() {
    await db.admin.query(`INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES('organization-a','property-a1',$1::jsonb)
      ON CONFLICT(organization_id,property_id) DO UPDATE SET state=EXCLUDED.state`,[JSON.stringify({bookings:[booking],blocks:[]})])
  }
  await seedBooking()
  globalThis.fetch = async () => { throw new Error('External services are disabled in this browser fixture') }
  browser = await chromium.launch({ headless: true, ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
  const context = await browser.newContext({ viewport:{width:1280,height:900},reducedMotion:'reduce' })
  let loseResponse = null
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) { await route.fulfill({status:204,body:''}); return }
    if (loseResponse && url.pathname === '/api/tour-confirmations' && request.method() === 'POST'
      && request.postDataJSON()?.action === loseResponse) {
      // Let the real handler commit, then lose only the browser acknowledgement.
      loseResponse = null
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      await response.dispose()
      await route.abort('connectionreset')
      return
    }
    await route.continue()
  })
  const page=await context.newPage();page.setDefaultTimeout(12000)
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`${origin}/api/dashboard?reauthenticate=1`)
  await page.getByLabel('Username',{exact:true}).fill('owner-a')
  await page.getByLabel('Password',{exact:true}).fill(password)
  await page.getByRole('button',{name:'Sign in to workspace'}).click()
  await page.waitForURL('**/api/mfa')
  const cookie=(await context.cookies(origin)).map(({name,value})=>`${name}=${value}`).join('; ')
  await verifyMfaCookie(runtime,cookie,password)
  async function openConfirmation() {
    await page.locator('.cal-tour, [data-action="agenda-tour"]').first().press('Enter')
    await page.getByRole('button',{name:'Email confirmation',exact:true}).click()
    await page.locator('.tour-email-preview').waitFor()
    return page.getByRole('dialog',{name:'Tour confirmation',exact:true})
  }
  for(const width of [320,390,1280]) {
    booking.revision++;await seedBooking();providerReady=false
    await page.setViewportSize({width,height:900})
    await page.goto(`${origin}/api/dashboard?organizationId=organization-a&propertyId=property-a1#/calendar?date=${start.toISOString().slice(0,10)}`)
    await page.locator('.cal-tour, [data-action="agenda-tour"]').first().waitFor()
    let dialog=await openConfirmation()
    assert.match(await dialog.innerText(),/visitor@example.test/)
    assert.match(await dialog.innerText(),/not configured/)
    assert.equal(await dialog.locator('[name="emailPermission"]').count(),0)
    assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1))
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    checks.push(`${width}: scoped tour preview, provider-unavailable state and no horizontal overflow`)
    await dialog.locator('.dlg-secondary').click();providerReady=true
    dialog=await openConfirmation()
    assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    await dialog.getByLabel('The prospect agreed',{exact:false}).press('Space')
    await dialog.locator('.dlg-primary').press('Enter')
    await dialog.getByText('Delivery is not yet verified.',{exact:false}).waitFor()
    assert.equal(sends,[320,390,1280].indexOf(width)+1)
    await new Promise(resolve=>setTimeout(resolve,1100))
    await dialog.getByRole('button',{name:'Check delivery',exact:true}).press('Enter')
    await dialog.getByText('The provider reports delivery.',{exact:false}).waitFor()
    assert.equal(await dialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
    if(artifacts) await page.screenshot({path:`${artifacts}/confirmation-${width}.png`})
    checks.push(`${width}: keyboard permission, submission and separately verified delivery`)
    await dialog.locator('.dlg-secondary').click();dialog=await openConfirmation()
    await dialog.getByText('The provider reports delivery.',{exact:false}).waitFor()
    assert.equal(await dialog.locator('[name="emailPermission"]').count(),0)
    assert.equal(sends,[320,390,1280].indexOf(width)+1)
    checks.push(`${width}: reopening retains delivery evidence and cannot duplicate the send`)
    await dialog.locator('.dlg-secondary').click()
  }
  for (const action of ['queue', 'process']) {
    booking.revision++; await seedBooking()
    await page.reload()
    let dialog = await openConfirmation(), before = sends
    await dialog.getByLabel('The prospect agreed', {exact:false}).press('Space')
    loseResponse = action
    await dialog.locator('.dlg-primary').press('Enter')
    await dialog.getByRole('button', {name:'Reload confirmation', exact:true}).waitFor()
    assert.equal(sends, before + (action === 'process' ? 1 : 0))
    await dialog.getByRole('button', {name:'Reload confirmation', exact:true}).click()
    if (action === 'queue') {
      await dialog.getByRole('button', {name:'Send saved confirmation', exact:true}).click()
    }
    await dialog.getByText('Delivery is not yet verified.', {exact:false}).waitFor()
    await new Promise(resolve=>setTimeout(resolve,1100))
    await dialog.getByRole('button', {name:'Check delivery', exact:true}).click()
    await dialog.getByText('The provider reports delivery.', {exact:false}).waitFor()
    assert.equal(sends, before + 1)
    await dialog.locator('.dlg-secondary').click()
    checks.push(`lost ${action} response: reload recovers the same permission/action, with exactly one provider submission`)
  }
  booking.revision++; await seedBooking(); await page.reload()
  const staleDialog = await openConfirmation(), before = sends
  booking.revision++; await seedBooking()
  await staleDialog.getByLabel('The prospect agreed', {exact:false}).press('Space')
  await staleDialog.locator('.dlg-primary').press('Enter')
  await staleDialog.getByRole('button', {name:'Reload confirmation', exact:true}).waitFor()
  assert.equal(sends,before)
  await staleDialog.getByRole('button', {name:'Reload confirmation', exact:true}).click()
  await staleDialog.getByLabel('The prospect agreed', {exact:false}).waitFor()
  assert.equal(await staleDialog.locator('.dlg-primary').getAttribute('aria-disabled'),'true')
  await staleDialog.locator('.dlg-secondary').click()
  checks.push('stale browser form cannot save permission or send; current preview requires renewed staff confirmation')
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({status:'passed',checks,syntheticProviderSends:sends,realEmailsSent:0},null,2))
} finally {
  globalThis.fetch=originalFetch
  await browser?.close()
  if(server){server.close();server.closeAllConnections();await once(server,'close')}
  await db?.close()
  if(oldMode===undefined)delete process.env.ATRIUM_RUNTIME_MODE;else process.env.ATRIUM_RUNTIME_MODE=oldMode
}
