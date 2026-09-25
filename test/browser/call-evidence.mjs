/** Render the generated dashboard with intercepted synthetic responses only. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { chromium } = await import(process.env.ATRIUM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href : 'playwright')
const html = await readFile(new URL('../../ops/dashboard.html', import.meta.url), 'utf8')
assert.ok(html.includes('Saved tool activity'), 'Build the current dashboard before browser verification')
const origin = 'https://atrium.test', at = new Date().toISOString()
const artifacts = resolve(process.env.ATRIUM_BROWSER_ARTIFACTS || '/tmp/atrium-call-evidence-browser')
await mkdir(artifacts, { recursive: true })
const scope = { organizationId: 'org-synthetic', propertyId: 'property-synthetic', configurationVersion: 1, permissionVersion: 'one' }
const property = { ...scope, buildingName: 'Synthetic QA', timeZone: 'America/Chicago', permissions: ['read'], hours: {} }
const profile = { phone: 'unknown', name: 'Sample prospect', stage: 'new', firstSeenAt: at, lastSeenAt: at,
  calls: ['history-one', 'summary-only'].map(callId => ({ callId, at, durationSeconds: 4, outcome: 'Enquired', toolsCalled: [] })),
  bookings: [], signals: {}, escalations: [], notes: [], unitsDiscussed: [] }
const errors = [], unexpected = [], checks = [], screenshots = []
const browser = await chromium.launch({ headless: true,
  ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
try {
  for (const width of [320, 390, 1280]) {
    let empty = false
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    await context.addInitScript(({ property }) => {
      window.ATRIUM_RUNTIME_MODE = 'postgres'; window.ATRIUM_PROPERTY = property
      window.ATRIUM_ACCOUNT = { username: 'sample', userId: 'sample-operator' }
      window.ATRIUM_DEMO = new URL(location.href).searchParams.get('demo') === 'yes'
    }, { property })
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      if (request.method() !== 'GET') { unexpected.push(request.method() + ' ' + url.pathname); return route.fulfill({ status: 405, body: '' }) }
      if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html })
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' })
      let data
      if (url.pathname === '/api/vapi') data = { scope, callsConfigured: !empty, calls: empty ? [] : [
        { id: 'history-one', startedAt: at, customerNumber: null, transcript: 'User: Hello.', toolCalls: [] }],
      events: empty ? [] : [{ callId: 'tool-only', at, kind: 'availability_checked', outcome: 'no_availability' }] }
      else if (url.pathname === '/api/leads') data = { scope, profiles: empty ? [] : [profile], followUps: [], tourChangeRequests: [], store: { kind: 'postgres', durable: true } }
      else if (url.pathname === '/api/calendar') data = { scope, slots: [], bookings: [], blocks: [], units: [], unitBlocks: [],
        timeZone: property.timeZone, range: { from: url.searchParams.get('from'), to: url.searchParams.get('to') }, store: { kind: 'postgres', durable: true } }
      else if (url.pathname === '/api/health') data = { ok: true, store: 'postgres', durable: true, callHistory: !empty }
      else { unexpected.push(request.method() + ' ' + url.pathname); return route.fulfill({ status: 404, body: '' }) }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    })
    const page = await context.newPage(); page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push({ width, error: error.message }))
    page.on('console', message => { if (message.type() === 'error') errors.push({ width, error: message.text() }) })
    const fit = async label => {
      const result = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
      assert.ok(result.scrollWidth <= result.width, `${label} ${width}: ${JSON.stringify(result)}`)
    }
    await page.goto(origin + '/#/today')
    const summaryRow = page.locator('[data-view="today"] [data-key="row:summary-only"]')
    await summaryRow.waitFor({ state: 'visible' })
    assert.match(await summaryRow.innerText(), /Saved summary/)
    assert.match(await page.locator('[data-key="row:tool-only"]').innerText(), /Saved tool activity/)
    const metric = page.locator('[data-key="tile:Call records"]')
    assert.match(await metric.innerText(), /1 from call history.*2 from saved notes/s)
    assert.equal(await metric.locator('.metric-value').innerText(), '3')
    await fit('Today')
    let path = resolve(artifacts, `today-${width}.png`)
    await page.screenshot({ path, fullPage: true }); screenshots.push(path)
    await summaryRow.focus(); await summaryRow.press('Enter')
    await page.waitForURL('**/#/calls?id=summary-only')
    const panel = page.locator('.call-panel')
    await panel.getByText(/A matching call is not in the loaded history/).waitFor()
    assert.equal(await panel.locator('[data-action="recording"]').count(), 0)
    await fit('Saved summary detail')
    path = resolve(artifacts, `summary-${width}.png`)
    await page.screenshot({ path, fullPage: true }); screenshots.push(path)
    checks.push(`${width}: mixed-source count, all labels and keyboard detail; no overflow or invented audio`)

    empty = true
    await page.goto(origin + '/#/today')
    await page.getByText('Since 6 PM yesterday: no call records loaded.', { exact: true }).waitFor()
    assert.match(await metric.innerText(), /Call history not connected/)
    await page.goto(origin + '/#/calls')
    await page.getByText('No call records loaded.', { exact: true }).waitFor()
    assert.doesNotMatch(await page.locator('.calls-view').innerText(), /No calls yet|within a minute/)
    await fit('Disconnected history')
    checks.push(`${width}: disconnected empty history does not claim zero phone calls or a delivery deadline`)

    empty = false
    await page.goto(origin + '/?demo=yes#/today')
    await summaryRow.waitFor({ state: 'visible' })
    assert.match(await summaryRow.innerText(), /Demo record/)
    assert.match(await metric.innerText(), /Sample conversation records/)
    await summaryRow.click()
    await panel.getByText(/Sample conversation data from this demo workspace/).waitFor()
    await fit('Explicit demo')
    checks.push(`${width}: explicit demo labels survive Today-to-detail navigation`)
    await context.close()
  }
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
  const result = { checks, errors, unexpected, screenshots, limitation: 'Synthetic browser responses only; no authentication, provider, phone or production acceptance.' }
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally { await browser.close() }
