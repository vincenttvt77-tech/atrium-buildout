import { randomUUID, timingSafeEqual } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { PostgresWorkflowRepository } from '../src/database/workflows.ts'
import { WorkflowError } from '../src/workflows/model.ts'
import { workflowSummary } from '../src/workflows/presentation.ts'
import { createEmailReconciliationService, EMAIL_RECONCILER, emailVerificationCommand } from '../src/email/reconciliation.ts'
import { ResendTransport } from '../src/email/render.ts'

export function createEmailReconciliationHandler(options: { now?: () => Date; provider?: { configured: boolean; transport: () => ResendTransport } } = {}) {
  return async function handler(req: any, res: any) {
    req.atriumRequestId = randomUUID()
    res.setHeader('x-request-id', req.atriumRequestId)
    res.setHeader('cache-control', 'no-store, private')
    res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    try {
      if (!isPostgresRuntime()) { res.status(404).json({ code: 'email_reconciliation_disabled', error: 'Delivery checks require a managed workspace.' }); return }
      if (!['GET','POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only' }); return }
      if (req.method === 'GET') {
        // Authenticate before creating the runtime, database access or tenant lookup.
        const secret = process.env.CRON_SECRET
        if (!secret || secret.length < 32 || secret.length > 256 || !/^[\x21-\x7e]+$/.test(secret)) {
          res.status(503).json({ code: 'email_runner_unconfigured', error: 'The delivery worker is not configured.' }); return
        }
        const supplied = req.headers?.authorization, expected = `Bearer ${secret}`
        if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
          res.status(401).json({ code: 'unauthorized', error: 'Worker authentication required.' }); return
        }
        if (!req.query || Object.keys(req.query).join(',') !== 'runnerId' || typeof req.query.runnerId !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(req.query.runnerId)) {
          res.status(400).json({ error: 'Choose a registered property worker.' }); return
        }
      } else if (!isSameOriginJsonRequest(req.headers ?? {}) || Object.keys(req.query ?? {}).length) {
        res.status(403).json({ error: 'Reload the work queue before checking delivery.' }); return
      }
      const runtime = runtimeForRequest(req)
      const property = req.method === 'GET'
        ? await runtime.loadChannel(EMAIL_RECONCILER, req.query.runnerId, req.atriumRequestId)
        : await resolveOpsRuntime(req, 'operate')
      if (req.method === 'POST' && property.scope.actor.kind !== 'user') { res.status(403).json({ error: 'Staff sign-in required.' }); return }
      const repository = new PostgresWorkflowRepository(runtime.app, property.scope, { requestId: property.requestId, configurationVersion: property.snapshot.version })
      const provider = options.provider ?? { configured: !!process.env.RESEND_API_KEY?.trim(), transport: () => new ResendTransport(process.env.RESEND_API_KEY ?? '') }
      const service = createEmailReconciliationService(property, repository, provider, options.now)
      let result
      if (req.method === 'GET') result = await service.runDue()
      else {
        let body = req.body
        if (typeof body === 'string') {
          if (Buffer.byteLength(body) > 2048) body = null
          else try { body = JSON.parse(body) } catch { body = null }
        }
        const command = emailVerificationCommand(body)
        const action = await service.verify(command.actionId, command.expectedRevision)
        result = { action: workflowSummary(action, property.scope.permissions.includes('configure'), true), verificationOnly: true }
      }
      await property.revalidate()
      res.status(200).json({ ...result, scope: property.responseScope })
    } catch (error) {
      if (error instanceof WorkflowError) {
        const statuses: Record<string, number> = { workflow_invalid_input: 400, workflow_not_found: 404, workflow_revision_conflict: 409,
          email_verification_refused: 409, email_reconciliation_disabled: 403, email_not_configured: 503, email_binding_unavailable: 409 }
        if (statuses[error.code]) { res.status(statuses[error.code]).json({ code: error.code, error: error.message }); return }
      }
      const failure = readRuntimeError(error); res.status(failure.status).json(failure.body)
    }
  }
}
export default createEmailReconciliationHandler()
