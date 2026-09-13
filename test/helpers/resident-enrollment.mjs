import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { PostgresResidentServicesRepository } from '../../src/database/resident-services.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { verifyOrganizationSession } from './organization-session.mjs'

/** Disposable native database and actual HTTP handlers; all values and passkeys are synthetic. */
export async function createEnrollmentFixture({ additionalRoutes = [] } = {}) {
  const previous = { ...process.env }, originalFetch = globalThis.fetch, errors = [], remoteRequests = []
  for (const key of ['ATRIUM_SIMULATION','ATRIUM_DATABASE_URL','ATRIUM_AUTH_DATABASE_URL','OPS_ACCOUNTS_JSON',
    'OPS_DASHBOARD_PASSCODE','DASHBOARD_TOKEN','VAPI_API_KEY','VAPI_PRIVATE_KEY','VAPI_ASSISTANT_ID','VERCEL']) delete process.env[key]
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  let db, server, runtime, origin
  const secret = randomBytes(40).toString('base64url'), actors = {}, residents = {}
  try {
    const permittedAdditionalRoutes = ['resident-consent', 'maintenance-consent', 'maintenance-plans']
    assert.ok(additionalRoutes.every(name => permittedAdditionalRoutes.includes(name)))
    const routes = new Map(await Promise.all([...new Set(['dashboard','resident','resident-access','mfa','resident-services','properties', ...additionalRoutes])]
      .map(async name => [`/api/${name}`, (await import(`../../api/${name}.ts`)).default])))
    db = await createFoundationTestDatabase()
    const { password } = await seedFoundationTestDatabase(db.admin)
    for (const [org, property] of [['organization-a','property-a1'], ['organization-a','property-a2'], ['organization-b','property-b1']]) {
      const bundle = { property: { id: property, organizationId: org, buildingName: `Synthetic Enrollment ${property}`,
        timeZone: property === 'property-a2' ? 'America/Chicago' : property === 'property-b1' ? 'America/Los_Angeles' : 'America/New_York', jurisdiction: 'NY', tourSettings: defaultSettings() },
      inventory: [{ unitId: '19A', floorPlanId: 'plan-3', floor: 19, bedrooms: 3, bathrooms: 2, sqft: 1400,
        monthlyRent: 5000, availableFrom: '2026-09-01', status: 'leased' }],
      floorplans: [{ id: 'plan-3', name: 'Three bedroom', bedrooms: 3, bathrooms: 2, sqft: 1400, description: 'Synthetic plan', features: [] }], knowledge: [] }
      await db.admin.query(`INSERT INTO atrium.property_configurations
        (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
        VALUES($1,$2,1,'published',$3,clock_timestamp(),'synthetic-enrollment',clock_timestamp())`, [org, property, JSON.stringify(bundle)])
      await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2', [org, property])
    }
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, origin)
        if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return }
        const handler = routes.get(url.pathname)
        if (!handler) { res.statusCode = 404; res.end('Not found'); return }
        req.atriumRuntime = runtime
        let raw = ''
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 70_000) throw new Error('Synthetic oversized request') }
        req.body = raw; req.query = {}
        for (const key of new Set(url.searchParams.keys())) {
          const values = url.searchParams.getAll(key); req.query[key] = values.length === 1 ? values[0] : values
        }
        res.status = code => { res.statusCode = code; return res }
        res.send = value => { res.end(value); return res }
        res.json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return res }
        await handler(req, res)
      } catch (error) { errors.push({ name: error.name, code: error.code }); res.statusCode = 500; res.end('Synthetic enrollment handler failed') }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    origin = `http://localhost:${server.address().port}`
    runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: secret, authOrigin: origin })
    globalThis.fetch = async () => { remoteRequests.push('attempt'); throw new Error('External providers disabled in enrollment fixture') }
    const request = async (path, { jar, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
      const response = await originalFetch(origin + path, { method, redirect: 'manual', headers: {
        ...(jar ? { cookie: [...jar].map(([key,value]) => `${key}=${value}`).join('; ') } : {}),
        ...(body === undefined ? {} : { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }), ...headers,
      }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
      if (jar) for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';'), i = pair.indexOf('='); jar.set(pair.slice(0,i), pair.slice(i+1))
      }
      const text = await response.text()
      for (const value of [secret, password]) assert.ok(!text.includes(value), 'No fixture secret in response')
      assert.doesNotMatch(text, /password_hash|scrypt\$|postgres(?:ql)?:\/\//)
      let json; try { json = JSON.parse(text) } catch { /* HTML responses are intentional. */ }
      return { status: response.status, headers: response.headers, text, json }
    }
    for (const name of ['owner-a','owner-b','viewer-a']) {
      const jar = new Map()
      const signed = await request('/api/dashboard', { jar, body: new URLSearchParams({ username: name, password }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
      assert.equal(signed.status, 303)
      const principal = await runtime.authenticate({ cookie: `atrium_ops=${jar.get('atrium_ops')}` }, new Date())
      await verifyOrganizationSession(runtime, principal, password, { purpose: name === 'viewer-a' ? 'session_login' : 'organization_administration' })
      actors[name] = { jar, principal }
    }
    const staffHeaders = (actor = actors['owner-a'], property = 'property-a1', org = 'organization-a') => ({
      'x-atrium-user-id': actor.principal.userId, 'x-atrium-session-id': actor.principal.sessionId,
      'x-atrium-organization-id': org, 'x-atrium-property-id': property, 'x-atrium-config-version': '1',
    })
    for (const [org, property, name] of [['organization-a','property-a1','owner-a'], ['organization-a','property-a2','owner-a'], ['organization-b','property-b1','owner-b']]) {
      const actor = actors[name], resolved = await runtime.loadUserProperty(actor.principal, { organizationId: org, propertyId: property }, 'configure')
      const repository = new PostgresResidentServicesRepository(db.app, resolved.scope, { configurationVersion: 1 })
      residents[property] = []
      for (let i = 0; i < 6; i++) {
        const receipt = await repository.execute({ action: 'add_resident', requestId: randomUUID(), details: {
          unitId: '19A', displayName: `Synthetic Recipient ${property} ${i}`, relationship: 'occupant', startsOn: '2020-01-01', endsOn: null,
          phone: null, email: null, source: { kind: 'staff_review', reference: 'Synthetic verified occupancy source', version: 'review-1',
            observedAt: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString() },
        }, reason: 'Synthetic authorized occupancy record' })
        residents[property].push(receipt.id)
      }
    }
    const staffState = async (residentId, { actor = actors['owner-a'], property = 'property-a1', org = 'organization-a' } = {}) => {
      const result = await request(`/api/resident-access?format=json&resource=state&residentId=${residentId}`, { jar: actor.jar, headers: staffHeaders(actor, property, org) })
      assert.equal(result.status, 200, result.text); return result.json
    }
    const staffSave = async (residentId, command, options = {}) => {
      const { actor = actors['owner-a'], property = 'property-a1', org = 'organization-a', formToken } = options
      const form = formToken ?? (await staffState(residentId, options)).formToken
      return request('/api/resident-access', { jar: actor.jar, body: command, headers: {
        ...staffHeaders(actor, property, org), 'x-atrium-resident-id': residentId, 'x-atrium-enrollment-form': form, 'x-atrium-enrollment-action': command.action,
      } })
    }
    const publish = async (residentId, options = {}) => {
      const state = await staffState(residentId, options)
      const result = await staffSave(residentId, { action: 'publish_policy', requestId: randomUUID(), expectedVersion: state.state.policy?.version ?? null,
        details: { enabled: true, method: 'in_person_staff_check', protocol: 'Synthetic protocol: verify the recipient in person against the current authorized occupancy schedule.',
          invitationLifetimeMinutes: 60, sourceReference: 'Synthetic owner-approved recipient protocol', observedAt: new Date(Date.now()-60_000).toISOString(), validUntil: new Date(Date.now()+86_400_000).toISOString() },
        reason: 'Synthetic owner approved resident access' }, options)
      assert.equal(result.status, 200, result.text); return result.json
    }
    const issue = async (residentId, options = {}) => {
      const state = await staffState(residentId, options)
      const command = { action: 'issue_invitation', requestId: randomUUID(), residentId, expectedResidentVersion: state.state.resident.version,
        expectedPolicyVersion: state.state.policy.version, replaces: state.state.invitation && ['pending','stale','expired'].includes(state.state.invitation.state) ? { id: state.state.invitation.id, version: state.state.invitation.version } : null,
        checkedAt: new Date().toISOString(), evidenceReference: 'Synthetic completed in-person protocol reference', protocolCompleted: true, reason: 'Recipient requested portal access' }
      const result = await staffSave(residentId, command, options)
      assert.equal(result.status, 200, result.text)
      return { ...result.json, command, token: new URL(result.json.invitationUrl).hash.slice('#invite='.length) }
    }
    for (const [property, org, name] of [['property-a1','organization-a','owner-a'], ['property-a2','organization-a','owner-a'], ['property-b1','organization-b','owner-b']]) {
      await publish(residents[property][0], { property, org, actor: actors[name] })
    }
    const residentState = async jar => {
      const response = await request('/api/resident?format=json&resource=state', { jar })
      assert.equal(response.status, 200, response.text); return response.json
    }
    const residentHeaders = state => ({ 'x-atrium-resident-form': state.formToken,
      ...(state.userId ? { 'x-atrium-user-id': state.userId, 'x-atrium-session-id': state.sessionId } : {}) })
    const residentPost = async (jar, body, state) => request('/api/resident', { jar, body, headers: residentHeaders(state ?? await residentState(jar)) })
    const exchange = async token => {
      const jar = new Map(), result = await residentPost(jar, { action: 'exchange', token })
      assert.equal(result.status, 200, result.text)
      return { jar, state: await residentState(jar) }
    }
    return { db, runtime, origin, password, actors, residents, errors, remoteRequests, request, staffHeaders, staffState, staffSave,
      publish, issue, residentState, residentHeaders, residentPost, exchange, close }
  } catch (error) { await close(); throw error }
  async function close() {
    globalThis.fetch = originalFetch
    if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
    await db?.close()
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}
