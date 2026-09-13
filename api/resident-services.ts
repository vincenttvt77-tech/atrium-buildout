import { randomUUID } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { AuthorizationError } from '../src/auth/index.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { ServiceError } from '../src/maintenance/model.ts'
import type { ServiceListQuery, ServiceState } from '../src/maintenance/model.ts'
import { parseServiceCommand, validateServiceListQuery } from '../src/maintenance/validation.ts'
import { recordId } from '../src/residents/validation.ts'
import { mintServiceFormToken, verifyServiceFormToken } from '../src/maintenance/request.ts'
import { PostgresResidentServicesRepository } from '../src/database/resident-services.ts'
import { propertyTransaction } from '../src/database/scope.ts'
import { safetyInstruction } from '../src/escalation/emergency.ts'

const invalid = (): never => { throw new ServiceError('service_invalid_input', 'Reload Service and choose a valid request.') }
const filters: Record<string, ServiceState[]> = {
  attention: ['needs_triage', 'management_review', 'emergency_review'],
  waiting: ['waiting_information'], planning: ['ready_for_planning'],
  all: ['needs_triage', 'waiting_information', 'management_review', 'ready_for_planning', 'emergency_review'],
}
function query(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const value = input as Record<string, unknown>
  if (typeof value.resource !== 'string') return invalid()
  const resource = value.resource
  if (!['overview', 'residents', 'resident', 'requests', 'request', 'events'].includes(resource)) return invalid()
  const list = ['residents', 'requests', 'events'].includes(resource)
  const allowed = ['resource', ...(['resident', 'request', 'events'].includes(resource) ? ['id'] : []),
    ...(list ? ['limit', 'beforeCreatedAt', 'beforeId'] : []),
    ...(['residents', 'requests'].includes(resource) ? ['unitId'] : []),
    ...(resource === 'residents' ? ['status'] : []), ...(resource === 'requests' ? ['state'] : [])]
  if (Object.keys(value).some(key => !allowed.includes(key)) || Object.values(value).some(item => typeof item !== 'string')) return invalid()
  if (['resident', 'request', 'events'].includes(resource) && !recordId(value.id)) return invalid()
  const parsed: ServiceListQuery & { status?: 'active' | 'revoked'; states?: ServiceState[]; includeContextReview?: boolean } = { limit: 25 }
  if (list) {
    const limit = value.limit ?? '25'
    if (typeof limit !== 'string' || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50) return invalid()
    parsed.limit = Number(limit)
    if (value.beforeCreatedAt !== undefined || value.beforeId !== undefined) parsed.before = { createdAt: value.beforeCreatedAt as string, id: value.beforeId as string }
    if (value.unitId !== undefined) parsed.unitId = value.unitId as string
    if (resource === 'residents' && value.status !== undefined && value.status !== 'all') {
      if (value.status !== 'active' && value.status !== 'revoked') return invalid()
      parsed.status = value.status
    }
    if (resource === 'requests') {
      const selected = value.state ?? 'attention'
      if (typeof selected !== 'string' || !Object.hasOwn(filters, selected)) return invalid()
      parsed.states = filters[selected]!
      if (selected === 'attention') parsed.includeContextReview = true
    }
    validateServiceListQuery(parsed, resource === 'residents' ? 'residents' : resource === 'events' ? 'events' : 'cases')
  }
  return { resource, id: value.id as string, page: parsed }
}
function page<T extends { createdAt: string; id: string }>(rows: T[], limit: number) {
  const visible = rows.slice(0, limit), last = visible.at(-1)
  return { visible, nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null }
}

/** Staff operations only. No caller verification, entry permission or dispatch is minted here. */
export default async function handler(req: any, res: any) {
  const requestId = randomUUID()
  req.atriumRequestId = requestId
  res.setHeader('x-request-id', requestId)
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ code: 'service_not_enabled', error: 'Service requires a managed property workspace.' }); return }
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ code: 'method_not_allowed', error: 'GET or POST only.' }); return }
    const property = await resolveOpsRuntime(req, 'operate')
    if (property.scope.actor.kind !== 'user' || !property.scope.actor.sessionId) throw new AuthorizationError('unauthenticated')
    const runtime = runtimeForRequest(req)
    const principal = await runtime.authenticate(req.headers ?? {}, new Date())
    if (!principal || principal.userId !== property.scope.actor.userId || principal.sessionId !== property.scope.actor.sessionId) throw new AuthorizationError('unauthenticated')
    const repository = new PostgresResidentServicesRepository(runtime.app, property.scope, { configurationVersion: property.snapshot.version })
    const send = async (body: Record<string, unknown>) => {
      await property.revalidate()
      await propertyTransaction(runtime.app, property.scope, 'operate', async () => {}, property.snapshot.version)
      res.status(200).json({ ...body, scope: property.responseScope })
    }
    if (req.method === 'GET') {
      const selected = query(req.query ?? {})
      if (selected.resource === 'overview') {
        await send({ canManageResidents: property.scope.permissions.includes('configure'), timeZone: property.snapshot.timeZone,
          units: property.snapshot.inventory.units.map(unit => ({ id: String(unit.unitId), label: String(unit.unitId) })),
          formToken: mintServiceFormToken(principal, property.responseScope, new Date(), runtime.sessionSecret) })
        return
      }
      if (selected.resource === 'residents') {
        const result = page(await repository.listResidents({ ...selected.page, limit: selected.page.limit + 1 }), selected.page.limit)
        await send({ residents: result.visible, nextCursor: result.nextCursor }); return
      }
      if (selected.resource === 'resident') {
        const resident = await repository.getResident(selected.id)
        if (!resident) throw new ServiceError('service_not_found', 'The resident record is not available in this property.')
        await send({ resident }); return
      }
      if (selected.resource === 'requests') {
        const result = page(await repository.listCases({ ...selected.page, limit: selected.page.limit + 1 }), selected.page.limit)
        const requests = result.visible.map(row => ({ id: row.id, version: row.version, location: row.location, summary: row.summary,
          category: row.category, state: row.state, priority: row.priority, createdAt: row.createdAt, updatedAt: row.updatedAt,
          residentId: row.residentId, requestOrigin: row.requestOrigin, contextNeedsReview: row.contextNeedsReview }))
        await send({ requests, nextCursor: result.nextCursor }); return
      }
      if (selected.resource === 'events') {
        const result = page(await repository.listEvents(selected.id, { limit: selected.page.limit + 1, ...(selected.page.before ? { before: selected.page.before } : {}) }), selected.page.limit)
        await send({ events: result.visible, nextCursor: result.nextCursor }); return
      }
      const detail = await repository.getCase(selected.id)
      if (!detail) throw new ServiceError('service_not_found', 'The request is not available in this property.')
      const lifeKinds = ['gas', 'smoke_or_fire', 'carbon_monoxide', 'injury', 'intruder']
      await send({ detail, safetyInstructions: detail.request.emergencyKinds.map(kind => safetyInstruction({ kind, matched: '', callEmergencyServices: lifeKinds.includes(kind) })),
        safetyCallEmergencyServices: detail.request.emergencyKinds.some(kind => lifeKinds.includes(kind)) }); return
    }
    if (!isSameOriginJsonRequest(req.headers ?? {}) || req.headers.origin !== runtime.authenticationOrigin
      || !verifyServiceFormToken(req.headers['x-atrium-service-form'], principal, property.responseScope, new Date(), runtime.sessionSecret)) {
      res.status(403).json({ code: 'invalid_service_form', error: 'Reload Service before saving this change.' }); return
    }
    let body: unknown = req.body
    if (typeof body === 'string') {
      if (Buffer.byteLength(body, 'utf8') > 24 * 1024) return invalid()
      try { body = JSON.parse(body) } catch { return invalid() }
    } else if (Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8') > 24 * 1024) return invalid()
    const command = parseServiceCommand(body)
    if (req.headers['x-atrium-service-action'] !== command.action) {
      res.status(403).json({ code: 'invalid_service_form', error: 'Reload Service before saving this change.' }); return
    }
    const receipt = await repository.execute(command)
    await send({ receipt })
  } catch (error) {
    if (error instanceof ServiceError) {
      res.status(error.code === 'service_invalid_input' ? 400 : error.code === 'service_not_found' ? 404 : error.code === 'service_unavailable' ? 503 : 409)
        .json({ code: error.code, error: error.message }); return
    }
    const failure = readRuntimeError(error)
    res.status(failure.status).json(failure.body)
  }
}
