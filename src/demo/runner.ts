import { runWorkflowOnce } from '../workflows/worker.ts'
import type { WorkflowConnector, WorkflowRepository } from '../workflows/model.ts'

/**
 * Turns the crank on the durable workflow queue.
 *
 * The engine deliberately does one thing per call and never loops: a worker that decides
 * for itself how long to keep hammering a failing system does it out of sight. Something
 * still has to call it, and nothing in the codebase ever has, which is why the work queue
 * screen shows rows that never move.
 *
 * This is that caller, and it stays bounded for the same reason the engine is: it runs at
 * most `maxSteps` actions and stops the moment the queue reports nothing due. A run that
 * hits its bound is reported as such rather than quietly continuing, so the caller can
 * decide whether to turn the crank again.
 */

export interface QueueRunOptions {
  repository: WorkflowRepository
  connectors: ReadonlyMap<string, WorkflowConnector>
  workerId: string
  /** A bound, not a target. One press of a button should not be able to run forever. */
  maxSteps?: number
  leaseMs?: number
  timeoutMs?: number
  now?: () => Date
}

export interface QueueStep {
  readonly status: 'idle' | 'stale' | 'held' | 'settled'
  readonly actionId?: string
  readonly state?: string
  readonly code?: string
}

export interface QueueRunSummary {
  readonly steps: QueueStep[]
  /** True when the queue reported nothing left to do, rather than the bound being reached. */
  readonly drained: boolean
  readonly settled: number
}

const MAX_STEPS = 25

export async function runQueue(options: QueueRunOptions): Promise<QueueRunSummary> {
  const limit = Math.max(1, Math.min(options.maxSteps ?? MAX_STEPS, MAX_STEPS))
  const steps: QueueStep[] = []
  let drained = false

  for (let i = 0; i < limit; i += 1) {
    const result = await runWorkflowOnce({
      repository: options.repository,
      connectors: options.connectors,
      workerId: options.workerId,
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    if (result.status === 'idle') { drained = true; break }
    steps.push({
      status: result.status,
      actionId: result.actionId,
      ...('state' in result ? { state: result.state } : {}),
      ...('code' in result && result.code !== undefined ? { code: result.code } : {}),
    })
  }

  return { steps, drained, settled: steps.filter(step => step.status === 'settled').length }
}
