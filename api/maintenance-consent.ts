import { randomBytes } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, runtimeForRequest } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { assertManagedSession } from '../src/auth/session-management.ts'
import { propertyTransaction } from '../src/database/scope.ts'
import { ConsentError } from '../src/residents/consent-model.ts'
import { consentHeaders, consentPageHeaders, consentQuery, consentKeys, consentBody, consentId,
  consentInvalid, consentListQuery, consentServices, consentFailure } from '../src/residents/consent-http.ts'
import { mintConsentForm, verifyConsentForm } from '../src/residents/consent-tokens.ts'
import { assertConsentFreshness } from '../src/residents/consent-freshness.ts'
import { renderMaintenanceConsentPage } from '../src/residents/consent-staff-page.ts'
import client from '../src/residents/consent-staff-client.bundle.json' with { type: 'json' }

/** Staff publish reviewed requests; only the separate resident endpoint records their decisions. */
export default async function handler(req: any, res: any) {
  consentHeaders(req, res)
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ code: 'consent_not_enabled', error: 'Resident decisions require a managed property workspace.' }); return }
    if (!['GET','POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only.' }); return }
    const query = consentQuery(req.query), headers = req.headers ?? {}, runtime = runtimeForRequest(req)
    const principal = await runtime.authenticate(headers, new Date()), html = req.method === 'GET' && query.format === undefined
    if (!principal) {
      if (html) { res.setHeader('location', '/api/dashboard?reauthenticate=1'); res.status(303).send(''); return }
      throw new ConsentError('consent_unauthenticated')
    }
    assertManagedSession(principal)
    if (principal.audience !== 'staff') throw new ConsentError('consent_forbidden')
    const body = req.method === 'POST' ? consentBody(req.body) : null
    const permission = body && !['publish_request','withdraw_request'].includes(String(body.action)) ? 'configure' : 'operate'
    if (html) consentKeys(query, ['organizationId','propertyId','caseId'])
    const property = html ? await runtime.loadUserProperty(principal, { organizationId: query.organizationId, propertyId: query.propertyId }, permission)
      : await resolveOpsRuntime(req, permission)
    if (property.scope.actor.kind !== 'user' || property.scope.actor.userId !== principal.userId || property.scope.actor.sessionId !== principal.sessionId) throw new ConsentError('consent_changed')
    const caseId = consentId(req.method === 'POST' ? headers['x-atrium-case-id'] : query.caseId)
    const { repository, service } = consentServices(runtime)
    const fence = async () => {
      await property.revalidate()
      await propertyTransaction(runtime.app, property.scope, permission, async () => {}, property.snapshot.version)
    }
    const send = async (payload: Record<string, unknown>, deadlines: Array<string | null> = []) => {
      await fence()
      assertConsentFreshness(deadlines)
      res.status(200).json({ ...payload, audience: 'staff', userId: principal.userId, sessionId: principal.sessionId, caseId, scope: property.responseScope,
        formToken: mintConsentForm(principal, property.responseScope, caseId, new Date(), runtime.sessionSecret) })
    }
    if (html) {
      await repository.staffState(property.scope, property.snapshot.version, caseId); await fence()
      const nonce = randomBytes(24).toString('base64'); consentPageHeaders(res, nonce)
      res.status(200).send(renderMaintenanceConsentPage({ principal, scope: property.responseScope, caseId, nonce,
        formToken: mintConsentForm(principal, property.responseScope, caseId, new Date(), runtime.sessionSecret) }, client.script)); return
    }
    if (headers['x-atrium-user-id'] !== principal.userId || headers['x-atrium-session-id'] !== principal.sessionId) throw new ConsentError('consent_changed')
    if (req.method === 'GET') {
      if (query.format !== 'json') return consentInvalid()
      if (query.resource === 'state') {
        consentKeys(query, ['format','resource','caseId'])
        const state = await repository.staffState(property.scope, property.snapshot.version, caseId)
        await send({ action: 'state', state }, state.purposes.map(value => value.effectiveness.refreshAt)); return
      }
      if (query.resource === 'history') {
        consentKeys(query, ['format','resource','caseId','requestId'], ['limit','beforeId','beforeCreatedAt'])
        await send({ action: 'history', history: await repository.staffHistory(property.scope, property.snapshot.version, caseId, consentId(query.requestId), consentListQuery(query)) }); return
      }
      if (query.resource === 'receipt') {
        consentKeys(query, ['format','resource','caseId','commandId'])
        await send({ action: 'receipt', receipt: await repository.staffReceipt(property.scope, property.snapshot.version, caseId, consentId(query.commandId)) }); return
      }
      return consentInvalid()
    }
    consentKeys(query, [])
    if (!isSameOriginJsonRequest(headers) || headers.origin !== runtime.authenticationOrigin
      || !verifyConsentForm(headers['x-atrium-consent-form'], principal, property.responseScope, caseId, new Date(), runtime.sessionSecret)) throw new ConsentError('consent_forbidden')
    if (!body || typeof body.action !== 'string' || headers['x-atrium-consent-action'] !== body.action) return consentInvalid()
    if (body.action === 'publish_request' && body.caseId !== caseId) throw new ConsentError('consent_changed')
    const receipt = await service.executeStaff(principal, property.scope, property.snapshot.version, caseId, body)
    await send({ action: body.action, receipt })
  } catch (error) { consentFailure(res, error) }
}
