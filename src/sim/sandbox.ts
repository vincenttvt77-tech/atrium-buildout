import { Worker } from 'node:worker_threads'
import { simulationEnvironment } from './isolation.ts'
import type { CalendarState } from '../calendar/types.ts'
import type { Webhook } from './types.ts'

export interface SimulationSnapshot {
  tenantId: string
  documents: Record<string, unknown>
  calendar: CalendarState
  events: Array<Record<string, unknown>>
  storage: { kind: 'memory'; durable: false; note: string }
  networkAttempts: number
}

export interface SimulationSandbox {
  tenantId: string
  webhook: Webhook
  inspect(): Promise<SimulationSnapshot>
  close(): Promise<void>
}

/** One scenario/session per worker. No live handler or operational configuration in the parent. */
export async function createSimulationSandbox(): Promise<SimulationSandbox> {
  const worker = new Worker(new URL('./sandbox-worker.ts', import.meta.url), {
    env: simulationEnvironment(), execArgv: ['--experimental-strip-types'], stdout: true, stderr: true,
  })
  worker.stdout.resume()
  worker.stderr.resume()
  let closed = false
  let sequence = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>()
  const stop = (message: string) => {
    closed = true
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error(message)) }
    pending.clear()
    void worker.terminate()
  }
  const awaitMessage = (id: number): Promise<any> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => stop('SIMULATION_WORKER_TIMEOUT'), 30_000)
    pending.set(id, { resolve, reject, timeout })
  })
  const ready = awaitMessage(0)
  worker.on('message', message => {
    const id = message.ready ? 0 : message.id
    const item = pending.get(id)
    if (!item) return
    clearTimeout(item.timeout)
    pending.delete(id)
    if (message.error) item.reject(new Error(String(message.error)))
    else item.resolve(message.ready ? message.tenantId : message.result)
  })
  worker.on('error', () => stop('SIMULATION_WORKER_FAILED'))
  worker.on('exit', () => { if (!closed) stop('SIMULATION_WORKER_EXITED') })
  const tenantId = await ready as string
  const request = async (operation: string, body?: unknown) => {
    if (closed) throw new Error('SIMULATION_WORKER_CLOSED')
    const id = ++sequence
    const response = awaitMessage(id)
    worker.postMessage({ id, operation, body })
    return response
  }
  return {
    tenantId,
    webhook: async (req, res) => {
      if (req.method !== 'POST') throw new Error('SIMULATION_POST_ONLY')
      const result = await request('post', req.body)
      res.status(result.status)
      res.json(result.body)
    },
    inspect: () => request('inspect') as Promise<SimulationSnapshot>,
    close: async () => { if (!closed) { stop('SIMULATION_WORKER_CLOSED'); await worker.terminate() } },
  }
}
