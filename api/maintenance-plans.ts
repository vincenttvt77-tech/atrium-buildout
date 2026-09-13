import { randomUUID } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { AuthorizationError } from '../src/auth/index.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { MaintenancePlanningError } from '../src/maintenance/planning-model.ts'
import { parsePlanningCommand } from '../src/maintenance/planning-validation.ts'
import { mintPlanningFormToken, verifyPlanningFormToken } from '../src/maintenance/planning-request.ts'
import { validateServiceListQuery } from '../src/maintenance/validation.ts'
import { recordId } from '../src/residents/validation.ts'
import { PostgresMaintenancePlanningRepository } from '../src/database/maintenance-planning.ts'
import { propertyTransaction } from '../src/database/scope.ts'
import { safetyInstruction } from '../src/escalation/emergency.ts'

const invalid = (): never => { throw new MaintenancePlanningError('planning_invalid_input', 'Reload the maintenance workspace and review the requested operation.') }
function query(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const v = input as Record<string, unknown>
  if (!['overview', 'vendors', 'vendor', 'plan', 'history'].includes(v.resource as string)
    || Object.values(v).some(value => typeof value !== 'string')) return invalid()
  const resource = v.resource as string, listing = resource === 'vendors' || resource === 'history'
  const allowed = ['resource', ...(listing ? ['limit', 'beforeCreatedAt', 'beforeId'] : []),
    ...(resource === 'vendors' ? ['status'] : resource === 'vendor' ? ['id'] : ['plan', 'history'].includes(resource) ? ['caseId'] : [])]
  if (Object.keys(v).some(key => !allowed.includes(key)) || (resource === 'vendor' && !recordId(v.id))
    || (['plan', 'history'].includes(resource) && !recordId(v.caseId))) return invalid()
  const page: { limit: number; before?: { createdAt: string; id: string }; status?: 'approved' | 'suspended' } = { limit: 25 }
  if (listing) {
    if (v.limit !== undefined && (!/^[1-9]\d?$/.test(v.limit as string) || Number(v.limit) > 50)) return invalid()
    page.limit = v.limit === undefined ? 25 : Number(v.limit)
    if (v.beforeCreatedAt !== undefined || v.beforeId !== undefined) page.before = { createdAt: v.beforeCreatedAt as string, id: v.beforeId as string }
    try { validateServiceListQuery(page, 'events') } catch { return invalid() }
    if (resource === 'vendors' && v.status !== undefined && v.status !== 'all') {
      if (v.status !== 'approved' && v.status !== 'suspended') return invalid()
      page.status = v.status
    }
  }
  return { resource, id: v.id as string, caseId: v.caseId as string, page }
}
function page<T extends { createdAt: string; id: string }>(rows: T[], limit: number) {
  const visible = rows.slice(0, limit), last = visible.at(-1)
  return { visible, nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null }
}

/** Staff planning and spending review; this handler cannot dispatch or pay anyone. */
export default async function handler(req: any, res: any) {
  const requestId = randomUUID(); req.atriumRequestId = requestId
  res.setHeader('x-request-id', requestId)
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ code: 'planning_not_enabled', error: 'Maintenance planning requires a managed property workspace.' }); return }
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ code: 'method_not_allowed', error: 'GET or POST only.' }); return }
    const property = await resolveOpsRuntime(req, 'operate')
    if (property.scope.actor.kind !== 'user' || !property.scope.actor.sessionId) throw new AuthorizationError('unauthenticated')
    const runtime = runtimeForRequest(req), headers = req.headers ?? {}, principal = await runtime.authenticate(headers, new Date())
    if (!principal || principal.userId !== property.scope.actor.userId || principal.sessionId !== property.scope.actor.sessionId) throw new AuthorizationError('unauthenticated')
    const repository = new PostgresMaintenancePlanningRepository(runtime.app, property.scope, { configurationVersion: property.snapshot.version })
    const send = async (body: Record<string, unknown>) => {
      await property.revalidate()
      await propertyTransaction(runtime.app, property.scope, 'operate', async () => {}, property.snapshot.version)
      res.status(200).json({ ...body, scope: property.responseScope })
    }
    if (req.method === 'GET') {
      const selected = query(req.query ?? {})
      if (selected.resource === 'overview') {
        await send({ ...await repository.overview(), formToken: mintPlanningFormToken(principal, property.responseScope, new Date(), runtime.sessionSecret) }); return
      }
      if (selected.resource === 'vendors') {
        const result = page(await repository.listVendors({ ...selected.page, limit: selected.page.limit + 1 }), selected.page.limit)
        await send({ vendors: result.visible, nextCursor: result.nextCursor }); return
      }
      if (selected.resource === 'vendor') {
        const vendor = await repository.getVendor(selected.id)
        if (!vendor) throw new MaintenancePlanningError('planning_not_found', 'This vendor is not available in the selected property.')
        await send({ vendor }); return
      }
      if (selected.resource === 'history') {
        const result = page(await repository.listPlanHistory(selected.caseId, { ...selected.page, limit: selected.page.limit + 1 }), selected.page.limit)
        await send({ history: result.visible, nextCursor: result.nextCursor }); return
      }
      const detail = await repository.getPlan(selected.caseId)
      if (!detail) throw new MaintenancePlanningError('planning_not_found', 'This request is not available in the selected property.')
      const kinds = [...new Set([...detail.request.emergencyKinds, ...(detail.plan?.emergencyKinds ?? [])])]
      const lifeKinds = ['gas', 'smoke_or_fire', 'carbon_monoxide', 'injury', 'intruder']
      await send({ detail, safetyInstructions: kinds.map(kind => safetyInstruction({ kind, matched: '', callEmergencyServices: lifeKinds.includes(kind) })),
        safetyCallEmergencyServices: kinds.some(kind => lifeKinds.includes(kind)) }); return
    }
    if (Object.keys(req.query ?? {}).length) return invalid()
    if (!isSameOriginJsonRequest(headers) || headers.origin !== runtime.authenticationOrigin
      || !verifyPlanningFormToken(headers['x-atrium-planning-form'], principal, property.responseScope, new Date(), runtime.sessionSecret)) {
      res.status(403).json({ code: 'invalid_planning_form', error: 'Reload the maintenance workspace before saving this change.' }); return
    }
    let body: unknown
    try {
      if (Buffer.isBuffer(req.body)) return invalid()
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      if (!raw || Buffer.byteLength(raw) > 24 * 1024) return invalid()
      body = JSON.parse(raw)
    } catch { return invalid() }
    const command = parsePlanningCommand(body)
    if (headers['x-atrium-planning-action'] !== command.action) return invalid()
    let proofId: string | undefined
    if (['publish_policy', 'save_vendor', 'decide_plan'].includes(command.action)) {
      const auth = runtime.mfa.administrationAuthentication(principal), proof = await auth.verifyCurrentSession(principal)
      const time = Date.now()
      if (!proof || proof.issuer !== auth.issuer || proof.sessionId !== principal.sessionId || proof.subjectId !== principal.userId
        || proof.credentialVersion !== principal.credentialVersion || proof.purpose !== 'organization_administration'
        || proof.method !== 'webauthn' || !recordId(proof.verificationId)
        || !Number.isFinite(Date.parse(proof.verifiedAt)) || Date.parse(proof.verifiedAt) > time
        || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= time
        || Date.parse(proof.expiresAt) - Date.parse(proof.verifiedAt) > 600_000) {
        throw new MaintenancePlanningError('planning_mfa_required', 'Verify your passkey before changing maintenance authority, vendors or approval decisions.')
      }
      proofId = proof.verificationId
    }
    const receipt = await repository.execute(command, proofId)
    await send({ receipt })
  } catch (error) {
    if (error instanceof MaintenancePlanningError) {
      const status = error.code === 'planning_invalid_input' ? 400 : error.code === 'planning_not_found' ? 404
        : error.code === 'planning_mfa_required' ? 403 : error.code === 'planning_unavailable' ? 503 : 409
      res.status(status).json({ code: error.code, error: error.message }); return
    }
    const failure = readRuntimeError(error)
    res.status(failure.status).json(failure.body)
  }
}
