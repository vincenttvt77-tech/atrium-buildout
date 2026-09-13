import { randomUUID } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { AuthorizationError } from '../src/auth/index.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { MaintenancePlanningError } from '../src/maintenance/planning-model.ts'
import { parsePlanningCommand } from '../src/maintenance/planning-validation.ts'
import { mintPlanningFormToken, verifyPlanningFormToken } from '../src/maintenance/planning-request.ts'
import { validateMaintenanceInboxQuery } from '../src/maintenance/planning-inbox.ts'
import { expiredPlanningScan, mintPlanningInboxCursor, planningScanLifetimeMs, readPlanningInboxCursor } from '../src/maintenance/planning-inbox-cursor.ts'
import { validateServiceListQuery } from '../src/maintenance/validation.ts'
import { recordId } from '../src/residents/validation.ts'
import { PostgresMaintenancePlanningRepository } from '../src/database/maintenance-planning.ts'
import { propertyTransaction } from '../src/database/scope.ts'
import { safetyInstruction } from '../src/escalation/emergency.ts'

const invalid = (): never => { throw new MaintenancePlanningError('planning_invalid_input', 'Reload the maintenance workspace and review the requested operation.') }
function query(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const v = input as Record<string, unknown>
  if (!['overview', 'vendors', 'vendor', 'plan', 'history', 'inbox'].includes(v.resource as string)
    || Object.values(v).some(value => typeof value !== 'string')) return invalid()
  if (v.resource === 'inbox') {
    if (Object.keys(v).some(key => !['resource', 'filter', 'limit', 'unitId', 'cursor'].includes(key))
      || v.limit !== undefined && !/^[1-9]\d?$/.test(v.limit as string)
      || v.cursor !== undefined && (!(v.cursor as string).length || (v.cursor as string).length > 800)) return invalid()
    const inbox = validateMaintenanceInboxQuery({ limit: v.limit === undefined ? 25 : Number(v.limit), filter: v.filter ?? 'attention',
      ...(v.unitId !== undefined ? { unitId: v.unitId } : {}) })
    return { resource: 'inbox', id: '', caseId: '', page: { limit: inbox.limit }, inbox, cursor: v.cursor as string | undefined }
  }
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
  return { resource, id: v.id as string, caseId: v.caseId as string, page, inbox: undefined, cursor: undefined }
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
    const send = async (body: Record<string, unknown>, deadline?: number) => {
      await property.revalidate()
      await propertyTransaction(runtime.app, property.scope, 'operate', async () => {}, property.snapshot.version)
      if (deadline !== undefined && Date.now() >= deadline) return expiredPlanningScan()
      res.status(200).json({ ...body, scope: property.responseScope })
    }
    if (req.method === 'GET') {
      const selected = query(req.query ?? {})
      if (selected.resource === 'inbox') {
        const inbox = selected.inbox
        if (!inbox) return invalid()
        const started = Date.now(), prior = selected.cursor === undefined ? null : readPlanningInboxCursor(selected.cursor,
          principal, property.responseScope, inbox, new Date(started), runtime.sessionSecret)
        const result = await repository.listInbox({ ...inbox, ...(prior ? { before: prior.before } : {}) })
        if (prior && prior.policyVersion !== result.policyVersion) return expiredPlanningScan()
        const now = new Date(), evaluatedAt = Date.parse(result.evaluatedAt)
        if (!Number.isFinite(evaluatedAt)) throw new MaintenancePlanningError('planning_unavailable', 'The planning evaluation time could not be verified.')
        const boundaries = [result.policyValidUntil, result.refreshAt].filter((value): value is string => value !== null).map(value => Date.parse(value))
        if (boundaries.some(value => !Number.isFinite(value))) throw new MaintenancePlanningError('planning_unavailable', 'The planning evidence deadline could not be verified.')
        const scan = { startedAt: prior?.startedAt ?? started, policyVersion: result.policyVersion,
          expiresAt: Math.min(prior?.expiresAt ?? started + planningScanLifetimeMs,
            principal.sessionExpiresAt ?? Infinity,
            ...boundaries.filter(value => value > evaluatedAt)) }
        if (now.getTime() >= scan.expiresAt) return expiredPlanningScan()
        const { nextCursor, policyVersion: _policyVersion, policyValidUntil: _policyValidUntil, refreshAt: _refreshAt, ...visible } = result
        await send({ ...visible, nextCursor: nextCursor ? mintPlanningInboxCursor(nextCursor, scan, principal,
          property.responseScope, inbox, now, runtime.sessionSecret) : null,
        scanStartedAt: new Date(scan.startedAt).toISOString(), scanExpiresAt: new Date(scan.expiresAt).toISOString() }, scan.expiresAt); return
      }
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
