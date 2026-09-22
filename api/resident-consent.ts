import { randomBytes } from 'node:crypto'
import { isPostgresRuntime, runtimeForRequest } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { assertManagedSession } from '../src/auth/session-management.ts'
import { ConsentError } from '../src/residents/consent-model.ts'
import { consentHeaders, consentPageHeaders, consentQuery, consentKeys, consentBody, consentId,
  consentInvalid, consentListQuery, consentServices, consentFailure } from '../src/residents/consent-http.ts'
import { mintConsentForm, verifyConsentForm } from '../src/residents/consent-tokens.ts'
import { assertConsentFreshness } from '../src/residents/consent-freshness.ts'
import { renderResidentConsentPage } from '../src/residents/consent-page.ts'
import client from '../src/residents/consent-client.bundle.json' with { type: 'json' }

/** Resident self only. Property or staff headers never select consent authority. */
export default async function handler(req: any, res: any) {
  consentHeaders(req, res)
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ code: 'consent_not_enabled', error: 'Resident decisions require a managed property workspace.' }); return }
    if (!['GET','POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only.' }); return }
    const query = consentQuery(req.query), headers = req.headers ?? {}, runtime = runtimeForRequest(req)
    const principal = await runtime.authenticateResident(headers, new Date()), html = req.method === 'GET' && query.format === undefined
    if (!principal) {
      if (html) { res.setHeader('location', '/api/resident?reauthenticate=1'); res.status(303).send(''); return }
      throw new ConsentError('consent_unauthenticated')
    }
    assertManagedSession(principal)
    if (principal.audience !== 'resident') throw new ConsentError('consent_forbidden')
    const identity = { audience: 'resident', userId: principal.userId, sessionId: principal.sessionId }
    const fence = async (mfa = true) => {
      const current = await runtime.authenticateResident(headers, new Date())
      if (!current || current.userId !== principal.userId || current.sessionId !== principal.sessionId
        || current.credentialVersion !== principal.credentialVersion) throw new ConsentError('consent_changed')
      if (mfa) await runtime.mfa.requireLogin(current)
    }
    if (html) {
      consentKeys(query, [], ['requestId'])
      const requestId = query.requestId === undefined ? null : consentId(query.requestId)
      await fence(false)
      const nonce = randomBytes(24).toString('base64'); consentPageHeaders(res, nonce)
      res.status(200).send(renderResidentConsentPage({ principal, requestId, nonce,
        formToken: mintConsentForm(principal, null, null, new Date(), runtime.sessionSecret) }, client.script)); return
    }
    if (headers['x-atrium-user-id'] !== principal.userId || headers['x-atrium-session-id'] !== principal.sessionId) throw new ConsentError('consent_changed')
    await runtime.mfa.requireLogin(principal)
    const { repository, service } = consentServices(runtime)
    const send = async (body: Record<string, unknown>, deadlines: Array<string | number | null> = []) => {
      await fence()
      assertConsentFreshness(deadlines)
      res.status(200).json({ ...body, ...identity, formToken: mintConsentForm(principal, null, null, new Date(), runtime.sessionSecret) })
    }
    if (req.method === 'GET') {
      if (query.format !== 'json') return consentInvalid()
      if (query.resource === 'list') {
        consentKeys(query, ['format','resource'], ['limit','beforeId','beforeCreatedAt'])
        const page = await repository.listOwn(principal, consentListQuery(query))
        await send({ action: 'list', page }, [page.refreshAt]); return
      }
      if (query.resource === 'detail') {
        consentKeys(query, ['format','resource','requestId'])
        const detail = await repository.getOwn(principal, consentId(query.requestId))
        await send({ action: 'detail', detail }, detail ? [detail.effectiveness.refreshAt] : []); return
      }
      if (query.resource === 'history') {
        consentKeys(query, ['format','resource','requestId'], ['limit','beforeId','beforeCreatedAt'])
        await send({ action: 'history', history: await repository.ownHistory(principal, consentId(query.requestId), consentListQuery(query)) }); return
      }
      if (query.resource === 'receipt') {
        consentKeys(query, ['format','resource','commandId'])
        await send({ action: 'receipt', receipt: await repository.ownReceipt(principal, consentId(query.commandId)) }); return
      }
      return consentInvalid()
    }
    consentKeys(query, [])
    if (!isSameOriginJsonRequest(headers) || headers.origin !== runtime.authenticationOrigin
      || !verifyConsentForm(headers['x-atrium-consent-form'], principal, null, null, new Date(), runtime.sessionSecret)) throw new ConsentError('consent_forbidden')
    const body = consentBody(req.body), action = body.action
    if (typeof action !== 'string' || headers['x-atrium-consent-action'] !== action) return consentInvalid()
    if (action === 'grant_options') {
      consentKeys(body, ['action','command'])
      const result = await service.beginGrant(principal, body.command)
      await send({ action, ...result }, [result.expiresAt]); return
    }
    if (action === 'grant_finish') {
      consentKeys(body, ['action','challengeId','response'])
      const receipt = await service.finishGrant(principal, { challengeId: consentId(body.challengeId), response: body.response })
      await send({ action, receipt }); return
    }
    if (action === 'decline' || action === 'revoke') {
      const receipt = await service.decideOwn(principal, body)
      await send({ action, receipt }); return
    }
    return consentInvalid()
  } catch (error) { consentFailure(res, error) }
}
