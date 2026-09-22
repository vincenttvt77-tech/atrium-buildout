import { randomBytes } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, runtimeForRequest } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { assertManagedSession } from '../src/auth/session-management.ts'
import { propertyTransaction } from '../src/database/scope.ts'
import { EnrollmentError } from '../src/residents/enrollment-model.ts'
import { enrollmentId, parseEnrollmentStaffCommand } from '../src/residents/enrollment-validation.ts'
import { mintEnrollmentStaffForm, verifyEnrollmentStaffForm } from '../src/residents/enrollment-tokens.ts'
import { enrollmentHeaders, enrollmentPageHeaders, enrollmentQuery, enrollmentKeys, enrollmentBody,
  enrollmentInvalid, enrollmentServices, enrollmentFailure } from '../src/residents/enrollment-http.ts'
import { renderResidentAccessPage } from '../src/residents/access-page.ts'
import client from '../src/residents/access-client.bundle.json' with { type: 'json' }

/** Scoped staff enrollment administration. This endpoint never signs in as a resident. */
export default async function handler(req: any, res: any) {
  enrollmentHeaders(req, res)
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ code: 'enrollment_not_enabled', error: 'Resident access requires a managed property workspace.' }); return }
    if (!['GET','POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only.' }); return }
    const query = enrollmentQuery(req.query), headers = req.headers ?? {}, runtime = runtimeForRequest(req)
    const principal = await runtime.authenticate(headers, new Date())
    const html = req.method === 'GET' && query.format === undefined
    if (!principal) {
      if (html) { res.setHeader('location', '/api/dashboard?reauthenticate=1'); res.status(303).send(''); return }
      throw new EnrollmentError('enrollment_unauthenticated')
    }
    assertManagedSession(principal)
    if (html) enrollmentKeys(query, ['organizationId','propertyId','residentId'])
    const property = html ? await runtime.loadUserProperty(principal, { organizationId: query.organizationId, propertyId: query.propertyId }, 'configure')
      : await resolveOpsRuntime(req, 'configure')
    if (property.scope.actor.kind !== 'user' || property.scope.actor.userId !== principal.userId || property.scope.actor.sessionId !== principal.sessionId) {
      throw new EnrollmentError('enrollment_changed')
    }
    const residentId = enrollmentId(req.method === 'POST' ? headers['x-atrium-resident-id'] : query.residentId)
    const { repository, service } = enrollmentServices(runtime)
    const fence = async () => {
      await property.revalidate()
      await propertyTransaction(runtime.app, property.scope, 'configure', async () => {}, property.snapshot.version)
    }
    const send = async (body: Record<string, unknown>) => {
      await fence()
      res.status(200).json({ ...body, userId: principal.userId, sessionId: principal.sessionId, residentId, scope: property.responseScope })
    }
    if (html) {
      // Validate the selected record before rendering a property-bound form.
      await repository.staffState(property.scope, property.snapshot.version, residentId); await fence()
      const nonce = randomBytes(24).toString('base64')
      enrollmentPageHeaders(res, nonce)
      res.status(200).send(renderResidentAccessPage({ principal, scope: property.responseScope, residentId, nonce,
        formToken: mintEnrollmentStaffForm(principal, property.responseScope, residentId, new Date(), runtime.sessionSecret) }, client.script)); return
    }
    if (headers['x-atrium-user-id'] !== principal.userId || headers['x-atrium-session-id'] !== principal.sessionId) throw new EnrollmentError('enrollment_changed')
    if (req.method === 'GET') {
      if (query.format !== 'json') return enrollmentInvalid()
      if (query.resource === 'state') {
        enrollmentKeys(query, ['format','resource','residentId'])
        await send({ action: 'state', state: await repository.staffState(property.scope, property.snapshot.version, residentId),
          formToken: mintEnrollmentStaffForm(principal, property.responseScope, residentId, new Date(), runtime.sessionSecret) }); return
      }
      if (query.resource === 'receipt') {
        enrollmentKeys(query, ['format','resource','residentId','requestId'])
        const receipt = await repository.staffReceipt(property.scope, property.snapshot.version, enrollmentId(query.requestId))
        if (receipt && receipt.residentId !== null && receipt.residentId !== residentId) throw new EnrollmentError('enrollment_forbidden')
        await send({ action: 'receipt', receipt }); return
      }
      return enrollmentInvalid()
    }
    enrollmentKeys(query, [])
    if (!isSameOriginJsonRequest(headers) || headers.origin !== runtime.authenticationOrigin
      || !verifyEnrollmentStaffForm(headers['x-atrium-enrollment-form'], principal, property.responseScope, residentId, new Date(), runtime.sessionSecret)) {
      throw new EnrollmentError('enrollment_forbidden')
    }
    const command = parseEnrollmentStaffCommand(enrollmentBody(req.body))
    if (headers['x-atrium-enrollment-action'] !== command.action) return enrollmentInvalid()
    if (command.action === 'issue_invitation' && command.residentId !== residentId) throw new EnrollmentError('enrollment_changed')
    if (command.action === 'revoke_binding' || command.action === 'revoke_invitation') {
      const state = await repository.staffState(property.scope, property.snapshot.version, residentId)
      const selected = command.action === 'revoke_binding' ? state.binding : state.invitation
      if (!selected || selected.id !== command.id) throw new EnrollmentError('enrollment_changed')
    }
    const result = await service.executeStaff(principal, property.scope, property.snapshot.version, command)
    await send({ action: command.action, receipt: result.receipt,
      ...(result.invitationToken ? { invitationUrl: `${runtime.authenticationOrigin}/api/resident#invite=${result.invitationToken}` } : {}) })
  } catch (error) { enrollmentFailure(res, error) }
}
