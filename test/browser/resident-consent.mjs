/** Actual Chromium + HTTP + disposable PostgreSQL. Synthetic virtual passkeys only; no external providers. */
import assert from 'node:assert/strict'
import { mkdir, chmod, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createConsentFixture } from '../helpers/resident-consent.mjs'

const { chromium } = await import(process.env.ATRIUM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.ATRIUM_PLAYWRIGHT_MODULE).href : 'playwright')
const artifacts = process.env.ATRIUM_BROWSER_ARTIFACTS, checks = [], errors = [], network = [], pages = []
let f, browser
if (artifacts) await mkdir(artifacts, { recursive: true, mode: 0o700 })
const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
try {
  f = await createConsentFixture()
  const c = f.consent, first = await c.enroll(0), second = await c.enroll(1), job = await c.createJob()
  browser = await chromium.launch({ headless: true, ...(process.env.ATRIUM_CHROME_EXECUTABLE ? { executablePath: process.env.ATRIUM_CHROME_EXECUTABLE } : {}) })
  async function pageFor(actor, virtual = false) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    await context.route('**/*', route => {
      const origin = new URL(route.request().url()).origin
      if (origin === f.origin) return route.continue()
      network.push(origin); return route.fulfill({ status: 204, body: '' })
    })
    await context.addCookies([...actor.jar].map(([name, value]) => ({ name, value, url: f.origin, sameSite: 'Strict' })))
    const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.message))
    if (virtual) {
      const cdp = await context.newCDPSession(page)
      await cdp.send('WebAuthn.enable')
      const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true,
      } })
      // This key belongs only to this disposable test account. Never read or import an owner's credential.
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: {
        credentialId: Buffer.from(actor.device.credentialId, 'base64url').toString('base64'),
        isResidentCredential: true, rpId: new URL(f.origin).hostname,
        privateKey: actor.device.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        userHandle: Buffer.from(actor.userHandle, 'base64url').toString('base64'), signCount: actor.device.counter,
      } })
    }
    return page
  }
  async function sizes(page, name) {
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 }); await settled(page)
      await page.evaluate(() => {
        const task = ['consent-task', 'consent-staff-task'].map(id => document.getElementById(id)).find(el => el && !el.hidden)
        if (task) task.scrollIntoView({ block: 'start' }); else scrollTo(0, 0)
      }); await settled(page)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} no overflow at ${width}`)
      const heights = await page.locator('button:visible,input:visible:not([type=checkbox]),.button:visible').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
      assert.ok(heights.every(height => height >= 44), `${name} controls at least 44px at ${width}`)
      if (artifacts) { const path = `${artifacts}/${name}-${width}.png`; await page.screenshot({ path, fullPage: false }); await chmod(path, 0o600) }
    }
  }
  const staff = await pageFor(f.actors['owner-a']), resident = await pageFor(first, true), otherResident = await pageFor(second, true)
  const staffUrl = caseId => `${f.origin}/api/maintenance-consent?organizationId=organization-a&propertyId=property-a1&caseId=${caseId}`
  async function openStaff(caseId = job.caseId) {
    await staff.goto(staffUrl(caseId)); await staff.getByText('Current consent readiness loaded.', { exact: true }).waitFor()
  }
  async function saveStaff() {
    await staff.locator('#consent-staff-form').getByRole('button', { name: 'Review this change', exact: true }).click()
    await staff.locator('[data-consent-staff="save"]').press('Enter')
    await staff.locator('#consent-staff-task').waitFor({ state: 'hidden' })
    await staff.getByText('Change recorded. Current readiness is shown separately. No resident approval or message was created.', { exact: true }).waitFor()
  }
  await openStaff()
  await staff.locator('[data-consent-staff="policy"]').click()
  await staff.locator('#consent-staff-enabled').check()
  const p = {
    'no-charge': 'The property funds this exact repair; the resident will not be charged.',
    'recipient-protocol': 'Review the complete household and source-backed authority of every required person.',
    'entry-protocol': 'Review the named team, apartment, exact entry window and required resident authority.',
    'response-minutes': '60', 'valid-minutes': '1440', 'entry-minutes': '120',
    'help-label': 'Synthetic property team', 'help-phone': '+15555550101',
    emergency: 'For immediate danger, call emergency services from a safe location and contact the property team.',
    'source-reference': 'Synthetic owner-approved consent protocol', 'source-version': 'browser-1',
    'source-observed': new Date(Date.now() - 60000).toISOString().slice(0, 19),
    'source-until': new Date(Date.now() + 86400000).toISOString().slice(0, 19),
    reason: 'Owner reviewed the synthetic property protocol',
  }
  for (const [key, value] of Object.entries(p)) await staff.locator('#consent-staff-' + key).fill(value)
  await staff.locator('#consent-staff-form').getByRole('button', { name: 'Review this change', exact: true }).click()
  await sizes(staff, 'staff-policy-review')
  await staff.locator('[data-consent-staff="save"]').press('Enter')
  await staff.getByText('Change recorded. Current readiness is shown separately. No resident approval or message was created.', { exact: true }).waitFor()
  assert.equal((await c.staffState(job.caseId)).state.policy.enabled, true)
  checks.push('Owner reviews and saves explicit property-funded/no-resident-charge policy through actual UI and keyboard confirmation')

  await c.configure(job.caseId, [first, second])
  await openStaff()
  await staff.locator('[data-consent-staff="roster"]').click()
  assert.equal(await staff.locator('.consent-authority-card').count(), (await c.staffState(job.caseId)).state.residents.length)
  await staff.locator('#consent-staff-complete').check(); await staff.locator('#consent-staff-protocol').check()
  await staff.locator('#consent-staff-reason').fill('Reviewed every synthetic household candidate and required purpose')
  await saveStaff()
  assert.equal((await c.staffState(job.caseId)).state.roster.members.filter(member => member.requiredPurposes.length).length, 2)
  checks.push('Staff reviews the complete persisted household roster without silently dropping non-required or source-limited candidates')

  async function prepareRequest(purpose, window = purpose === 'entry' ? c.entryWindow() : null) {
    await staff.locator(`[data-consent-staff="request"][data-purpose="${purpose}"]`).click()
    await staff.locator('#consent-staff-summary').fill('Replace your kitchen tap washer')
    await staff.locator('#consent-staff-conditions').fill('Only the reviewed kitchen tap work and named building team.')
    await staff.locator('#consent-staff-response-deadline').fill(new Date(Date.now() + 1800000).toISOString().slice(0, 19))
    await staff.locator('#consent-staff-valid-until').fill(new Date(Date.now() + 10800000).toISOString().slice(0, 19))
    if (window) {
      await staff.locator('#consent-staff-entry-start').fill(window.startsLocal.slice(0, 19)); await staff.locator('#consent-staff-entry-start-offset').fill(window.startsLocal.slice(23))
      await staff.locator('#consent-staff-entry-end').fill(window.endsLocal.slice(0, 19)); await staff.locator('#consent-staff-entry-end-offset').fill(window.endsLocal.slice(23))
    }
    await staff.locator('#consent-staff-reviewed').check()
    await staff.locator('#consent-staff-reason').fill('Reviewed public terms against exact work, payment and named party')
    await staff.locator('#consent-staff-form').getByRole('button', { name: 'Review this change', exact: true }).click()
  }
  for (const purpose of ['work', 'entry']) {
    await prepareRequest(purpose)
    assert.match(await staff.locator('#consent-staff-task').innerText(), /Replace the kitchen tap washer/)
    assert.match(await staff.locator('#consent-staff-task').innerText(), /No resident charge/)
    if (purpose === 'entry') await sizes(staff, 'staff-entry-review')
    await staff.locator('[data-consent-staff="save"]').click()
    await staff.getByText('Change recorded. Current readiness is shown separately. No resident approval or message was created.', { exact: true }).waitFor()
  }
  const initial = (await c.staffState(job.caseId)).state, work = initial.purposes.find(row => row.purpose === 'work').request, entry = initial.purposes.find(row => row.purpose === 'entry').request
  assert.equal(work.version, 1); assert.equal(entry.version, 1); assert.equal(work.materialDigest, entry.materialDigest)
  checks.push('Staff publishes independently versioned work and exact timezone/offset entry terms after reviewing all material details')

  async function openResident(page, requestId) {
    await page.goto(`${f.origin}/api/resident-consent?requestId=${requestId}`)
    await page.locator('#consent-detail [data-consent="grant"],#consent-detail [data-consent="decline"],#consent-detail [data-consent="revoke"]').first().waitFor()
  }
  async function grant(page, requestId, capture = false) {
    await openResident(page, requestId)
    await page.locator('#consent-detail [data-consent="grant"]').click()
    await page.locator('#consent-task').waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => document.activeElement.id), 'consent-task')
    if (capture) await sizes(page, 'resident-work-review')
    await page.locator('[data-consent="confirm"]').press('Enter')
    await page.getByText('Your approval was recorded. Current permission is shown separately. No appointment or dispatch is confirmed.', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => sessionStorage.getItem('atrium.resident.consent-check.v1')), null)
  }
  await grant(resident, work.id, true)
  let state = (await c.staffState(job.caseId)).state
  assert.equal(state.purposes.find(row => row.purpose === 'work').effectiveness.effective, false)
  assert.equal(state.purposes.find(row => row.purpose === 'entry').effectiveness.effective, false)
  const ownBody = await resident.locator('body').innerText()
  for (const privateText of [second.principal.userId, 'Synthetic Consent Resident 1', 'Synthetic reviewed household and purpose authority', 'Staff reviewed exact work and cost']) assert.ok(!ownBody.includes(privateText), 'Resident excludes another household member and staff evidence')
  assert.match(ownBody, /Your charge for this job\s*\$0\.00/)
  await grant(otherResident, work.id)
  state = (await c.staffState(job.caseId)).state
  assert.equal(state.purposes.find(row => row.purpose === 'work').effectiveness.effective, true)
  assert.equal(state.purposes.find(row => row.purpose === 'entry').effectiveness.effective, false)
  await grant(resident, entry.id); await grant(otherResident, entry.id)
  state = (await c.staffState(job.caseId)).state
  assert.equal(state.purposes.find(row => row.purpose === 'entry').effectiveness.effective, true)
  assert.equal(state.purposes.find(row => row.purpose === 'entry').effectiveness.dispatchStatus, 'not_dispatched')
  assert.equal(state.purposes.find(row => row.purpose === 'entry').effectiveness.notificationStatus, 'not_sent')
  checks.push('Two required residents each grant work and entry separately using actual Chromium CTAP2 assertions and persisted atomic receipts; private staff/household details stay excluded')

  await openResident(resident, entry.id)
  await resident.locator('[data-consent="revoke"]').click(); await resident.locator('[data-consent="confirm"]').click()
  await resident.getByText('Your revocation was recorded. Current permission is shown separately. No appointment or dispatch is confirmed.', { exact: true }).waitFor()
  await resident.locator('[data-consent="history"]').click(); await resident.getByRole('heading', { name: 'Your recorded history', exact: true }).waitFor()
  assert.match(await resident.locator('#consent-history').innerText(), /You revoked/)
  await resident.locator('#consent-history summary').first().click(); assert.match(await resident.locator('#consent-history').innerText(), /Replace the kitchen tap washer/)
  assert.equal((await c.residentDetail(first, work.id)).detail.effectiveness.effective, true)
  await grant(resident, entry.id)
  checks.push('Exact own entry revocation and recorded terms history remain usable; work stays effective and explicit reconsideration needs another passkey decision')

  await openStaff()
  await prepareRequest('entry', c.entryWindow(new Date(Date.now() + 7200000), new Date(Date.now() + 9000000)))
  await staff.locator('[data-consent-staff="save"]').click(); await staff.getByText('Change recorded. Current readiness is shown separately. No resident approval or message was created.', { exact: true }).waitFor()
  state = (await c.staffState(job.caseId)).state
  assert.equal(state.purposes.find(row => row.purpose === 'work').request.version, work.version)
  assert.equal(state.purposes.find(row => row.purpose === 'work').effectiveness.effective, true)
  assert.equal(state.purposes.find(row => row.purpose === 'entry').request.version, 2)
  assert.equal(state.purposes.find(row => row.purpose === 'entry').effectiveness.effective, false)
  await openResident(resident, entry.id)
  assert.match(await resident.locator('#consent-detail').innerText(), /Historical|Current reviewed terms/)
  await sizes(resident, 'resident-entry-revision')
  checks.push('Changing only the entry window preserves unchanged work approval and creates a new entry review with no carried-forward effective permission')

  await openResident(resident, work.id)
  let declinePosts = 0
  await resident.route('**/api/resident-consent', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== 'decline') return route.fallback()
    declinePosts++; const response = await route.fetch(); assert.equal(response.status(), 200)
    return route.fulfill({ response, body: '{"unconfirmed":true}', headers: { ...response.headers(), 'content-type': 'application/json' } })
  })
  await resident.locator('[data-consent="decline"]').click(); await resident.locator('[data-consent="confirm"]').click()
  await resident.locator('[data-consent="check"]').waitFor()
  assert.match(await resident.locator('#consent-recovery').innerText(), /may have been saved/)
  const marker = await resident.evaluate(() => JSON.parse(sessionStorage.getItem('atrium.resident.consent-check.v1')))
  assert.deepEqual(Object.keys(marker).sort(), ['commandId', 'purpose', 'requestId'])
  await resident.unroute('**/api/resident-consent'); await resident.reload(); await resident.locator('[data-consent="check"]').click()
  await resident.getByText('Saved decline confirmed. Check the current terms and permission status separately.', { exact: true }).waitFor()
  assert.equal(declinePosts, 1); assert.equal(await resident.evaluate(() => sessionStorage.getItem('atrium.resident.consent-check.v1')), null)
  assert.equal((await c.residentDetail(first, work.id)).detail.ownDecision.decision, 'decline')
  checks.push('Committed resident decision with malformed response survives reload and is reconciled by its own receipt without a duplicate POST')

  const noEntryJob = await c.createJob({ accessRequirement: 'no_unit_entry' })
  await openStaff(noEntryJob.caseId); await prepareRequest('work')
  let publishPosts = 0
  await staff.route('**/api/maintenance-consent', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== 'publish_request') return route.fallback()
    publishPosts++; const response = await route.fetch(); assert.equal(response.status(), 200)
    return route.fulfill({ response, body: '{"unconfirmed":true}', headers: { ...response.headers(), 'content-type': 'application/json' } })
  })
  await staff.locator('[data-consent-staff="save"]').click(); await staff.locator('[data-consent-staff="check"]').waitFor()
  const staffMarker = await staff.evaluate(() => JSON.parse(sessionStorage.getItem('atrium.staff.consent-check.v1.' + window.ATRIUM_MAINTENANCE_CONSENT.caseId)))
  assert.deepEqual(Object.keys(staffMarker).sort(), ['caseId', 'commandId'])
  await staff.unroute('**/api/maintenance-consent'); await staff.reload(); await staff.locator('[data-consent-staff="check"]').click()
  await staff.getByText('The saved change was confirmed. Review the freshly loaded current state.', { exact: true }).waitFor()
  assert.equal(publishPosts, 1)
  state = (await c.staffState(noEntryJob.caseId)).state
  assert.equal(state.purposes.find(row => row.purpose === 'entry').effectiveness.required, false)
  assert.equal(await staff.locator('[data-consent-staff="request"][data-purpose="entry"]').count(), 0)
  await sizes(staff, 'staff-current-readiness')
  checks.push('Staff recovers exact saved terms after malformed response; no-entry work has no irrelevant entry request or fake approval')

  assert.deepEqual(errors, []); assert.deepEqual(f.errors, []); assert.deepEqual(f.remoteRequests, []); assert.deepEqual(network, [])
  const report = { ok: true, checks, browserErrors: errors, providerRequests: f.remoteRequests.length, evidence: 'Actual Chromium virtual CTAP2 + loopback HTTP + disposable PostgreSQL; no physical device or hosted activation' }
  if (artifacts) { const path = artifacts + '/acceptance.json'; await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await chmod(path, 0o600) }
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  const last = pages.filter(page => page.url() !== 'about:blank').at(-1)
  if (artifacts && last) { const path = artifacts + '/failure.png'; await last.screenshot({ path }).catch(() => {}); await chmod(path, 0o600).catch(() => {}) }
  console.error(JSON.stringify({ checks, browserErrors: errors, message: error.message }, null, 2)); throw error
} finally { await browser?.close(); await f?.close() }
