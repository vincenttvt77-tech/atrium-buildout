import { randomBytes } from 'node:crypto'
import { isPostgresRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { AdministrationError } from '../src/auth/administration.ts'
import { createOrganizationManagementService, mintOrganizationFormToken, verifyOrganizationFormToken,
  parseMemberReplacement } from '../src/auth/organization-management.ts'
import { PostgresOrganizationAdministrationRepository } from '../src/database/organization-administration.ts'
import { renderOrganizationPage } from '../src/auth/organization-page.ts'
import client from '../src/auth/organization-client.bundle.json' with { type: 'json' }
import { validId } from '../src/auth/validation.ts'

/** Existing-member administration; published property configuration is deliberately not required. */
export default async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  const query = req.query ?? {}, wantsJson = query.format === 'json'
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ code: 'administration_not_enabled', error: 'Team management is not enabled in this workspace.' }); return }
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only' }); return }
    if (Object.keys(query).some(key => !['format', 'organizationId', 'limit', 'beforeMembershipId'].includes(key))
      || Object.values(query).some(value => typeof value !== 'string')
      || (req.method === 'POST' && Object.keys(query).length > 0)
      || (req.method === 'GET' && Object.keys(query).length > 0 && !wantsJson)) throw new AdministrationError('invalid_input')
    const headers = req.headers ?? {}, runtime = runtimeForRequest(req), now = new Date()
    const principal = await runtime.authenticate(headers, now)
    if (!principal) {
      if (req.method === 'GET' && !wantsJson) { res.setHeader('location', '/api/dashboard?reauthenticate=1'); res.status(303).send(''); return }
      throw new AdministrationError('unauthenticated')
    }
    const service = createOrganizationManagementService(new PostgresOrganizationAdministrationRepository(runtime.app),
      runtime.mfa.administrationAuthentication(principal))
    if (req.method === 'GET' && !wantsJson) {
      const organizations = await service.listOrganizations(principal), nonce = randomBytes(24).toString('base64')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('content-security-policy', `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`)
      res.status(200).send(renderOrganizationPage({ principal, organizations, nonce,
        formToken: mintOrganizationFormToken(principal, now, runtime.sessionSecret) }, client.script)); return
    }
    if (headers['x-atrium-user-id'] !== principal.userId || headers['x-atrium-session-id'] !== principal.sessionId) {
      res.status(409).json({ code: 'account_changed', error: 'The signed-in account changed. Reload Team before continuing.' }); return
    }
    if (req.method === 'GET') {
      if (!validId(query.organizationId) || (query.limit !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(query.limit))
        || (query.beforeMembershipId !== undefined && !validId(query.beforeMembershipId))) throw new AdministrationError('invalid_input')
      const directory = await service.directory(principal, query.organizationId,
        { limit: query.limit === undefined ? 50 : Number(query.limit), ...(query.beforeMembershipId === undefined ? {} : { beforeMembershipId: query.beforeMembershipId }) })
      res.status(200).json({ action: 'directory', userId: principal.userId, sessionId: principal.sessionId,
        organizationId: query.organizationId, formToken: mintOrganizationFormToken(principal, now, runtime.sessionSecret, query.organizationId), directory }); return
    }
    if (!isSameOriginJsonRequest(headers) || headers.origin !== runtime.authenticationOrigin) {
      res.status(403).json({ code: 'invalid_organization_form', error: 'Reload Team before trying again.' }); return
    }
    let body: unknown
    try {
      const serialized = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      if (!serialized || Buffer.byteLength(serialized) > 150_000 || Buffer.isBuffer(req.body)) throw new Error()
      body = JSON.parse(serialized)
    } catch { throw new AdministrationError('invalid_input') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AdministrationError('invalid_input')
    const { action, ...manifest } = body as Record<string, unknown>
    if (action !== 'replace_member' || headers['x-atrium-organization-action'] !== action) throw new AdministrationError('invalid_input')
    const input = parseMemberReplacement(manifest)
    if (!verifyOrganizationFormToken(headers['x-atrium-csrf'], principal, now, runtime.sessionSecret, input.organizationId)) {
      res.status(403).json({ code: 'invalid_organization_form', error: 'Reload this organization’s Team page before trying again.' }); return
    }
    const receipt = await service.replaceMember(principal, input)
    res.status(200).json({ action, userId: principal.userId, sessionId: principal.sessionId, organizationId: input.organizationId, receipt })
  } catch (error) {
    if (error instanceof AdministrationError) {
      if (error.code === 'mfa_required' && req.method === 'GET' && !wantsJson) {
        res.setHeader('location', '/api/mfa'); res.status(303).send(''); return
      }
      res.status(error.status).json({ code: error.code, error: error.message }); return
    }
    const failure = readRuntimeError(error)
    res.status(failure.status).json(failure.body)
  }
}
