/** Actual Chromium, production HTTP handlers and disposable PostgreSQL.
 * Synthetic signed MFA fixture; no real browser profile, provider or live data.
 * Set ATRIUM_PLAYWRIGHT_MODULE / ATRIUM_CHROME_EXECUTABLE when not on PATH.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createEmailReconciliationHandler } from '../../api/email-reconciliation.ts'
import { emailWorkflowAction, emailMessageDigest } from '../../src/email/workflow.ts'
import { ResendTransport } from '../../src/email/render.ts'
import { mkdir } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
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
let db, server, browser, runtime, origin, diagnosticPage
const errors = [], failures = [], checks = []
const artifacts = process.env.ATRIUM_BROWSER_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
try {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  const { password } = await seedFoundationTestDatabase(db.admin)
  const bundle = { property: { id: 'property-a1', organizationId: 'organization-a', buildingName: 'Synthetic browser building',
    timeZone: 'America/New_York', jurisdiction: 'NY', tourSettings: defaultSettings(), voiceShortlistEmail: {
      provider:'resend',organizationId:'organization-a',propertyId:'property-a1',from:'Leasing <leasing@example.test>',replyTo:'leasing@example.test',
      reviewExpiresAt:new Date(Date.now()+86400000).toISOString() } }, inventory: [], floorplans: [], knowledge: [] }
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
  const principal = await runtime.authorization.authenticatePassword('owner-a', password)
  const scope = await runtime.authorization.authorizeProperty(principal, 'property-a1', 'configure')
  const repository = new PostgresWorkflowRepository(db.app, scope, { requestId: 'synthetic-browser-queue', configurationVersion: 1 })
  async function accept(kind) {
    const marker = randomUUID()
    return (await repository.accept({ source: 'synthetic-browser-queue', eventId: marker,
      payload: { private: 'do-not-display-private-context' }, actions: [{ kind, connector: 'synthetic-pms',
        operationKey: marker, input: { private: 'do-not-display-private-context' } }] })).actions[0]
  }
  const uncertain = await accept('maintenance.verify')
  const claim = await repository.claim({ workerId: 'synthetic-browser-worker', leaseMs: 30000 })
  const started = await repository.startDispatch(claim)
  assert.equal(started.status, 'ready')
  assert.equal(await repository.settle(started.claim, { state: 'needs_review', code: 'verification_unknown' }), true)
  for (let i = 0; i < 26; i++) await accept('maintenance.create')
  const cancellable = await accept('maintenance.create')
  globalThis.fetch = async () => { throw new Error('External services are unavailable in the browser fixture') }
  browser = await chromium.launch({ headless: true, ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 204, body: '' }))
  const page = await context.newPage(); diagnosticPage = page
  page.setDefaultTimeout(20000) // Longer than the UI’s own 15-second request boundary.
  page.on('pageerror', error => errors.push({ name: error.name, message: error.message }))
  page.on('console', message => { if (message.type() === 'error') errors.push({ console: message.text() }) })
  page.on('response', response => { if (response.url().startsWith(origin) && response.status() >= 500) failures.push(response.status()) })
  await page.goto(`${origin}/api/dashboard?reauthenticate=1`)
  await page.getByLabel('Username', { exact: true }).fill('owner-a')
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in to workspace' }).click()
  await page.waitForURL('**/api/mfa')
  const cookie = (await context.cookies(origin)).map(({ name, value }) => `${name}=${value}`).join('; ')
  await verifyMfaCookie(runtime, cookie, password)
  await page.goto(`${origin}/api/dashboard?organizationId=organization-a&propertyId=property-a1#/workflows`)
  const queue = page.locator('.wq-view')
  await queue.waitFor({ state: 'visible' })
  const rows = queue.locator('[data-select]')
  await page.waitForFunction(() => document.querySelectorAll('.wq-view [data-select]').length === 1)
  assert.equal(await rows.first().getAttribute('data-select'), uncertain.id)
  assert.equal(await queue.locator('[data-command="cancel"]').count(), 0)
  assert.match(await queue.innerText(), /Track work, email delivery and callbacks/)
  assert.doesNotMatch(await queue.innerText(), /do-not-display-private-context/)
  checks.push('Real scoped action state is shown; possibly dispatched work cannot be cancelled; private context is omitted')
  await queue.locator('[data-filter="all"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.wq-view [data-select]').length === 25)
  await queue.locator('[data-command="more"]').press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.wq-view [data-select]').length === 28)
  assert.equal(new Set(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.select))).size, 28)
  await queue.locator('[data-command="more"]').waitFor({ state: 'hidden' })
  await page.waitForFunction(id => document.activeElement?.dataset.select === id, uncertain.id)
  checks.push('Keyboard Load more shows every action once, stops at the last page and focuses the final loaded action')
  await queue.locator(`[data-select="${cancellable.id}"]`).click()
  await queue.locator('[data-command="cancel"]').click()
  await page.locator('#wq-reason').selectOption('no_longer_needed')
  await page.locator('.dlg-primary').click()
  await page.locator('.dlg').waitFor({ state: 'hidden' })
  assert.equal((await repository.get(cancellable.id)).state, 'cancelled')
  await queue.locator('[data-command="replay"]').click()
  await page.locator('#wq-reason').selectOption('reviewed_request')
  await page.locator('.dlg-primary').click()
  await page.locator('.dlg').waitFor({ state: 'hidden' })
  assert.equal((await repository.get(cancellable.id)).state, 'queued')
  assert.equal((await repository.get(cancellable.id)).dispatchAttempts, 0)
  checks.push('Reasoned cancellation and requeue commit through the real API without dispatch')
  // Clicking a row must retain the inner list position, including after paint.
  await queue.locator('.wq-results').evaluate(el => { el.scrollTop = el.scrollHeight })
  const last = rows.last()
  const scrollBefore = await queue.locator('.wq-results').evaluate(el => el.scrollTop)
  await last.click()
  assert.equal(await queue.locator('.wq-results').evaluate(el => el.scrollTop), scrollBefore)
  assert.equal(await last.getAttribute('aria-current'), 'true')
  checks.push('Selecting a lower action keeps the scrolled list in place')
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await queue.locator(`[data-select="${uncertain.id}"]`).click()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Work queue has no overflow at ${width}`)
    if (width <= 959) assert.equal(await page.locator('.nav-label > span').evaluateAll(labels => labels.every(label => {
      const range = document.createRange(); range.selectNodeContents(label)
      return range.getClientRects().length === 1
    })), true, `Mobile navigation labels do not wrap at ${width}`)
    if (width <= 760) assert.equal(await page.locator('[data-key="work-detail-heading"]').evaluate(el => el === document.activeElement), true)
    while (await page.locator('.toast-close').count()) await page.locator('.toast-close').first().click()
    if (artifacts) {
      await page.screenshot({ path: `${artifacts}/work-queue-detail-${width}.png` })
      await page.evaluate(() => scrollTo(0, 0))
      await page.screenshot({ path: `${artifacts}/work-queue-${width}.png` })
    }
  }
  checks.push('Mobile action selection focuses the detail heading; 320/390/768/1280 layouts have no horizontal overflow')
  // Let the write commit, then deliberately lose its response. The user must not
  // be offered a blind repeat just because the network result is uncertain.
  await queue.locator(`[data-select="${cancellable.id}"]`).click()
  await page.route('**/api/workflows', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{malformed' })
  })
  await queue.locator('[data-command="cancel"]').click()
  await page.locator('.dlg-primary').click()
  await page.getByText('The change is unconfirmed. It may have been saved.', { exact: false }).waitFor({ state: 'visible' })
  assert.equal((await repository.get(cancellable.id)).state, 'cancelled')
  await page.locator('.dlg-primary').click()
  await page.locator('.dlg').waitFor({ state: 'hidden' })
  assert.equal(await queue.locator('[data-command="cancel"], [data-command="replay"]').count(), 0)
  await queue.locator('[data-command="refresh"]').click()
  await queue.locator('.wq-results[aria-busy="false"]').waitFor()
  assert.equal(await queue.locator('[data-command="cancel"], [data-command="replay"]').count(), 0)
  await page.unroute('**/api/workflows')
  await queue.locator('[data-command="reload"]').click()
  await queue.locator('[data-command="replay"]').waitFor({ state: 'visible' })
  assert.equal(await queue.locator('[data-command="cancel"]').count(), 0)
  checks.push('A committed write with a malformed response blocks further recovery until page reload confirms the saved state')
  assert.equal((await repository.get(uncertain.id)).dispatchAttempts, 1)
  assert.equal((await repository.get(cancellable.id)).dispatchStarted, false)
  // The actual local HTTP endpoint uses an injected synthetic provider readback. Any send is a failure.
  const emailKey = randomUUID(), message = { to:'synthetic@example.test',from:'Leasing <leasing@example.test>',replyTo:'leasing@example.test',subject:'Your matches',html:'<p>Synthetic matches</p>' }
  const input = emailWorkflowAction(message, { purpose:'leasing_shortlist',recipient:message.to,contentSha256:emailMessageDigest(message),
    recordedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),receiptId:emailKey }, emailKey)
  async function seedEmail() {
    const marker=randomUUID()
    const action=(await repository.accept({ source:'synthetic-browser-email',eventId:marker,payload:{synthetic:true},actions:[{...input,operationKey:marker}] })).actions[0]
    const claimed=await repository.claim({workerId:'synthetic-browser-email',leaseMs:30000,actionId:action.id})
    const started=await repository.startDispatch(claimed);assert.equal(started.status,'ready')
    const reference=randomUUID()
    await repository.settle(started.claim,{state:'verifying',code:'provider_accepted',delayMs:0,providerReference:reference})
    return {...action,reference}
  }
  let providerReads=0, currentEmail=await seedEmail()
  routes.set('/api/email-reconciliation',createEmailReconciliationHandler({provider:{configured:true,transport:()=>new ResendTransport('synthetic',{fetch:async(url,init)=>{
    assert.equal(init.method,'GET');assert.equal(String(url),`https://api.resend.com/emails/${currentEmail.reference}`);providerReads++
    return new Response(JSON.stringify({object:'email',id:currentEmail.reference,from:message.from,to:[message.to],reply_to:[message.replyTo],subject:message.subject,html:message.html,
      cc:[],bcc:[],last_event:'delivered',tags:[{name:'atrium_operation',value:currentEmail.operationKey},{name:'atrium_input',value:currentEmail.inputSha256}]}),{status:200})
  }})}}))
  await queue.locator('[data-command="refresh"]').click()
  await queue.locator(`[data-select="${currentEmail.id}"]`).click()
  await queue.locator('[data-command="verify-email"]').waitFor({state:'visible'})
  let resizeTransients = 0
  for(const width of [320,390,1280,320,390,1280,320,390,1280]) {
    await page.setViewportSize({width,height:900})
    if (await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) resizeTransients++
    // Inspect painted responsive layout, not the intermediate viewport update.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Email details fit ${width}px`)
    await queue.locator('[data-command="verify-email"]').focus()
    if(artifacts)await page.screenshot({path:`${artifacts}/email-check-${width}.png`})
  }
  await queue.locator('[data-command="verify-email"]').press('Enter')
  await queue.locator('.wq-detail h3').filter({hasText:'Delivery verified'}).waitFor()
  assert.equal(providerReads,1);assert.equal((await repository.get(currentEmail.id)).dispatchAttempts,1)
  assert.match(await queue.locator('.wq-detail').innerText(),/does not prove that the recipient read it/)
  checks.push(`Responsive resize checks: ${resizeTransients} intermediate viewport overflows; zero after two animation frames`)
  checks.push('Email acceptance, keyboard check and exact delivered result work at 320/390/1280px without another send')
  currentEmail=await seedEmail()
  await queue.locator('[data-command="refresh"]').click()
  await queue.locator(`[data-select="${currentEmail.id}"]`).click()
  await page.route('**/api/email-reconciliation',async route=>{
    const result=await route.fetch();assert.equal(result.status(),200)
    await route.fulfill({status:200,contentType:'application/json',body:'{broken'})
  })
  await queue.locator('[data-command="verify-email"]').click()
  await queue.getByText('The check could not be confirmed.',{exact:false}).waitFor()
  assert.equal((await repository.get(currentEmail.id)).state,'succeeded');assert.equal(providerReads,2)
  assert.equal(await queue.locator('[data-command="verify-email"]').count(),0)
  await page.unroute('**/api/email-reconciliation')
  await queue.locator('[data-command="reload"]').click()
  await queue.locator(`[data-select="${currentEmail.id}"]`).click()
  await queue.locator('.wq-detail h3').filter({hasText:'Delivery verified'}).waitFor()
  assert.equal(providerReads,2)
  checks.push('Lost delivery-check response requires reload and recovers the committed result without repeated provider IO')
  assert.deepEqual(failures, [], 'No local HTTP 5xx responses')
  assert.deepEqual(errors, [], 'No browser console/page or server errors')
  console.log(JSON.stringify({ status: 'passed', checks, hostedVerified: false, providerExecuted: false }, null, 2))
} catch (error) {
  if (diagnosticPage) {
    console.error(JSON.stringify({ errors, failures, overflow: await diagnosticPage.evaluate(() => ({ viewport:innerWidth, documentWidth:document.documentElement.scrollWidth, elements:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(-30).map(el=>({tag:el.tagName,css:el.className,right:el.getBoundingClientRect().right,text:el.textContent.slice(0,100)})) })), pageText: await diagnosticPage.locator('body').innerText().catch(() => 'unavailable') }))
    if (artifacts) await diagnosticPage.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {})
  }
  throw error
} finally {
  globalThis.fetch = originalFetch
  await browser?.close()
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await db?.close()
  if (oldMode === undefined) delete process.env.ATRIUM_RUNTIME_MODE; else process.env.ATRIUM_RUNTIME_MODE = oldMode
}
