import { randomUUID } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { PostgresWorkflowRepository } from '../src/database/workflows.ts'
import { CalendarActionError } from '../src/calendar/unit-blocks.ts'
import { createCancellationEmailService } from '../src/email/tour-cancellation.ts'
import { ResendTransport } from '../src/email/render.ts'

export function createCancellationEmailsHandler(options: { now?: () => Date; provider?: { configured: boolean; transport: () => ResendTransport } } = {}) {
  return async function handler(req: any, res: any) {
    req.atriumRequestId = randomUUID()
    res.setHeader('x-request-id', req.atriumRequestId)
    res.setHeader('cache-control', 'no-store, private')
    res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    try {
      if (!isPostgresRuntime()) { res.status(404).json({ code: 'cancellation_email_not_enabled', error: 'Cancellation email requires a managed property workspace.' }); return }
      if (!['GET','POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only' }); return }
      const property = await resolveOpsRuntime(req, 'operate')
      if (property.scope.actor.kind !== 'user') { res.status(403).json({ error: 'Staff sign-in required.' }); return }
      const runtime = runtimeForRequest(req)
      const repository = new PostgresWorkflowRepository(runtime.app, property.scope, { requestId: property.requestId, configurationVersion: property.snapshot.version })
      const provider = options.provider ?? { configured: !!process.env.RESEND_API_KEY?.trim(), transport: () => new ResendTransport(process.env.RESEND_API_KEY ?? '') }
      const service = createCancellationEmailService(property, repository, provider, options.now)
      let result
      if (req.method === 'GET') {
        if (!req.query || Object.keys(req.query).sort().join(',') !== 'externalId' || typeof req.query.externalId !== 'string') {
          res.status(400).json({ error: 'Choose a cancelled tour.' }); return
        }
        result = await service.preview(req.query.externalId)
      } else {
        if (!isSameOriginJsonRequest(req.headers ?? {}) || Object.keys(req.query ?? {}).length) { res.status(403).json({ error: 'Reload the cancellation email form before continuing.' }); return }
        let body = req.body
        if (typeof body === 'string') {
          if (Buffer.byteLength(body) > 4096) body = null
          else try { body = JSON.parse(body) } catch { body = null }
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { res.status(400).json({ error: 'Use the cancellation email form.' }); return }
        if (body.action === 'queue') result = { confirmation: await service.queue(body) }
        else if (body.action === 'process' && Object.keys(body).sort().join(',') === 'action,confirmationId') result = { confirmation: await service.process(body.confirmationId) }
        else { res.status(400).json({ error: 'Choose a cancellation email action.' }); return }
      }
      await property.revalidate()
      res.status(200).json({ ...result, scope: property.responseScope })
    } catch (error) {
      if (error instanceof CalendarActionError) { res.status(error.status).json({ code: error.code, error: error.message }); return }
      const failure = readRuntimeError(error); res.status(failure.status).json(failure.body)
    }
  }
}
export default createCancellationEmailsHandler()
