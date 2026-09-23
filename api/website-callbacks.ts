import { createHmac, randomUUID } from 'node:crypto'
import { isPostgresRuntime, runtimeForRequest, readRuntimeError } from '../src/application/runtime.ts'
import { requestLoginAddress, networkIdentity } from '../src/auth/login-protection.ts'
import { PostgresWorkflowRepository } from '../src/database/workflows.ts'
import { CALLBACK_CHANNEL, CallbackError, callbackOpen, callbackPolicy, channelId } from '../src/callbacks/config.ts'
import { CallbackChallenge, CallbackTransport } from '../src/callbacks/transport.ts'
import { createCallbackService, validateCallbackRoute } from '../src/callbacks/service.ts'

export function createWebsiteCallbackHandler(options: { now?: () => Date; provider?: { configured: boolean; transport: () => CallbackTransport };
  challenge?: { siteKey: string; verify: CallbackChallenge['verify'] } } = {}) {
  return async function handler(req: any, res: any) {
    req.atriumRequestId = randomUUID()
    res.setHeader('x-request-id', req.atriumRequestId); res.setHeader('cache-control', 'no-store, private')
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-robots-tag', 'noindex, nofollow'); res.setHeader('vary', 'Origin')
    try {
      if (!isPostgresRuntime()) { res.status(404).json({ code: 'callback_unavailable', error: 'Online callbacks are not enabled.' }); return }
      if (!['POST','OPTIONS'].includes(req.method)) { res.setHeader('allow', 'POST, OPTIONS'); res.status(405).json({ error: 'POST only' }); return }
      if (Object.keys(req.query ?? {}).join(',') !== 'widgetId' || !channelId(req.query.widgetId)
        || typeof req.headers?.origin !== 'string') throw new CallbackError('callback_forbidden', 'Use the approved property website.', 403)
      const runtime = runtimeForRequest(req), now = options.now ?? (() => new Date())
      const property = await runtime.loadChannel(CALLBACK_CHANNEL, req.query.widgetId, req.atriumRequestId)
      const repository = new PostgresWorkflowRepository(runtime.app, property.scope, { requestId: property.requestId, configurationVersion: property.snapshot.version })
      const provider = options.provider ?? { configured: !!process.env.VAPI_API_KEY?.trim(), transport: () => new CallbackTransport(process.env.VAPI_API_KEY ?? '') }
      const service = createCallbackService(property, repository, { ...provider, validateRoute: b => validateCallbackRoute(runtime, property, b) }, now), binding = await service.ready()
      if (binding.channelId !== req.query.widgetId || binding.origin !== req.headers.origin) throw new CallbackError('callback_forbidden', 'Use the approved property website.', 403)
      // This is a purpose-limited public command, not a staff session or general
      // channel credential. CORS alone is not authority to place a call.
      res.setHeader('access-control-allow-origin', binding.origin)
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS'); res.setHeader('access-control-allow-headers', 'content-type')
      if (req.method === 'OPTIONS') { res.status(204).end(); return }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new CallbackError('callback_invalid_input', 'Use the callback form.', 400)
      let body = req.body
      if (typeof body === 'string') { if (Buffer.byteLength(body) > 8192) body = null; else try { body = JSON.parse(body) } catch { body = null } }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 8192) throw new CallbackError('callback_invalid_input', 'Use the callback form.', 400)
      const challengeClient = new CallbackChallenge(process.env.CALLBACK_TURNSTILE_SECRET ?? '')
      const challenge = options.challenge ?? { siteKey: process.env.CALLBACK_TURNSTILE_SITE_KEY ?? '',
        verify: challengeClient.verify.bind(challengeClient) }
      if (!challenge.siteKey || (!options.challenge && !process.env.CALLBACK_TURNSTILE_SECRET?.trim())) throw new CallbackError('callback_unavailable', 'Online callbacks are unavailable. Please use the building’s published contact number.', 503)
      const fields = Object.keys(body).sort().join(',')
      let result
      if (body.action === 'bootstrap' && fields === 'action') {
        result = { buildingName: property.snapshot.property.buildingName, ...callbackPolicy(property.snapshot, binding),
          open: callbackOpen(binding, property.snapshot.timeZone, now()), hours: binding.hours, timeZone: property.snapshot.timeZone,
          siteKey: challenge.siteKey, targetSeconds: 15 }
      } else if (body.action === 'status' && fields === 'action,receiptToken,requestId') {
        result = await service.status(body.requestId, body.receiptToken)
      } else if (body.action === 'request' && fields === 'action,challengeToken,request') {
        const address = requestLoginAddress(req)
        if (address === 'unknown' || typeof body.challengeToken !== 'string' || !body.challengeToken || body.challengeToken.length > 2048
          || !await challenge.verify(body.challengeToken, binding.origin, binding.channelId, address, now())) {
          throw new CallbackError('callback_challenge_failed', 'Please complete a new verification before requesting a call.', 403)
        }
        const network = createHmac('sha256', runtime.sessionSecret).update('atrium-callback-network-v1:' + networkIdentity(address)).digest('hex')
        result = await service.request(body.request, network)
      } else throw new CallbackError('callback_invalid_input', 'Use the callback form.', 400)
      await property.revalidate(); res.status(200).json(result)
    } catch (error) {
      if (error instanceof CallbackError) { res.status(error.status).json({ code: error.code, error: error.message }); return }
      const failure = readRuntimeError(error); res.status(failure.status).json(failure.body)
    }
  }
}
export default createWebsiteCallbackHandler()
