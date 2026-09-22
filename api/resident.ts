import { randomBytes } from 'node:crypto'
import { isPostgresRuntime, runtimeForRequest } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { MfaError } from '../src/auth/mfa-model.ts'
import { handleMfaRequest } from '../src/auth/mfa-http.ts'
import { mintResidentSession, RESIDENT_COOKIE } from '../src/auth/session.ts'
import { requestLoginAddress } from '../src/auth/login-protection.ts'
import { parseCookies } from '../src/ops/session.ts'
import { EnrollmentError } from '../src/residents/enrollment-model.ts'
import { enrollmentId } from '../src/residents/enrollment-validation.ts'
import { enrollmentHeaders, enrollmentPageHeaders, enrollmentQuery, enrollmentKeys, enrollmentBody,
  enrollmentInvalid, enrollmentServices, enrollmentFailure } from '../src/residents/enrollment-http.ts'
import { RESIDENT_BROWSER_COOKIE, RESIDENT_INVITATION_COOKIE, createResidentBrowser, mintResidentBrowser, readResidentBrowser,
  mintResidentForm, verifyResidentForm, hashEnrollmentToken, mintResidentInvitation, readResidentInvitation,
  mintEnrollmentReview, verifyEnrollmentReview, enrollmentPrivateKey, residentCookie } from '../src/residents/enrollment-tokens.ts'
import { renderResidentPortalPage } from '../src/residents/portal-page.ts'
import client from '../src/residents/portal-client.bundle.json' with { type: 'json' }

/** First-party resident audience only; no organization or staff permission is accepted from this browser. */
export default async function handler(req: any, res: any) {
  enrollmentHeaders(req, res)
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ code: 'enrollment_not_enabled', error: 'Resident access requires a managed property workspace.' }); return }
    if (!['GET','POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only.' }); return }
    const query = enrollmentQuery(req.query)
    if (query.resource === 'mfa') { enrollmentKeys(query, ['resource']); await handleMfaRequest(req, res, 'resident'); return }
    const runtime = runtimeForRequest(req), headers = req.headers ?? {}, now = new Date(), secure = runtime.authenticationOrigin.startsWith('https:')
    const principal = await runtime.authenticateResident(headers, now), cookies = parseCookies(headers.cookie)
    let browser = readResidentBrowser(cookies[RESIDENT_BROWSER_COOKIE], now, runtime.sessionSecret)
    if (!browser) {
      if (req.method !== 'GET') throw new EnrollmentError('enrollment_changed')
      browser = createResidentBrowser(now)
      res.setHeader('set-cookie', residentCookie(RESIDENT_BROWSER_COOKIE, mintResidentBrowser(browser, runtime.sessionSecret), secure,
        Math.floor((browser.expiresAt - now.getTime()) / 1000)))
    }
    const identity = { audience: 'resident', userId: principal?.userId ?? null, sessionId: principal?.sessionId ?? null }
    const { repository, service } = enrollmentServices(runtime), address = requestLoginAddress(req)
    const invitation = readResidentInvitation(cookies[RESIDENT_INVITATION_COOKIE], browser, now, runtime.sessionSecret)
    const formToken = mintResidentForm(browser, principal, runtime.sessionSecret)
    const fence = async (requireMfa: boolean) => {
      const current = await runtime.authenticateResident(headers, new Date())
      if ((current?.userId ?? null) !== identity.userId || (current?.sessionId ?? null) !== identity.sessionId
        || (current?.credentialVersion ?? null) !== (principal?.credentialVersion ?? null)) throw new EnrollmentError('enrollment_changed')
      if (principal && requireMfa) await runtime.mfa.requireLogin(principal)
    }
    const send = async (body: Record<string, unknown>, requireMfa = true, cookie?: string) => {
      await fence(requireMfa)
      if (cookie) res.setHeader('set-cookie', cookie)
      res.status(200).json({ ...body, ...identity })
    }
    if (req.method === 'GET') {
      if (query.format === undefined) {
        enrollmentKeys(query, [], ['reauthenticate'])
        if (query.reauthenticate !== undefined && query.reauthenticate !== '1') return enrollmentInvalid()
        const nonce = randomBytes(24).toString('base64'); enrollmentPageHeaders(res, nonce)
        res.status(200).send(renderResidentPortalPage({ principal, nonce, formToken, reauthenticate: query.reauthenticate === '1' }, client.script)); return
      }
      if (query.format !== 'json') return enrollmentInvalid()
      if (query.resource === 'state') {
        enrollmentKeys(query, ['format','resource'])
        let mfaRequired = false
        if (principal) {
          try { await runtime.mfa.requireLogin(principal) }
          catch (error) { if (error instanceof MfaError && error.code === 'mfa_required') mfaRequired = true; else throw error }
        }
        const preview = invitation ? await repository.preview(invitation.tokenHash) : null
        const bindings = principal && !mfaRequired ? await repository.ownBindings(principal, { limit: 25 }) : null
        // When MFA is held, return no bindings or other resident records.
        await send({ username: principal?.username ?? null, displayName: principal?.displayName ?? null, formToken,
          invitation: preview, reviewToken: preview && invitation ? mintEnrollmentReview(preview, invitation, runtime.sessionSecret) : null,
          bindings, mfaRequired }, !mfaRequired); return
      }
      if (!principal) throw new EnrollmentError('enrollment_unauthenticated')
      await runtime.mfa.requireLogin(principal)
      if (query.resource === 'bindings') {
        enrollmentKeys(query, ['format','resource'], ['afterId'])
        await send({ bindings: await repository.ownBindings(principal, { limit: 25,
          ...(query.afterId !== undefined ? { afterId: enrollmentId(query.afterId) } : {}) }) }); return
      }
      if (query.resource === 'receipt') {
        enrollmentKeys(query, ['format','resource','requestId'])
        await send({ receipt: await repository.ownReceipt(principal, enrollmentId(query.requestId)) }); return
      }
      return enrollmentInvalid()
    }
    enrollmentKeys(query, [])
    if (!isSameOriginJsonRequest(headers) || headers.origin !== runtime.authenticationOrigin
      || !verifyResidentForm(headers['x-atrium-resident-form'], browser, principal, now, runtime.sessionSecret)) throw new EnrollmentError('enrollment_forbidden')
    if ((headers['x-atrium-user-id'] ?? null) !== identity.userId || (headers['x-atrium-session-id'] ?? null) !== identity.sessionId) throw new EnrollmentError('enrollment_changed')
    const body = enrollmentBody(req.body), action = body.action
    if (action === 'exchange') {
      enrollmentKeys(body, ['action','token'])
      const tokenHash = hashEnrollmentToken(body.token)
      await runtime.loginProtection.reserve(`enrollment_${tokenHash.slice(0,48)}`, address)
      const preview = await repository.preview(tokenHash)
      if (!preview) throw new EnrollmentError('enrollment_invitation_unavailable')
      const expiresAt = Math.min(browser.expiresAt, Date.parse(preview.expiresAt))
      if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) throw new EnrollmentError('enrollment_invitation_unavailable')
      const cookie = residentCookie(RESIDENT_INVITATION_COOKIE,
        mintResidentInvitation({ tokenHash, browserId: browser.id, expiresAt }, runtime.sessionSecret), secure,
        Math.max(1, Math.floor((expiresAt - now.getTime()) / 1000)))
      await send({ action }, false, cookie); return
    }
    if (action === 'sign_in') {
      enrollmentKeys(body, ['action','username','password'])
      const signedIn = await runtime.signInResident(body.username, body.password, address, headers['user-agent'])
      if (!signedIn) throw new EnrollmentError('enrollment_password_incorrect')
      res.setHeader('set-cookie', residentCookie(RESIDENT_COOKIE, mintResidentSession(signedIn, new Date(), runtime.sessionSecret), secure,
        Math.max(1, Math.floor((signedIn.sessionExpiresAt! - Date.now()) / 1000))))
      res.status(200).json({ action, audience: 'resident', userId: signedIn.userId, sessionId: signedIn.sessionId }); return
    }
    if (action === 'logout') {
      enrollmentKeys(body, ['action'])
      if (principal) await runtime.sessions.revoke(principal, principal.sessionId!)
      res.setHeader('set-cookie', residentCookie(RESIDENT_COOKIE, '', secure, 0))
      res.status(200).json({ action, audience: 'resident', userId: null, sessionId: null }); return
    }
    if (action === 'activate_new' || action === 'activate_existing') {
      enrollmentKeys(body, ['action','requestId','invitationVersion','reviewToken','password', ...(action === 'activate_new' ? ['username','displayName'] : [])])
      if (!invitation) throw new EnrollmentError('enrollment_invitation_unavailable')
      const preview = await repository.preview(invitation.tokenHash)
      if (!preview || !verifyEnrollmentReview(body.reviewToken, preview, invitation, new Date(), runtime.sessionSecret)
        || body.invitationVersion !== preview.invitationVersion) throw new EnrollmentError('enrollment_invitation_unavailable')
      const receipt = await service.accept(principal, { mode: action === 'activate_new' ? 'new' : 'existing', requestId: body.requestId,
        tokenHash: invitation.tokenHash, browserHash: enrollmentPrivateKey('browser', browser.id, runtime.sessionSecret),
        clientKey: enrollmentPrivateKey('client', address, runtime.sessionSecret), clientAddress: address,
        invitationVersion: body.invitationVersion, username: body.username, displayName: body.displayName, password: body.password })
      // Do not mint a session from an invitation or a replayed receipt. Normal sign-in proves account control.
      await send({ action, receipt, signInRequired: true }); return
    }
    return enrollmentInvalid()
  } catch (error) { enrollmentFailure(res, error) }
}
