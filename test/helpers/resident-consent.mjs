import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createEnrollmentFixture } from './resident-enrollment.mjs'
import { SoftwareAuthenticator } from './software-authenticator.mjs'
import { PostgresResidentServicesRepository } from '../../src/database/resident-services.ts'

/** Actual enrollment, credentials, passkey signatures, native persistence and HTTP. No external providers. */
export async function createConsentFixture() {
  const f = await createEnrollmentFixture({ additionalRoutes: ['resident-consent', 'maintenance-consent', 'maintenance-plans'] })
  const source = () => ({ reference: 'Synthetic reviewed household and purpose authority', version: 'review-1',
    observedAt: new Date(Date.now() - 60000).toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString() })
  const defaults = options => ({ actor: f.actors['owner-a'], property: 'property-a1', org: 'organization-a', ...options })
  const staffRead = async (caseId, resource = 'state', params = {}, options = {}) => {
    const { actor, property, org } = defaults(options)
    return f.request('/api/maintenance-consent?' + new URLSearchParams({ format: 'json', resource, caseId, ...params }), {
      jar: actor.jar, headers: { ...f.staffHeaders(actor, property, org), ...options.headers },
    })
  }
  const staffState = async (caseId, options) => {
    const result = await staffRead(caseId, 'state', {}, options)
    assert.equal(result.status, 200, result.text); return result.json
  }
  const staffPost = async (caseId, command, options = {}) => {
    const { actor, property, org } = defaults(options)
    const form = options.formToken ?? (await staffState(caseId, options)).formToken
    return f.request('/api/maintenance-consent', { jar: actor.jar, body: command, headers: {
      ...f.staffHeaders(actor, property, org), 'x-atrium-case-id': caseId,
      'x-atrium-consent-form': form, 'x-atrium-consent-action': command.action, ...options.headers,
    } })
  }
  const staffSave = async (caseId, command, options) => {
    const result = await staffPost(caseId, command, options)
    assert.equal(result.status, 200, result.text); return result.json.receipt
  }
  const residentHeaders = actor => ({ 'x-atrium-user-id': actor.principal.userId, 'x-atrium-session-id': actor.principal.sessionId })
  const residentRead = async (actor, resource = 'list', params = {}, headers = {}) => f.request(
    '/api/resident-consent?' + new URLSearchParams({ format: 'json', resource, ...params }),
    { jar: actor.jar, headers: { ...residentHeaders(actor), ...headers } })
  const residentDetail = async (actor, requestId) => {
    const result = await residentRead(actor, 'detail', { requestId })
    assert.equal(result.status, 200, result.text); return result.json
  }
  const residentPost = async (actor, body, options = {}) => {
    const list = options.formToken ? null : await residentRead(actor)
    if (list) assert.equal(list.status, 200, list.text)
    return f.request('/api/resident-consent', { jar: actor.jar, body, headers: {
      ...residentHeaders(actor), 'x-atrium-consent-form': options.formToken ?? list.json.formToken,
      'x-atrium-consent-action': body.action, ...options.headers,
    } })
  }
  const enroll = async (index, { property = 'property-a1', org = 'organization-a', staff = f.actors['owner-a'], passkey = true } = {}) => {
    const residentId = f.residents[property][index], invite = await f.issue(residentId, { property, org, actor: staff })
    const { jar, state } = await f.exchange(invite.token)
    const username = `consent-${randomUUID()}`, password = `Synthetic-consent-${randomUUID()}`
    const activation = await f.residentPost(jar, { action: 'activate_new', requestId: randomUUID(),
      invitationVersion: state.invitation.invitationVersion, reviewToken: state.reviewToken,
      username, displayName: `Synthetic Consent Resident ${index}`, password }, state)
    assert.equal(activation.status, 200, activation.text)
    const signIn = await f.residentPost(jar, { action: 'sign_in', username, password })
    assert.equal(signIn.status, 200, signIn.text)
    const principal = await f.runtime.authenticateResident({ cookie: `atrium_resident_session=${jar.get('atrium_resident_session')}` }, new Date())
    assert.ok(principal)
    const actor = { jar, principal, username, password, residentId, device: null, userHandle: null, factorId: null }
    if (passkey) {
      const reauth = await f.runtime.mfa.password(principal, password)
      const registration = await f.runtime.mfa.registrationOptions(principal, { label: 'Synthetic consent passkey', reauthenticationId: reauth.id, recoveryGrantId: null })
      actor.device = new SoftwareAuthenticator()
      const receipt = await f.runtime.mfa.finish(principal, { kind: 'registration', challengeId: registration.challengeId,
        response: actor.device.registrationResponse({ challenge: registration.optionsJSON.challenge, origin: f.origin, rpId: registration.optionsJSON.rp.id }) })
      assert.equal(receipt.outcome, 'factor_pending')
      actor.factorId = receipt.factorId
      actor.userHandle = (await f.runtime.mfa.state(principal)).userHandle
      await verifyLogin(actor)
    }
    return actor
  }
  const verifyLogin = async actor => {
    const options = await f.runtime.mfa.authenticationOptions(actor.principal, { purpose: 'session_login', factorId: actor.factorId })
    const receipt = await f.runtime.mfa.finish(actor.principal, { kind: 'authentication', challengeId: options.challengeId,
      response: actor.device.authenticationResponse({ challenge: options.optionsJSON.challenge, origin: f.origin,
        rpId: options.optionsJSON.rpId, userHandle: actor.userHandle }) })
    assert.equal(receipt.outcome, 'verified')
    return receipt
  }
  const planningRead = async (resource, params = {}, options = {}) => {
    const { actor, property, org } = defaults(options)
    const result = await f.request('/api/maintenance-plans?' + new URLSearchParams({ resource, ...params }), {
      jar: actor.jar, headers: f.staffHeaders(actor, property, org),
    })
    assert.equal(result.status, 200, result.text); return result.json
  }
  const planningSave = async (command, options = {}) => {
    const { actor, property, org } = defaults(options), overview = await planningRead('overview', {}, options)
    const result = await f.request('/api/maintenance-plans', { jar: actor.jar, body: command, headers: {
      ...f.staffHeaders(actor, property, org), 'x-atrium-planning-form': overview.formToken, 'x-atrium-planning-action': command.action,
    } })
    assert.equal(result.status, 200, result.text); return result.json.receipt
  }
  const createJob = async ({ accessRequirement = 'unit_entry', requireWorkConsent = true, ...options } = {}) => {
    const { actor, property, org } = defaults(options)
    const resolved = await f.runtime.loadUserProperty(actor.principal, { organizationId: org, propertyId: property }, 'operate')
    const repository = new PostgresResidentServicesRepository(f.db.app, resolved.scope, { configurationVersion: 1 })
    const created = await repository.execute({ action: 'create_request', requestId: randomUUID(), intake: {
      requestOrigin: 'resident_report', location: { kind: 'unit', unitId: '19A' }, residentId: f.residents[property][0],
      summary: 'Kitchen tap dripping', description: 'Synthetic request for a washer replacement', category: 'plumbing', reportedPriority: 'routine',
      reporterName: null, reporterPhone: null, reporterEmail: null, accessNotes: '',
    } })
    await repository.execute({ action: 'triage_request', requestId: randomUUID(), id: created.id, expectedVersion: 1,
      state: 'ready_for_planning', priority: 'routine', note: 'Synthetic staff reviewed current issue and occupancy' })
    let overview = await planningRead('overview', {}, options)
    if (!overview.policy) {
      await planningSave({ action: 'publish_policy', requestId: randomUUID(), expectedVersion: 0, reason: 'Owner reviewed the synthetic property spending policy', details: {
        currency: 'USD', automaticLimitCents: 10000, managerLimitCents: 50000, ownerLimitCents: 100000,
        automaticCategories: ['plumbing'], excludedCategories: ['access'], requireResidentApproval: requireWorkConsent, requireIndependentApprover: true,
        sourceReference: 'Synthetic reviewed property authority', observedAt: source().observedAt, validUntil: source().validUntil,
      } }, options)
      overview = await planningRead('overview', {}, options)
    }
    const plan = await planningSave({ action: 'prepare_plan', requestId: randomUUID(), caseId: created.id, expectedCaseVersion: 2,
      expectedPlanVersion: 0, policyVersion: overview.policy.version, details: { route: 'internal', vendorId: null, vendorVersion: null,
        internalTeam: 'Building maintenance', scopeOfWork: 'Replace the kitchen tap washer', currency: 'USD', maximumCents: 10000,
        includesAllCharges: true, accessRequirement, restrictions: [], reason: 'Staff reviewed exact work and cost' } }, options)
    return { caseId: created.id, planId: plan.id, planVersion: plan.version }
  }
  const configure = async (caseId, actors, options = {}) => {
    let state = (await staffState(caseId, options)).state
    if (!state.policy || options.policySource) await staffSave(caseId, { action: 'publish_policy', commandId: randomUUID(), expectedVersion: state.policy?.version ?? 0,
      details: { enabled: true, funding: 'property_no_resident_charge', recipientRule: 'reviewed_complete_roster', requireWorkConsent: true,
        noChargeStatement: 'The property covers this work; the resident will not be charged.',
        recipientProtocol: 'Review the full current household roster and who is authorized to decide about this exact work.',
        entryProtocol: 'Review each required resident authority for the exact named party and apartment entry window.',
        maximumResponseMinutes: 60, maximumConsentMinutes: 1440, maximumEntryMinutes: 120,
        helpLabel: 'Synthetic property team', helpPhone: '+15555550101', helpUrl: null,
        emergencyInstructions: 'For immediate danger use the configured emergency service and contact the property team.', source: options.policySource ?? source() },
      reason: 'Owner reviewed synthetic work and entry consent rules' }, options)
    state = (await staffState(caseId, options)).state
    await staffSave(caseId, { action: 'publish_roster', commandId: randomUUID(), expectedVersion: state.roster?.version ?? 0,
      policyVersion: state.policy.version, details: { unitId: '19A', complete: true, protocolCompleted: true, source: source(),
        members: state.residents.map(resident => ({ residentId: resident.id, residentVersion: resident.version,
          requiredPurposes: actors.some(actor => actor.residentId === resident.id) ? ['work', 'entry'] : [] })) },
      reason: 'Reviewed every current household record and required purpose' }, options)
    for (const actor of actors) for (const purpose of ['work', 'entry']) {
      const connection = (await f.staffState(actor.residentId, options)).state
      assert.ok(connection.binding)
      const previous = state.authorities.filter(item => item.residentId === actor.residentId
        && item.bindingId === connection.binding.id && item.purpose === purpose).sort((a, b) => b.version - a.version)[0]
      await staffSave(caseId, { action: 'save_authority', commandId: randomUUID(), id: previous?.id ?? null, expectedVersion: previous?.version ?? 0,
        policyVersion: state.policy.version, details: { bindingId: connection.binding.id, bindingVersion: connection.binding.version,
          residentId: actor.residentId, residentVersion: connection.resident.version, purpose, source: source(), protocolCompleted: true },
        reason: 'Reviewed synthetic resident authority for this purpose' }, options)
    }
    return (await staffState(caseId, options)).state
  }
  const entryWindow = (startsAt = new Date(Date.now() + 3600000), endsAt = new Date(Date.now() + 7200000), timeZone = 'America/New_York') => {
    const local = date => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(date).map(item => [item.type, item.value]))
      const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '')
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3, '0')}${offset}`
    }
    return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), startsLocal: local(startsAt), endsLocal: local(endsAt), timeZone }
  }
  const publishRequest = async (caseId, purpose, { entry = purpose === 'entry' ? entryWindow() : null, ...options } = {}) => {
    const state = (await staffState(caseId, options)).state, previous = state.purposes.find(item => item.purpose === purpose).request
    const command = { action: 'publish_request', commandId: randomUUID(), caseId, expectedCaseVersion: state.caseVersion,
      planId: state.plan.id, planVersion: state.plan.version, purpose, expectedVersion: previous?.version ?? 0,
      consentPolicyVersion: state.policy.version, rosterId: state.roster.id, rosterVersion: state.roster.version,
      publicSummary: 'Replace your kitchen tap washer', conditions: 'Only the reviewed work and named building team.',
      funding: 'property_no_resident_charge', reviewedAgainstPlan: true, responseDeadline: new Date(Date.now() + 1800000).toISOString(),
      consentValidUntil: new Date(Date.now() + 10800000).toISOString(), entryWindow: entry,
      reason: 'Staff reviewed these exact public terms against the work plan' }
    return { command, receipt: await staffSave(caseId, command, options) }
  }
  const grant = async (actor, requestId, options = {}) => {
    const detail = (await residentDetail(actor, requestId)).detail
    const command = { action: 'grant', commandId: randomUUID(), requestId, requestVersion: detail.requestVersion,
      expectedDecisionVersion: detail.ownDecisionVersion, purpose: detail.purpose, termsDigest: detail.termsDigest, materialDigest: detail.materialDigest }
    const begin = await residentPost(actor, { action: 'grant_options', command })
    assert.equal(begin.status, 200, begin.text)
    const response = actor.device.authenticationResponse({ challenge: begin.json.optionsJSON.challenge,
      origin: f.origin, rpId: begin.json.optionsJSON.rpId, userHandle: actor.userHandle, ...options.assertion })
    const finish = await residentPost(actor, { action: 'grant_finish', challengeId: begin.json.challengeId, response })
    if (!options.allowFailure) assert.equal(finish.status, 200, finish.text)
    return { command, begin, response, finish }
  }
  return { ...f, consent: { source, staffRead, staffState, staffPost, staffSave, residentRead, residentDetail,
    residentPost, residentHeaders, enroll, verifyLogin, planningRead, planningSave, createJob, configure, entryWindow, publishRequest, grant } }
}
