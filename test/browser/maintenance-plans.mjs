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
import { PostgresMaintenancePlanningRepository } from '../../src/database/maintenance-planning.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { verifyOrganizationSession } from '../helpers/organization-session.mjs'
import { buildOpsPage } from '../../scripts/build-ops.mjs'
import { buildAuthClient } from '../../scripts/build-auth.mjs'

const { chromium } = await import(process.env.ATRIUM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href : 'playwright')
await buildAuthClient(); await buildOpsPage()
const routes = new Map(await Promise.all(['dashboard', 'mfa', 'account', 'properties', 'calendar', 'leads', 'vapi', 'health', 'resident-services', 'maintenance-plans']
  .map(async name => [`/api/${name}`, (await import(`../../api/${name}.ts`)).default])))
const originalFetch = globalThis.fetch, oldMode = process.env.ATRIUM_RUNTIME_MODE
const errors = [], checks = [], expectedConsoleErrors = [], artifacts = process.env.ATRIUM_BROWSER_ARTIFACTS
let expectPlanningUnauthorized = false
let expectPlanningMfa = false
let expectPlanningConflict = false
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
  const seedUser = await runtime.authorization.authenticatePassword('staff-a', password)
  const seedPrincipal = await runtime.sessions.start(seedUser, { label: 'Synthetic browser seed' })
  await verifyOrganizationSession(runtime, seedPrincipal, password, { purpose: 'session_login' })
  const seedScope = await runtime.authorization.authorizeProperty(seedPrincipal, 'property-a1', 'operate')
  const repository = new PostgresResidentServicesRepository(db.app, seedScope, { configurationVersion: 1 })
  const planner = new PostgresMaintenancePlanningRepository(db.app, seedScope, { configurationVersion: 1 })
  const cases = {}
  for (const label of ['automatic', 'approval', 'conflict', 'safety', 'vendor', 'inboxReject']) {
    const saved = await repository.execute({ action: 'create_request', requestId: randomUUID(), intake: {
      requestOrigin: 'staff_observation', location: { kind: 'common_area', label: 'Lobby' }, residentId: null,
      summary: `Synthetic ${label} maintenance`, description: 'Staff observed a slow tap drip.', category: 'plumbing', reportedPriority: 'routine',
      reporterName: null, reporterPhone: null, reporterEmail: null, accessNotes: '' } })
    await repository.execute({ action: 'triage_request', requestId: randomUUID(), id: saved.id, expectedVersion: 1,
      state: 'ready_for_planning', priority: 'routine', note: 'Staff reviewed the current location and work context' })
    cases[label] = saved.id
  }
  const planDetails = (extra = {}) => ({ route: 'internal', vendorId: null, vendorVersion: null, internalTeam: 'Building maintenance',
    scopeOfWork: 'Replace the lobby tap washer', currency: 'USD', maximumCents: 75000, includesAllCharges: true,
    accessRequirement: 'no_unit_entry', restrictions: [], reason: 'Staff reviewed the all-in estimate', ...extra })
  const prepare = (caseId, expectedPlanVersion = 0, extra = {}) => planner.execute({ action: 'prepare_plan', requestId: randomUUID(),
    caseId, expectedCaseVersion: 2, expectedPlanVersion, policyVersion: 1, details: planDetails(extra) })
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
    if (/\b401\b/.test(message.text()) && ((expectPlanningUnauthorized && endpoint === '/api/maintenance-plans')
      || (expectSignInUnauthorized && endpoint === '/api/dashboard'))) {
      expectedConsoleErrors.push(endpoint === '/api/maintenance-plans' ? 'Injected post-commit planning 401' : 'Revoked-session dashboard sign-in response'); return
    }
    if (endpoint === '/api/maintenance-plans' && ((expectPlanningMfa && /\b403\b/.test(message.text())) || (expectPlanningConflict && /\b409\b/.test(message.text())))) { expectedConsoleErrors.push('Expected planning authority/version refusal'); return }
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
  const view = page.locator('.sv-view'), dialog = page.locator('.dlg')
  const localDateTime = value => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(part => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
  }
  const review = () => dialog.getByRole('button', { name: 'Review change', exact: true }).click()
  const save = async (label = 'Save reviewed change') => {
    await dialog.getByRole('button', { name: label, exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  async function widths(name) {
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      if (name === 'maintenance-authorized-plan') {
        await view.locator('.sv-planning-case [data-mp-heading]').evaluate(node => node.scrollIntoView({ block: 'center' }))
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert.equal(await view.locator('.sv-planning-case [data-mp-heading]').evaluate(node => {
          const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight
        }), true, `The plan heading remains in view at ${width}`)
      }
      if (name === 'maintenance-planning-inbox') {
        await view.locator('.sv-inbox-info').evaluate(node => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -90) })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert.equal(await view.locator('.mp-inbox-row').first().evaluate(node => {
          const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight - 65
        }), true, `A complete work-plan row remains readable at ${width}`)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `No viewport overflow: ${name} at ${width}`)
      if (artifacts) await page.screenshot({ path: `${artifacts}/${name}-${width}.png`, fullPage: false })
    }
  }
  async function sourceFields() {
    await dialog.locator('#mp-source').fill('Synthetic owner-reviewed property source')
    await dialog.locator('#mp-observed').fill(localDateTime(new Date(Date.now() - 3600_000)))
    await dialog.locator('#mp-until').fill(localDateTime(new Date(Date.now() + 86400_000)))
  }
  async function policyForm() {
    await view.locator('[data-mp="policy"]').click()
    await dialog.locator('#mp-automatic').fill('100.00')
    await dialog.locator('#mp-manager').fill('500.00')
    await dialog.locator('#mp-owner').fill('1000.00')
    await dialog.locator('#mp-automatic-category-plumbing').check()
    await dialog.locator('#mp-resident-approval').uncheck()
    await sourceFields()
    await dialog.locator('#mp-reason').fill('Owner established the synthetic per-job authority limits')
    await review()
  }
  async function selectCase(id, inbox = false) {
    await view.locator(`[data-tab="${inbox ? 'plans' : 'requests'}"]`).click()
    await view.locator('[data-filter="all"]').click()
    await view.locator(`[data-select="${id}"]`).click()
    await view.locator('.sv-planning-case [data-mp-heading]').waitFor()
  }
  await view.locator('[data-tab="vendors"]').click()
  await view.locator('[data-mp="policy"]').waitFor()
  assert.match(await view.innerText(), /No authority policy is published/)
  await policyForm()
  await widths('maintenance-policy-review')
  expectPlanningMfa = true
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.getByRole('link', { name: 'Verify administrator access', exact: true }).waitFor()
  assert.equal((await planner.overview()).policy, null)
  assert.equal(await view.isVisible(), true, 'Fresh MFA refusal does not retire the otherwise authorized workspace')
  await dialog.locator('.dlg-primary').filter({ hasText: /^Close$/ }).click()
  assert.match(await view.innerText(), /Planning change is unconfirmed/)
  assert.equal((await planner.overview()).policy, null, 'Closing the dialog never retries a protected operation')
  await verifyOrganizationSession(runtime, principal, password)
  await page.reload()
  await view.locator('[data-tab="vendors"]').click()
  await policyForm(); await save()
  await page.waitForFunction(() => document.querySelector('.mp-policy')?.textContent.includes('Rule version 1'))
  assert.equal((await planner.overview()).policy.ownerLimitCents, 100000)
  checks.push('Owner policy requires fresh exact-session verification, never auto-retries, and reviews accurately at 320/390/768/1280 pixels')

  await view.locator('[data-mp="add-vendor"]').click()
  await dialog.locator('#mp-name').fill('Synthetic Plumbing Team')
  await dialog.locator('#mp-category-plumbing').check()
  await dialog.locator('#mp-status').selectOption('approved')
  await dialog.locator('#mp-phone').fill('+15555550101')
  await dialog.locator('#mp-coverage').fill('Selected building')
  await dialog.locator('#mp-hours').fill('Weekday business hours')
  await sourceFields()
  await dialog.locator('#mp-reason').fill('Owner reviewed the current vendor directory')
  await review(); await save()
  await view.locator('[data-mp-vendor]').waitFor()
  assert.match(await view.locator('.mp-vendor-detail').innerText(), /Availability not established/)
  const vendor = (await planner.listVendors({ limit: 25 }))[0]
  assert.equal(vendor.availability, 'unknown'); assert.equal(vendor.availabilityObservedAt, null)
  checks.push('An approved property vendor preserves unknown availability instead of inventing a reserved appointment')

  await selectCase(cases.automatic)
  await view.locator('[data-mp="prepare"]').click()
  await dialog.locator('#mp-scope').fill('Replace the lobby tap washer')
  await dialog.locator('#mp-team').fill('Building maintenance')
  await dialog.locator('#mp-maximum').fill('100.00')
  await dialog.locator('#mp-all-charges').check()
  await dialog.locator('#mp-entry').selectOption('no_unit_entry')
  await dialog.locator('#mp-reason').fill('Staff reviewed the complete all-in job estimate')
  await review(); await save()
  await page.waitForFunction(() => document.querySelector('.sv-planning-case [data-mp-heading]')?.textContent === 'Authorized plan — not dispatched')
  const initial = await planner.getPlan(cases.automatic)
  assert.equal(initial.plan.maximumCents, 10000); assert.equal(initial.assessment.spendingAuthorized, true)
  assert.equal(initial.assessment.dispatchStatus, 'not_dispatched'); assert.equal(initial.assessment.entryAuthorized, false)
  await widths('maintenance-authorized-plan')
  checks.push('The exact automatic cost boundary works through the real browser without claiming dispatch, notifications or entry')

  let dropped = false
  await page.route('**/api/maintenance-plans', async route => {
    if (!dropped && route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'prepare_plan') {
      dropped = true; const response = await route.fetch(); assert.equal(response.status(), 200)
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{' }); return
    }
    await route.continue()
  })
  await view.locator('[data-mp="prepare"]').click()
  await dialog.locator('#mp-reason').fill('Rechecked the estimate before the response was lost')
  await review()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await dialog.getByRole('button', { name: 'Retry this exact change', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.unroute('**/api/maintenance-plans')
  const retried = await planner.getPlan(cases.automatic)
  assert.equal(retried.plan.version, 2); assert.equal(retried.history.filter(item => item.kind === 'prepared').length, 2)
  checks.push('A lost response after a committed revision recovers the exact receipt without an additional plan version')

  await prepare(cases.approval)
  await page.setViewportSize({ width: 390, height: 900 })
  await selectCase(cases.approval, true)
  await view.locator('[data-mp="approve"]').press('Enter')
  await dialog.locator('#mp-reason').fill('Owner reviewed the exact staff proposal and all-in ceiling')
  await dialog.locator('.dlg-primary').press('Enter')
  assert.match(await dialog.innerText(), /\$750\.00/)
  await dialog.locator('.dlg-primary').focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.dlg'))), true, 'Keyboard focus remains inside the mobile approval review')
  await dialog.locator('.dlg-primary').press('Enter')
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.querySelector('.sv-planning-case')?.textContent.includes('Approval recorded'))
  const approved = await planner.getPlan(cases.approval)
  assert.equal(approved.plan.version, 1); assert.equal(approved.decision.decision, 'approve')
  assert.equal(approved.assessment.spendingAuthorized, true)
  assert.notEqual(approved.plan.preparedBy, approved.decision.actorUserId)
  checks.push('From Work plans at 390 pixels, a different owner opens current case detail and approves the exact staff proposal using the keyboard with focus retained inside the dialog')

  await prepare(cases.conflict)
  await selectCase(cases.conflict)
  await view.locator('[data-mp="approve"]').click()
  await dialog.locator('#mp-reason').fill('Owner reviewed the proposal displayed before a concurrent change')
  await review()
  await prepare(cases.conflict, 1, { maximumCents: 80000 })
  expectPlanningConflict = true
  await dialog.getByRole('button', { name: 'Record approval', exact: true }).click()
  await dialog.getByRole('button', { name: 'Close and refresh', exact: true }).waitFor()
  assert.match(await dialog.innerText(), /changed/i)
  await dialog.getByRole('button', { name: 'Close and refresh', exact: true }).click()
  const conflict = await planner.getPlan(cases.conflict)
  assert.equal(conflict.plan.version, 2); assert.equal(conflict.decision, null)
  checks.push('A concurrent proposal revision prevents the owner from approving the old amount')

  await prepare(cases.safety)
  await selectCase(cases.safety)
  await view.locator('[data-mp="approve"]').click()
  await dialog.locator('#mp-reason').fill('The staff now reports a gas leak at this location')
  await dialog.locator('.mp-immediate-safety').waitFor({ state: 'visible' })
  await review(); await save('Record approval')
  await page.waitForFunction(() => document.querySelector('.sv-planning-case [data-mp-heading]')?.textContent === 'Emergency review')
  let safety = await planner.getPlan(cases.safety)
  assert.equal(safety.plan.version, 2); assert.equal(safety.decision, null)
  assert.equal(safety.history.filter(item => item.kind === 'safety_hold').length, 1)
  await view.locator('[data-mp="withdraw"]').click()
  await dialog.locator('#mp-reason').fill('Withdraw this proposal while staff follows emergency procedure')
  await review(); await save()
  safety = await planner.getPlan(cases.safety)
  assert.equal(safety.plan.version, 3); assert.equal(safety.assessment.readiness, 'emergency_review')
  assert.equal(safety.assessment.spendingAuthorized, false)
  checks.push('Safety evidence during attempted approval records an emergency hold, not approval, and survives withdrawal')

  await selectCase(cases.vendor)
  await view.locator('[data-mp="prepare"]').click()
  await dialog.locator('#mp-scope').fill('Replace the lobby tap washer')
  await dialog.locator('#mp-route').selectOption('vendor')
  await page.waitForFunction(id => Boolean(document.querySelector(`#mp-vendor option[value="${id}"]`)), vendor.id)
  await dialog.locator('#mp-vendor').selectOption(vendor.id)
  await dialog.locator('#mp-maximum').fill('100.00')
  await dialog.locator('#mp-all-charges').check()
  await dialog.locator('#mp-entry').selectOption('no_unit_entry')
  await dialog.locator('#mp-reason').fill('Staff selected the property-approved plumbing provider')
  await review(); await save()
  await page.waitForFunction(() => document.querySelector('.sv-planning-case [data-mp-heading]')?.textContent === 'Vendor readiness needs review')
  const vendorPlan = await planner.getPlan(cases.vendor)
  assert.equal(vendorPlan.assessment.spendingAuthorized, true); assert.equal(vendorPlan.assessment.readiness, 'awaiting_vendor')
  checks.push('A real vendor picker binds current approval and version while missing availability holds fulfillment')

  await view.locator('[data-tab="plans"]').click()
  await view.locator('[data-filter="attention"]').click()
  await view.locator(`[data-select="${cases.safety}"]`).waitFor()
  assert.match(await view.locator(`[data-select="${cases.safety}"]`).innerText(), /Emergency review/)
  assert.equal(await view.locator(`[data-select="${cases.automatic}"]`).count(), 0, 'Authorized work is waiting for fulfillment, not presented as an undecided approval')
  await widths('maintenance-planning-inbox')
  await page.setViewportSize({ width: 390, height: 900 })
  await prepare(cases.inboxReject)
  await selectCase(cases.inboxReject, true)
  await view.locator('[data-mp="reject"]').press('Enter')
  await dialog.locator('#mp-reason').fill('Owner requests a revised all-in estimate before approving')
  await review(); await save('Record rejection')
  await page.waitForFunction(() => document.querySelector('.sv-planning-case')?.textContent.includes('Rejection recorded'))
  const rejected = await planner.getPlan(cases.inboxReject)
  assert.equal(rejected.decision.decision, 'reject'); assert.equal(rejected.plan.version, 1)
  await view.locator('[data-mp="prepare"]').click()
  await dialog.locator('#mp-maximum').fill('700.00')
  await dialog.locator('#mp-reason').fill('Owner prepared a revised complete estimate for independent review')
  await review(); await save()
  await page.waitForFunction(() => document.querySelector('.sv-planning-case')?.textContent.includes('revision 2'))
  const revised = await planner.getPlan(cases.inboxReject)
  assert.equal(revised.plan.version, 2); assert.equal(revised.plan.maximumCents, 70000); assert.equal(revised.decision, null)
  assert.equal(revised.assessment.spendingAuthorized, false)
  assert.equal(await view.locator('[data-mp="approve"]').count(), 0, 'The owner who revised a plan cannot independently approve their own version')
  checks.push('Work plans filters preserve emergency attention and, on mobile, rejection leads to a new independently reviewable version without dispatch')

  await db.admin.query(`INSERT INTO atrium.service_cases
    SELECT (jsonb_populate_record(NULL::atrium.service_cases,
      to_jsonb(c) || jsonb_build_object('id', gen_random_uuid(), 'created_at', $2::text))).*
    FROM atrium.service_cases c CROSS JOIN generate_series(1, 200)
    WHERE c.id = $1 RETURNING id`, [cases.inboxReject, new Date().toISOString()])
  await view.locator('[data-tab="plans"]').click()
  await view.locator('[data-filter="waiting"]').click()
  const continueChecking = view.getByRole('button', { name: 'Continue checking', exact: true })
  await continueChecking.waitFor()
  assert.equal(await view.locator('.mp-inbox-row').count(), 0)
  assert.match(await view.locator('.sv-results').innerText(), /More requests to check/)
  assert.match(await view.locator('.sv-loaded').innerText(), /200 requests checked/)
  await continueChecking.press('Enter')
  await view.locator(`[data-select="${cases.automatic}"]`).waitFor()
  assert.match(await view.locator('.sv-loaded').innerText(), /206 requests checked/)
  assert.equal(await view.locator('[data-command="more"]').isVisible(), false)
  await page.waitForFunction(() => [...document.querySelectorAll('.sv-view [data-select]')].at(-1) === document.activeElement)
  assert.equal(await view.locator('[data-select]').last().evaluate(node => node === document.activeElement), true)
  checks.push('An empty first scan across 200 nonmatching requests offers Continue checking; keyboard continuation finds older waiting work without a false empty state or skipped records')

  await view.locator(`[data-select="${cases.automatic}"]`).click()
  await view.locator('.sv-planning-case [data-mp-heading]').waitFor()
  let unauthorizedCommit
  await page.route('**/api/maintenance-plans', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'withdraw_plan') {
      const response = await route.fetch(); assert.equal(response.status(), 200)
      unauthorizedCommit = (await response.json()).receipt
      await runtime.sessions.revoke(principal, principal.sessionId)
      expectPlanningUnauthorized = true
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'unauthenticated', error: 'Session ended after commit' }) }); return
    }
    await route.continue()
  })
  await view.locator('[data-mp="withdraw"]').click()
  await dialog.locator('#mp-reason').fill('Synthetic withdrawal recorded just before session revocation')
  await review()
  await dialog.getByRole('button', { name: 'Save reviewed change', exact: true }).click()
  await page.getByRole('link', { name: 'Reload property', exact: true }).waitFor()
  assert.match(await page.locator('body').innerText(), /save is unconfirmed and may have been recorded/i)
  assert.equal(await view.isVisible(), false); assert.equal(await view.textContent(), '')
  assert.equal(await page.getByLabel('Username', { exact: true }).count(), 0)
  assert.equal((await planner.getPlan(cases.automatic)).plan.version, unauthorizedCommit.version)
  expectSignInUnauthorized = true
  await page.getByRole('link', { name: 'Reload property', exact: true }).click()
  await page.getByLabel('Username', { exact: true }).waitFor()
  checks.push('A committed planning change followed by session loss clears private views but preserves the unknown-save warning until deliberate navigation')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', checks, errors, expectedConsoleErrors, widths: [320, 390, 768, 1280], physicalPasskey: false, providerExecuted: false }, null, 2))
} finally {
  globalThis.fetch = originalFetch
  await browser?.close()
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  await db?.close()
  oldMode === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = oldMode
}
