import { randomUUID } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { PostgresWorkflowRepository } from '../src/database/workflows.ts'
import { WorkflowError } from '../src/workflows/model.ts'
import { queueQuery, recoveryCommand, workflowSummary } from '../src/workflows/presentation.ts'

/** Operator inspection and recovery only. This endpoint cannot create work or invoke a connector. */
export default async function handler(req: any, res: any) {
  const requestId = randomUUID()
  req.atriumRequestId = requestId
  res.setHeader('x-request-id', requestId)
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ code: 'workflow_not_enabled', error: 'The work queue requires a managed property workspace.' }); return }
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only' }); return }
    const property = await resolveOpsRuntime(req, req.method === 'GET' ? 'read' : 'configure')
    if (property.scope.actor.kind !== 'user') throw new Error('Managed staff authentication required')
    const runtime = runtimeForRequest(req)
    const repository = new PostgresWorkflowRepository(runtime.app, property.scope, { requestId, configurationVersion: property.snapshot.version })
    const canManage = property.scope.permissions.includes('configure')
    const send = (body: Record<string, unknown>) => res.status(200).json({ ...body, scope: property.responseScope, executionEnabled: false })
    if (req.method === 'GET') {
      const query = queueQuery(req.query ?? {})
      const rows = await repository.list({ ...query, limit: query.limit + 1 })
      const visible = rows.slice(0, query.limit)
      const last = visible.at(-1)
      const actions = visible.map(action => workflowSummary(action, canManage))
      await property.revalidate()
      send({ actions, canManage, nextCursor: rows.length > query.limit && last ? { createdAt: last.createdAt, id: last.id } : null })
      return
    }
    if (!isSameOriginJsonRequest(req.headers ?? {})) {
      res.status(403).json({ code: 'invalid_workflow_form', error: 'Reload the work queue before changing an action.' }); return
    }
    let body: unknown = req.body
    if (typeof body === 'string') {
      if (Buffer.byteLength(body, 'utf8') > 2048) body = null
      else { try { body = JSON.parse(body) } catch { body = null } }
    }
    const command = recoveryCommand(body)
    const action = command.action === 'replay'
      ? await repository.replay(command.id, command.reason, command.expectedRevision)
      : await repository.cancel(command.id, command.reason, command.expectedRevision)
    await property.revalidate()
    send({ action: workflowSummary(action, canManage) })
  } catch (error) {
    if (error instanceof WorkflowError) {
      const known = ['workflow_invalid_input', 'workflow_not_found', 'workflow_replay_refused', 'workflow_cancel_refused', 'workflow_revision_conflict']
      if (known.includes(error.code)) {
        res.status(error.code === 'workflow_invalid_input' ? 400 : error.code === 'workflow_not_found' ? 404 : 409)
          .json({ code: error.code, error: error.message }); return
      }
    }
    const failure = readRuntimeError(error)
    res.status(failure.status).json(failure.body)
  }
}
