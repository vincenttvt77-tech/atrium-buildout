import { AsyncLocalStorage } from 'node:async_hooks'
import { withProperty } from '../properties/context.ts'
import type { ResolvedPropertyRuntime } from '../application/runtime.ts'

const context = new AsyncLocalStorage<ResolvedPropertyRuntime>()
export function currentPropertyRuntime(): ResolvedPropertyRuntime | undefined { return context.getStore() }
export function requirePropertyRuntime(): ResolvedPropertyRuntime {
  const value = currentPropertyRuntime()
  if (!value) throw new Error('An authorized database property request is required.')
  return value
}
export function runWithPropertyRuntime<T>(runtime: ResolvedPropertyRuntime, fn: () => T): T {
  return withProperty(runtime.scope, runtime.snapshot, () => context.run(runtime, fn))
}
