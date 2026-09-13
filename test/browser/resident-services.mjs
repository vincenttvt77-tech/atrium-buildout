/** Actual Chromium and HTTP/PostgreSQL with synthetic accounts; all external transport denied. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { PostgresResidentServicesRepository } from '../../src/database/resident-services.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'
import { buildOpsPage } from '../../scripts/build-ops.mjs'
import { buildAuthClient } from '../../scripts/build-auth.mjs'

const { chromium } = await import(process.env.ATRIUM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href : 'playwright')
await buildAuthClient(); await buildOpsPage()
const routes = new Map(await Promise.all(['dashboard', 'mfa', 'account', 'properties', 'calendar', 'leads', 'vapi', 'health', 'resident-services']
  .map(async name => [`/api/${name}`, (await import(`../../api/${name}.ts`)).default])))
const originalFetch = globalThis.fetch, oldMode = process.env.ATRIUM_RUNTIME_MODE
const errors = [], checks = [], expectedConsoleErrors = [], artifacts = process.env.ATRIUM_BROWSER_ARTIFACTS
let expectServiceUnauthorized = false
let expectSignInUnauthorized = false
let db, server, browser, runtime, origin
if (artifacts) await mkdir(artifacts, { recursive: true })
try {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  const { password } = await seedFoundationTestDatabase(db.admin)
  const bundle = { property: { id: 'property-a1', organizationId: 'organization-a', buildingName: 'Synthetic Service Building',
    timeZone: 'America/New_York', jurisdiction: 'NY', tourSettings: defaultSettings() },
  inventory: [{ unitId: '19A', floorPlanId: 'plan-3', floor: 19, bedrooms: 3, bathrooms: 2, sqft: 1400,
    monthlyRent: 5000, availableFrom: '2026-09-01', status: 'leased' }],
  floorplans: [{ id: 'plan-3', name: 'Three bedroom', bedrooms: 3, bathrooms: 2, sqft: 1400, description: 'Synthetic plan', features: [] }], knowledge: [] }
  await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    VALUES('organization-a','property-a1',1,'published',$1,clock_timestamp(),'synthetic-browser',clock_timestamp())`, [JSON.stringify(bundle)])
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE property_id='property-a1'")
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin)
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return }
      const handler = routes.get(url.pathname)
      if (!handler) { res.statusCode = 404; res.end('Not found'); return }
      req.atriumRuntime = runtime
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 70000) throw new Error('Oversized fixture request') }
      req.body = req.headers['content-type']?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body)) : body
      req.query = Object.fromEntries(url.searchParams)
      res.status = code => { res.statusCode = code; return res }
      res.send = value => { res.end(value); return res }
      res.json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res }
      await handler(req, res)
    } catch (error) { errors.push({ server: error.name, code: error.code }); res.statusCode = 500; res.end('Synthetic handler failed') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://localhost:${server.address().port}`
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: randomBytes(40).toString('base64url'), authOrigin: origin })
  const seedUser = await runtime.authorization.authenticatePassword('owner-a', password)
  const seedPrincipal = await runtime.sessions.start(seedUser, { label: 'Synthetic browser seed' })
  await verifyOrganizationSession(runtime, seedPrincipal, password, { purpose: 'session_login' })
  const seedScope = await runtime.authorization.authorizeProperty(seedPrincipal, 'property-a1', 'operate')
  const repository = new PostgresResidentServicesRepository(db.app, seedScope, { configurationVersion: 1 })
  let historyRequest
  for (let i = 0; i < 31; i++) historyRequest = await repository.execute({ action: 'create_request', requestId: randomUUID(), intake: {
    requestOrigin: 'staff_observation', location: { kind: 'common_area', label: 'Lobby' }, residentId: null,
    summary: `Synthetic issue ${String(i).padStart(2, '0')}`, description: '', category: 'other', reportedPriority: 'routine',
    reporterName: null, reporterPhone: null, reporterEmail: null, accessNotes: '' } })
  for (let i = 0; i < 26; i++) historyRequest = await repository.execute({ action: 'add_note', requestId: randomUUID(),
    id: historyRequest.id, expectedVersion: historyRequest.version, note: `Synthetic browser history item ${i + 1}` })
  globalThis.fetch = async () => { throw new Error('External services are unavailable in this fixture') }
  browser = await chromium.launch({ headless: true, ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 204, body: '' }))
  const page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push({ page: error.message }))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const url = message.location().url
    const endpoint = url?.startsWith(origin + '/') ? new URL(url).pathname : null
    if (/\b401\b/.test(message.text()) && ((expectServiceUnauthorized && endpoint === '/api/resident-services')
      || (expectSignInUnauthorized && endpoint === '/api/dashboard'))) {
      expectedConsoleErrors.push(endpoint === '/api/resident-services' ? 'Injected post-commit Service 401' : 'Revoked-session dashboard sign-in response'); return
    }
    errors.push({ console: message.text(), url })
  })
  await page.goto(`${origin}/api/dashboard?reauthenticate=1`)
  await page.getByLabel('Username', { exact: true }).fill('owner-a')
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in to workspace' }).click()
  await page.waitForURL('**/api/mfa')
  const cookie = (await context.cookies(origin)).map(({ name, value }) => `${name}=${value}`).join('; ')
  const principal = await runtime.authenticate({ cookie }, new Date())
  await verifyOrganizationSession(runtime, principal, password, { purpose: 'session_login' })
  await page.goto(`${origin}/api/dashboard?organizationId=organization-a&propertyId=property-a1#/services`)
  const view = page.locator('.sv-view'), rows = view.locator('[data-select]')
  await page.waitForFunction(() => document.querySelectorAll('.sv-view [data-select]').length === 25)
  await view.locator('[data-command="more"]').press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.sv-view [data-select]').length === 31)
  assert.equal(new Set(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.select))).size, 31)
  checks.push('Real staff session loads a bounded property case directory and keyboard paging without duplicates')
  await rows.nth(20).scrollIntoViewIfNeeded()
  const listScroll = await view.locator('.sv-results').evaluate(node => node.scrollTop)
  await rows.nth(20).click()
  await view.locator('#sv-detail [data-command="note"]').waitFor()
  assert.equal(await view.locator('.sv-results').evaluate(node => node.scrollTop), listScroll)
  await view.locator(`[data-select="${historyRequest.id}"]`).click()
  await view.locator('[data-command="events"]').waitFor()
  assert.equal(await view.locator('.sv-history li').count(), 25)
  await view.locator('[data-command="events"]').press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.sv-history li').length === 27)
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'service-detail-heading')
  checks.push('Selecting scrolled cases preserves the list; a 27-event history opens and pages with retained keyboard focus')

  await view.locator('[data-tab="residents"]').click()
  await view.locator('[data-command="add"]').click()
  const dialog = page.locator('.dlg')
  await dialog.locator('#sv-unit').selectOption('19A')
  await dialog.locator('#sv-name').fill('Browser Synthetic Resident')
  await dialog.locator('#sv-starts').fill('2020-01-01')
  await dialog.locator('#sv-reference').fill('Synthetic reviewed occupancy schedule')
  await dialog.locator('#sv-source-version').fill('browser-review-1')
  const localDateTime = value => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(part => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
  }
  await dialog.locator('#sv-observed').fill(localDateTime(new Date(Date.now() - 3600_000)))
  await dialog.locator('#sv-valid-until').fill(localDateTime(new Date(Date.now() + 86400_000)))
  await dialog.locator('#sv-reason').fill('Staff reviewed the original synthetic source')
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await view.locator('[data-command="review-resident"]').waitFor()
  const residentId = (await repository.listResidents({ limit: 10 }))[0].id
  assert.match(await view.innerText(), /Browser Synthetic Resident/)
  checks.push('A manager records original source evidence through the reviewed residency form; no caller identity is invented')

  await view.locator('[data-tab="requests"]').click()
  await view.locator('[data-command="add"]').click()
  await dialog.locator('#sv-unit').selectOption('19A')
  await page.waitForFunction(id => Boolean(document.querySelector(`#sv-resident option[value="${id}"]`)), residentId)
  await dialog.locator('#sv-resident').selectOption(residentId)
  await dialog.locator('#sv-summary').fill('Browser synthetic kitchen request')
  await dialog.locator('#sv-description').fill('The reporter described a slow drip and asked for staff review.')
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (artifacts) await page.screenshot({ path: `${artifacts}/service-review-${width}.png`, fullPage: false })
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => {
      const rect = node.getBoundingClientRect(); return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1)
    }).slice(0, 12).map(node => ({ tag: node.tagName, id: node.id, class: node.className,
      left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
      `No viewport overflow at ${width}: ${JSON.stringify(overflow)}`)
    const save = dialog.getByRole('button', { name: 'Save reviewed change', exact: true })
    assert.equal(await save.isEnabled(), true)
  }
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await view.locator('[data-command="note"]').waitFor()
  const created = (await repository.listCases({ limit: 50 })).find(row => row.summary === 'Browser synthetic kitchen request')
  assert.ok(created)
  assert.equal(created.entryAuthorized, false); assert.equal(created.callerIdentityVerified, false)
  checks.push('Reviewed service intake works at 320/390/768/1280 pixels with separate occupancy, caller and dispatch states')

  let dropped = false
  await page.route('**/api/resident-services', async route => {
    const request = route.request()
    if (!dropped && request.method() === 'POST' && request.postDataJSON()?.action === 'add_note') {
      dropped = true
      const response = await route.fetch(); assert.equal(response.status(), 200)
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{' }); return
    }
    await route.continue()
  })
  await view.locator('[data-command="note"]').click()
  await dialog.locator('#sv-note').fill('Browser note saved before its response was lost')
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Retry this exact change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.unroute('**/api/resident-services')
  const afterRetry = await repository.getCase(created.id)
  assert.equal(afterRetry.request.version, 2)
  assert.equal(afterRetry.events.filter(event => event.kind === 'note').length, 1)
  checks.push('A lost HTTP response after commit recovers through the same reviewed command without a duplicate note')

  await view.locator('[data-command="add"]').click()
  await dialog.locator('#sv-location').selectOption('unknown')
  await dialog.locator('#sv-location-label').fill('Caller was unsure of the apartment')
  await dialog.locator('#sv-summary').fill('Browser request needing location clarification')
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await view.locator('[data-command="context"]').click()
  await dialog.locator('#sv-location').selectOption('unit')
  await dialog.locator('#sv-unit').selectOption('19A')
  await page.waitForFunction(id => Boolean(document.querySelector(`#sv-resident option[value="${id}"]`)), residentId)
  await dialog.locator('#sv-resident').selectOption(residentId)
  await dialog.locator('#sv-note').fill('Staff clarified the apartment and selected its reviewed occupancy source')
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await view.locator('[data-command="triage"]').click()
  await dialog.locator('#sv-state').selectOption('ready_for_planning')
  await dialog.locator('#sv-note').fill('Staff reviewed the clarified location and current source')
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const clarified = (await repository.listCases({ limit: 50 })).find(row => row.summary === 'Browser request needing location clarification')
  assert.deepEqual(clarified.intakeLocation, { kind: 'unknown', label: 'Caller was unsure of the apartment' })
  assert.equal(clarified.residentIdAtIntake, null)
  assert.equal(clarified.location.unitId, '19A')
  assert.equal(clarified.state, 'ready_for_planning')
  assert.equal(clarified.dispatchStatus, 'not_dispatched')
  checks.push('Unknown intake gains reviewed unit/resident context and reaches planning on the same case while retaining its original report')
  await view.locator(`[data-select="${created.id}"]`).click()

  await view.locator('[data-command="triage"]').click()
  await dialog.locator('#sv-state').selectOption('ready_for_planning')
  await dialog.locator('#sv-note').fill('Current source and location reviewed for planning')
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await view.locator('[data-tab="residents"]').click()
  await view.locator(`[data-select="${residentId}"]`).click()
  await view.locator('[data-command="revoke-resident"]').click()
  await dialog.locator('#sv-reason').fill('Synthetic source no longer establishes occupancy')
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await view.locator('[data-tab="requests"]').click()
  await view.locator('[data-filter="attention"]').click()
  await view.locator(`[data-select="${created.id}"]`).click()
  await page.waitForFunction(() => document.querySelector('#sv-detail')?.textContent.includes('Context needs review'))
  const held = await repository.getCase(created.id)
  assert.equal(held.request.contextNeedsReview, true)
  assert.equal(held.request.state, 'ready_for_planning')
  assert.equal(held.request.dispatchStatus, 'not_dispatched')
  checks.push('Revoked source evidence brings previously triaged work back to attention without rewriting historical triage')

  await view.locator('[data-command="add"]').click()
  await dialog.locator('#sv-unit').selectOption('19A')
  await dialog.locator('#sv-summary').fill('I smell gas in the kitchen')
  await dialog.locator('.sv-immediate-safety').waitFor({ state: 'visible' })
  assert.match(await dialog.locator('.sv-immediate-safety').innerText(), /does not contact/i)
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.querySelector('#sv-detail')?.textContent.includes('Emergency'))
  assert.equal(await view.locator('[data-command="triage"]').count(), 0)
  checks.push('Potential emergency instructions appear before saving and ordinary triage cannot downgrade the saved emergency')

  let unauthorizedCommit
  await page.route('**/api/resident-services', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'add_note') {
      const response = await route.fetch(); assert.equal(response.status(), 200)
      unauthorizedCommit = (await response.json()).receipt
      await runtime.sessions.revoke(principal, principal.sessionId)
      expectServiceUnauthorized = true
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'unauthenticated', error: 'Session ended after commit' }) })
      return
    }
    await route.continue()
  })
  await view.locator('[data-command="note"]').click()
  await dialog.locator('#sv-note').fill('Synthetic note committed before this session ended')
  await dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await page.getByRole('link', { name: 'Reload property', exact: true }).waitFor()
  assert.match(await page.locator('body').innerText(), /save is unconfirmed and may have been recorded/i)
  assert.equal(await page.locator('.sv-view').isVisible(), false)
  assert.equal(await page.locator('.sv-view').textContent(), '')
  assert.equal(await page.getByLabel('Username', { exact: true }).count(), 0, 'No automatic navigation erases the warning')
  assert.equal((await repository.getCase(unauthorizedCommit.id)).request.version, unauthorizedCommit.version)
  expectSignInUnauthorized = true
  await page.getByRole('link', { name: 'Reload property', exact: true }).click()
  await page.getByLabel('Username', { exact: true }).waitFor()
  checks.push('A real commit followed by session revocation keeps a clear unconfirmed-save warning until deliberate sign-in navigation')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', checks, errors, expectedConsoleErrors, widths: [320, 390, 768, 1280], physicalPasskey: false, providerExecuted: false }, null, 2))
} finally {
  globalThis.fetch = originalFetch
  await browser?.close()
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await db?.close()
  oldMode === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = oldMode
}
