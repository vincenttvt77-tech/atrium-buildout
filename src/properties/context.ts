import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuthorizedScope } from '../auth/index.ts'
import type { PropertySnapshot } from './model.ts'
import { assertPropertySnapshot } from './snapshot.ts'

export interface PropertyContext {
  readonly scope: AuthorizedScope
  readonly snapshot: PropertySnapshot
}

const context = new AsyncLocalStorage<PropertyContext>()

/** Optional only for deliberate legacy/fixture adapter selection, never a default property. */
export function propertyContext(): PropertyContext | undefined { return context.getStore() }

export function currentProperty(): PropertyContext {
  const value = propertyContext()
  if (!value) throw new Error('An authorized property context is required.')
  return value
}

/** Scope and snapshot must both originate from their validated server-owned boundaries. */
export function withProperty<T>(scope: AuthorizedScope, snapshot: PropertySnapshot, fn: () => T): T {
  assertPropertySnapshot(snapshot, scope)
  return context.run(Object.freeze({ scope, snapshot }), fn)
}
