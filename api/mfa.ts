import { randomBytes } from 'node:crypto'
import { isPostgresRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest, mintAccountFormToken, verifyAccountFormToken } from '../src/auth/account-request.ts'
import { publicMfaState } from '../src/auth/mfa.ts'
import { renderMfaPage } from '../src/auth/mfa-page.ts'
import client from '../src/auth/mfa-client.bundle.json' with { type: 'json' }
import { MfaError } from '../src/auth/mfa-model.ts'

const actions: Record<string, string> = {
  password: 'password',
  'registration-options': 'label,reauthenticationId,recoveryGrantId',
  'authentication-options': 'factorId,purpose',
  'registration-finish': 'challengeId,response',
  'authentication-finish': 'challengeId,response',
  'remove-factor': 'expectedSecurityVersion,factorId,reauthenticationId,requestId',
  'rotate-recovery': 'expectedSecurityVersion,reauthenticationId,requestId',
  recover: 'code,expectedSecurityVersion,reauthenticationId,requestId',
}
/** Own-account security only; no property, target user or role can be supplied. */
export default async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ error: 'Passkeys are not enabled in this workspace.' }); return }
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only' }); return }
    const runtime = runtimeForRequest(req), headers = req.headers ?? {}, now = new Date()
    const principal = await runtime.authenticate(headers, now)
    if (!principal) {
      if (req.method === 'GET') { res.setHeader('location', '/api/dashboard?reauthenticate=1'); res.status(303).send(''); return }
      throw new MfaError('unauthenticated')
    }
    if (req.method === 'GET') {
      const nonce = randomBytes(24).toString('base64')
      const state = publicMfaState(await runtime.mfa.state(principal))
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('content-security-policy', `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`)
      res.setHeader('permissions-policy', 'publickey-credentials-create=(self), publickey-credentials-get=(self)')
      res.status(200).send(renderMfaPage({ principal, state, nonce,
        formToken: mintAccountFormToken(principal, now, runtime.sessionSecret) }, client.script)); return
    }
    if (!isSameOriginJsonRequest(headers) || headers.origin !== runtime.authenticationOrigin
      || !verifyAccountFormToken(headers['x-atrium-csrf'], principal, now, runtime.sessionSecret)) {
      res.status(403).json({ code: 'invalid_account_form', error: 'Reload the security page before continuing.' }); return
    }
    if (headers['x-atrium-user-id'] !== principal.userId || headers['x-atrium-session-id'] !== principal.sessionId) {
      res.status(409).json({ code: 'account_changed', error: 'The signed-in account changed. Reload before continuing.' }); return
    }
    let body: unknown
    try {
      const serialized = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      if (!serialized || Buffer.byteLength(serialized) > 65536) throw new Error()
      body = JSON.parse(serialized)
    } catch { throw new MfaError('invalid_input') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MfaError('invalid_input')
    const fields = body as Record<string, unknown>, action = fields.action
    if (typeof action !== 'string' || !Object.hasOwn(actions, action)
      || headers['x-atrium-account-action'] !== action
      || Object.keys(fields).filter(key => key !== 'action').sort().join(',') !== actions[action]) throw new MfaError('invalid_input')
    let result: Record<string, unknown>
    switch (action) {
      case 'password': {
        const receipt = await runtime.mfa.password(principal, fields.password)
        result = { reauthenticationId: receipt.id, expiresAt: receipt.expiresAt }; break
      }
      case 'registration-options':
        result = await runtime.mfa.registrationOptions(principal, { label: fields.label, reauthenticationId: fields.reauthenticationId, recoveryGrantId: fields.recoveryGrantId }); break
      case 'authentication-options':
        result = await runtime.mfa.authenticationOptions(principal, { purpose: fields.purpose, factorId: fields.factorId }); break
      case 'registration-finish': case 'authentication-finish':
        result = { receipt: await runtime.mfa.finish(principal, { kind: action === 'registration-finish' ? 'registration' : 'authentication',
          challengeId: fields.challengeId, response: fields.response }) }; break
      case 'remove-factor':
        await runtime.mfa.removeFactor(principal, { factorId: fields.factorId, requestId: fields.requestId,
          expectedSecurityVersion: fields.expectedSecurityVersion, reauthenticationId: fields.reauthenticationId })
        result = { factorId: fields.factorId, requestId: fields.requestId }; break
      case 'rotate-recovery':
        result = await runtime.mfa.rotateRecovery(principal, { requestId: fields.requestId,
          expectedSecurityVersion: fields.expectedSecurityVersion, reauthenticationId: fields.reauthenticationId }); break
      case 'recover': {
        const grant = await runtime.mfa.recover(principal, { code: fields.code, requestId: fields.requestId,
          expectedSecurityVersion: fields.expectedSecurityVersion, reauthenticationId: fields.reauthenticationId })
        result = { recoveryGrantId: grant.id, requestId: fields.requestId, expiresAt: grant.expiresAt }; break
      }
      default: throw new MfaError('invalid_input')
    }
    res.status(200).json({ ok: true, userId: principal.userId, sessionId: principal.sessionId, action,
      state: publicMfaState(await runtime.mfa.state(principal)), ...result })
  } catch (error) {
    if (error instanceof MfaError && error.retryAfterSeconds) res.setHeader('retry-after', String(error.retryAfterSeconds))
    const failure = readRuntimeError(error)
    res.status(failure.status).json(failure.body)
  }
}
