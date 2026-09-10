import { randomBytes } from 'node:crypto'
import { runtimeForRequest, isPostgresRuntime, readRuntimeError } from '../src/application/runtime.ts'
import { clearedSessionCookie, isSecureRequest } from '../src/ops/session.ts'
import { mintAccountFormToken, verifyAccountFormToken, isSameOriginAccountRequest } from '../src/auth/account-request.ts'
import { accountSecurityPage } from '../src/auth/account-page.ts'
import { SessionManagementError } from '../src/auth/session-management.ts'
import { PasswordChangeError } from '../src/auth/password-change.ts'

/** Personal identity endpoint. No property selection and no browser-selected target user. */
export default async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ error: 'Personal account settings are not enabled in this workspace.' }); return }
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only' }); return }
    const headers = req.headers ?? {}, runtime = runtimeForRequest(req), now = new Date()
    const principal = await runtime.authenticate(headers, now)
    if (!principal) {
      if (req.method === 'GET') { res.setHeader('location', '/api/dashboard?reauthenticate=1'); res.status(303).send(''); return }
      res.status(401).json({ code: 'unauthenticated', error: 'Sign in again before managing account security.' }); return
    }
    if (req.method === 'GET') {
      const nonce = randomBytes(24).toString('base64')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('content-security-policy', `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`)
      res.status(200).send(accountSecurityPage(principal, mintAccountFormToken(principal, now, runtime.sessionSecret), nonce, await runtime.sessions.list(principal))); return
    }
    if (!isSameOriginAccountRequest(headers)
      || !verifyAccountFormToken(headers['x-atrium-csrf'], principal, now, runtime.sessionSecret)) {
      res.status(403).json({ code: 'invalid_account_form', error: 'Reload your account security page before trying again.' }); return
    }
    if (headers['x-atrium-user-id'] !== principal.userId || headers['x-atrium-session-id'] !== principal.sessionId) {
      res.status(409).json({ code: 'account_changed', error: 'The signed-in account changed. Sign in again before continuing.' }); return
    }
    let body: unknown = req.body
    if (typeof body === 'string') { if (body.length > 4096) body = null; else { try { body = JSON.parse(body) } catch { body = null } } }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) {
      res.status(400).json({ code: 'invalid_password', error: 'Enter your current and new passwords.' }); return
    }
    const fields = body as Record<string, unknown>
    if (fields.action !== headers['x-atrium-account-action']) {
      res.status(400).json({ code: 'invalid_session', error: 'Reload account security before trying again.' }); return
    }
    if (fields.action === 'revoke-session' || fields.action === 'revoke-other-sessions') {
      const keys = Object.keys(fields).sort().join(',')
      if (fields.action === 'revoke-session' ? keys !== 'action,sessionId' || typeof fields.sessionId !== 'string' : keys !== 'action') {
        res.status(400).json({ code: 'invalid_session', error: 'Choose a session from this account security page.' }); return
      }
      const result = await runtime.sessions.revoke(principal, fields.action === 'revoke-session' ? fields.sessionId as string : 'others')
      if (result.currentRevoked) res.setHeader('set-cookie', clearedSessionCookie({ secure: isSecureRequest(headers) }))
      res.status(200).json({ status: 'sessions_revoked', userId: principal.userId, actingSessionId: principal.sessionId,
        revokedIds: result.revokedIds, currentRevoked: result.currentRevoked }); return
    }
    if (Object.keys(fields).sort().join(',') !== 'action,currentPassword,newPassword'
      || fields.action !== 'change-password' || typeof fields.currentPassword !== 'string' || typeof fields.newPassword !== 'string') {
      res.status(400).json({ code: 'invalid_password', error: 'Enter your current and new passwords.' }); return
    }
    await runtime.mfa.requireLogin(principal)
    await runtime.passwordChanges.changeOwnPassword(principal, { currentPassword: fields.currentPassword, newPassword: fields.newPassword })
    res.setHeader('set-cookie', clearedSessionCookie({ secure: isSecureRequest(headers) }))
    res.status(200).json({ status: 'password_changed', userId: principal.userId })
  } catch (error) {
    if (error instanceof SessionManagementError) {
      res.status(error.status).json({ code: error.code, error: error.message }); return
    }
    if (error instanceof PasswordChangeError) {
      if (error.retryAfterSeconds) res.setHeader('retry-after', String(error.retryAfterSeconds))
      res.status(error.status).json({ code: error.code, error: error.message }); return
    }
    const failure = readRuntimeError(error)
    res.status(failure.status).json(failure.body)
  }
}
