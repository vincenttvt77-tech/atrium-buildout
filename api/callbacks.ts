import { randomUUID } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { PostgresWorkflowRepository } from '../src/database/workflows.ts'
import { CallbackError, digest, uuid } from '../src/callbacks/config.ts'
import { CallbackTransport } from '../src/callbacks/transport.ts'
import { createCallbackService, validateCallbackRoute } from '../src/callbacks/service.ts'
import { workflowSummary } from '../src/workflows/presentation.ts'

/** Authenticated inspection only. Staff cannot use this endpoint to dial a number. */
export default async function handler(req: any, res: any) {
  req.atriumRequestId = randomUUID()
  res.setHeader('x-request-id', req.atriumRequestId); res.setHeader('cache-control', 'no-store, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow'); res.setHeader('referrer-policy', 'no-referrer')
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ error: 'Callbacks require a managed workspace.' }); return }
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); res.status(405).json({ error: 'POST only' }); return }
    if (!isSameOriginJsonRequest(req.headers ?? {}) || Object.keys(req.query ?? {}).length) { res.status(403).json({ error: 'Reload the work queue.' }); return }
    const runtime = runtimeForRequest(req), property = await resolveOpsRuntime(req, 'operate')
    if (property.scope.actor.kind !== 'user') { res.status(403).json({ error: 'Staff sign-in required.' }); return }
    let body = req.body
    if (typeof body === 'string') { if (Buffer.byteLength(body) > 2048) body = null; else try { body = JSON.parse(body) } catch { body = null } }
    if (!body || Object.keys(body).sort().join(',') !== 'actionId,expectedRevision' || !uuid(body.actionId) || !digest(body.expectedRevision)) {
      res.status(400).json({ error: 'Choose a callback in the work queue.' }); return
    }
    const repository = new PostgresWorkflowRepository(runtime.app, property.scope, { requestId: property.requestId, configurationVersion: property.snapshot.version })
    const provider = { configured: !!process.env.VAPI_API_KEY?.trim(), transport: () => new CallbackTransport(process.env.VAPI_API_KEY ?? '') }
    const result = await createCallbackService(property, repository, { ...provider, validateRoute: b => validateCallbackRoute(runtime, property, b) }).check(body.actionId, body.expectedRevision)
    await property.revalidate()
    res.status(200).json({ ...result.summary, action: workflowSummary(result.action, property.scope.permissions.includes('configure'), true, { status: result.summary.stage, observedAt: result.summary.observedAt }), scope: property.responseScope })
  } catch (error) {
    if (error instanceof CallbackError) { res.status(error.status).json({ code: error.code, error: error.message }); return }
    const failure = readRuntimeError(error); res.status(failure.status).json(failure.body)
  }
}
