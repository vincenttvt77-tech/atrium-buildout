import { parentPort } from 'node:worker_threads'
import { randomBytes, randomUUID } from 'node:crypto'
import { assertSimulationEnvironment, denyOperationalNetwork } from './isolation.ts'

if (!parentPort) throw new Error('Simulation worker requires a parent')
const port = parentPort
assertSimulationEnvironment(process.env)
const network = denyOperationalNetwork()

// All operational configuration is created here, before importing application handlers.
const tenantId = `sim-${randomUUID()}`
const assistantId = `${tenantId}-assistant`
const webhookSecret = randomBytes(32).toString('base64url')
const { hashPassword } = await import('../ops/accounts.ts')
const account = { username: tenantId, tenantId, displayName: 'Isolated simulation', assistantIds: [assistantId],
  passwordHash: await hashPassword(randomBytes(32).toString('base64url')) }
process.env.OPS_ACCOUNTS_JSON = JSON.stringify([account])
process.env.OPS_SESSION_SECRET = randomBytes(48).toString('base64url')
process.env.VAPI_WEBHOOK_SECRET = webhookSecret
const safeEnvironment = { ...process.env }

const [{ default: handler }, { documentStoreFromEnv }, { calendarStoreFromEnv }, { withTenant }, session] = await Promise.all([
  import('../../api/vapi.ts'), import('../store/documents.ts'), import('../calendar/store.ts'),
  import('../tenancy/context.ts'), import('../ops/session.ts'),
])
const documents = documentStoreFromEnv()
const calendar = calendarStoreFromEnv()

function assertIsolated() {
  if (Object.keys(process.env).length !== Object.keys(safeEnvironment).length ||
      Object.entries(process.env).some(([key, value]) => safeEnvironment[key] !== value) ||
      documents.describe().kind !== 'memory' || calendar.describe().kind !== 'memory') {
    throw new Error('SIMULATION_ISOLATION_CHANGED')
  }
}

async function invoke(method: string, headers: Record<string, string>, body?: unknown) {
  const result = { status: 0, body: null as any }
  const res = { setHeader() { return res }, status(value: number) { result.status = value; return res },
    json(value: unknown) { result.body = value; return res } }
  await handler({ method, headers, body }, res)
  return result
}

async function execute(message: { operation: string; body?: unknown }) {
  return withTenant(tenantId, async () => {
    assertIsolated()
    if (message.operation === 'post') {
      const source = message.body as any
      if (!source?.message || typeof source.message !== 'object' || !source.message.call ||
          typeof source.message.call.id !== 'string' || !source.message.call.id || source.message.call.id.length > 200) {
        throw new Error('SIMULATION_INVALID_MESSAGE')
      }
      // A model, caller or incoming bridge cannot redirect this worker to a real assistant.
      const body = { message: { ...source.message, call: { ...source.message.call, assistantId } } }
      const result = await invoke('POST', { 'content-type': 'application/json', 'x-vapi-secret': webhookSecret }, body)
      assertIsolated()
      if (network.attempts()) throw new Error('SIMULATION_NETWORK_ATTEMPTED')
      return result
    }
    if (message.operation === 'inspect') {
      const cookie = `${session.OPS_COOKIE}=${session.mintAccountSession(new Date(), account)}`
      const history = await invoke('GET', { cookie })
      if (history.status !== 200) throw new Error('SIMULATION_INSPECTION_FAILED')
      const records: Record<string, unknown> = {}
      for (const key of await documents.list('')) records[key] = await documents.get(key)
      assertIsolated()
      if (network.attempts()) throw new Error('SIMULATION_NETWORK_ATTEMPTED')
      return { tenantId, documents: records, calendar: await calendar.read(), events: history.body.events,
        storage: documents.describe(), networkAttempts: network.attempts() }
    }
    throw new Error('SIMULATION_UNKNOWN_OPERATION')
  })
}

// Serialize messages within a call, while separate workers can run concurrently.
let pending = Promise.resolve()
port.on('message', (message: { id: number; operation: string; body?: unknown }) => {
  pending = pending.then(async () => {
    try { port.postMessage({ id: message.id, result: await execute(message) }) }
    catch (error) {
      const code = error instanceof Error && /^SIMULATION_[A-Z_]+$/.test(error.message) ? error.message : 'SIMULATION_HANDLER_FAILED'
      port.postMessage({ id: message.id, error: code })
    }
  })
})
withTenant(tenantId, assertIsolated)
port.postMessage({ ready: true, tenantId })
