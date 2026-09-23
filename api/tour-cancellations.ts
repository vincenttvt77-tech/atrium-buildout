import { randomUUID } from 'node:crypto'
import { isPostgresRuntime, resolveOpsRuntime, readRuntimeError } from '../src/application/runtime.ts'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { CalendarActionError } from '../src/calendar/unit-blocks.ts'
import { createTourCancellationService } from '../src/calendar/tour-cancellations.ts'

export default async function handler(req: any, res: any) {
  req.atriumRequestId = randomUUID()
  res.setHeader('x-request-id', req.atriumRequestId)
  res.setHeader('cache-control', 'no-store, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ error: 'Tour cancellation requires a managed property workspace.' }); return }
    if (!['GET','POST'].includes(req.method)) { res.setHeader('allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST only' }); return }
    const property = await resolveOpsRuntime(req, 'operate'), service = createTourCancellationService(property)
    let result
    if (req.method === 'GET') {
      const q = req.query ?? {}
      if (Object.keys(q).join(',') !== 'externalId' || typeof q.externalId !== 'string') {
        res.status(400).json({ error: 'Choose a saved reservation.' }); return
      }
      result = { current: await service.read(q.externalId) }
    } else {
      if (!isSameOriginJsonRequest(req.headers ?? {})) { res.status(403).json({ error: 'Reload the cancellation form before saving.' }); return }
      let body = req.body
      if (typeof body === 'string') {
        if (Buffer.byteLength(body) > 4096) body = null
        else try { body = JSON.parse(body) } catch { body = null }
      }
      result = await service.cancel(body)
    }
    await property.revalidate()
    res.status(200).json({ ...result, scope: property.responseScope })
  } catch (error) {
    if (error instanceof CalendarActionError) { res.status(error.status).json({ code: error.code, error: error.message }); return }
    const failure = readRuntimeError(error); res.status(failure.status).json(failure.body)
  }
}
