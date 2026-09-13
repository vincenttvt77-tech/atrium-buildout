import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { WorkflowError } from './model.ts'
import type { JsonObject, NewWorkflowAction, WorkflowReceiptInput } from './model.ts'

const MAX_BYTES = 1024 * 1024
const MAX_INPUT_BYTES = 128 * 1024
const MAX_DEPTH = 20
const MAX_NODES = 10_000
const MACHINE_ID = /^[a-z][a-z0-9_.:-]{0,63}$/
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/

function invalid(): never {
  throw new WorkflowError('workflow_invalid_input', 'The workflow receipt or JSON value is invalid.')
}

/** PostgreSQL JSONB rejects NUL and Unicode escapes without a valid surrogate pair. */
function supportedString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit === 0) invalid()
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++i)
      if (!(low >= 0xdc00 && low <= 0xdfff)) invalid()
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid()
  }
}

/**
 * Bounded strict JSON, with lexically sorted object keys and original array order.
 * No toJSON hooks, getters, hidden properties, sparse arrays or coercion participate.
 */
export function canonicalJson(value: unknown): string {
  const parts: string[] = []
  const ancestors = new Set<object>()
  let bytes = 0, nodes = 0
  const append = (part: string) => {
    bytes += Buffer.byteLength(part, 'utf8')
    if (bytes > MAX_BYTES) invalid()
    parts.push(part)
  }
  const quote = (text: string) => {
    supportedString(text)
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) invalid()
    append(JSON.stringify(text))
  }
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid()
    if (item === null) { append('null'); return }
    if (typeof item === 'string') { quote(item); return }
    if (typeof item === 'boolean') { append(item ? 'true' : 'false'); return }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid()
      append(JSON.stringify(item)); return
    }
    if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) invalid()
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid()
    const ownKeys = Reflect.ownKeys(item)
    if (ownKeys.length > MAX_NODES + 1 || ownKeys.some(key => typeof key !== 'string')) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(item)
    ancestors.add(item)
    if (array) {
      if (item.length > MAX_NODES || Object.keys(descriptors).length !== item.length + 1) invalid()
      append('[')
      for (let i = 0; i < item.length; i++) {
        const descriptor = descriptors[String(i)]
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        if (i) append(',')
        visit(descriptor.value, depth + 1)
      }
      append(']')
    } else {
      const keys = Object.keys(descriptors).sort()
      append('{')
      for (const [index, key] of keys.entries()) {
        const descriptor = descriptors[key]!
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        if (index) append(',')
        quote(key); append(':'); visit(descriptor.value, depth + 1)
      }
      append('}')
    }
    ancestors.delete(item)
  }
  visit(value, 0)
  return parts.join('')
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid()
}
function machine(value: unknown): string {
  if (typeof value !== 'string' || !MACHINE_ID.test(value)) invalid()
  return value
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || value.trim() !== value || CONTROLS.test(value)) invalid()
  return value
}

// Accidental credential-field guard, not DLP: arbitrary prose/values can contain secrets.
// Connectors must resolve credentials separately; payloads may retain references/versions.
const CREDENTIAL_FIELDS = new Set(['password', 'passwordhash', 'passwd', 'authorization',
  'apikey', 'privatekey', 'secret', 'secretkey', 'clientsecret', 'webhooksecret',
  'token', 'accesstoken', 'refreshtoken', 'bearertoken', 'authtoken', 'credentials', 'credential',
  'secrets', 'cookie', 'setcookie', 'connectionstring', 'databaseurl', 'redisurl', 'dsn'])
const CREDENTIAL_SUFFIX = /(?:password(?:hash)?|passwd|secret|(?:api|private|secret|signing)key|(?:access|refresh|bearer|auth|session)token|authorization(?:header)?)$/
function noCredentials(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const item of value) noCredentials(item); return }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (CREDENTIAL_FIELDS.has(normalized) || CREDENTIAL_SUFFIX.test(normalized)
      || ['__proto__', 'prototype', 'constructor'].includes(key)) invalid()
    noCredentials(item)
  }
}

/** Return detached validated JSON with explicit attempt defaults, or a safe stable error. */
export function validateReceiptInput(input: unknown): WorkflowReceiptInput {
  // Parse our strict canonical encoding, not the caller's original mutable object.
  const detached: unknown = JSON.parse(canonicalJson(input))
  if (!object(detached)) invalid()
  keys(detached, ['source', 'eventId', 'payload', 'actions'])
  const source = machine(detached.source), eventId = identity(detached.eventId)
  if (!object(detached.payload) || !Array.isArray(detached.actions)
    || detached.actions.length < 1 || detached.actions.length > 20) invalid()
  noCredentials(detached.payload)
  const seen = new Set<string>()
  const actions: NewWorkflowAction[] = detached.actions.map(raw => {
    if (!object(raw)) invalid()
    keys(raw, ['kind', 'connector', 'operationKey', 'input'], ['maxAttempts'])
    const kind = machine(raw.kind), connector = machine(raw.connector), operationKey = identity(raw.operationKey)
    if (seen.has(operationKey)) invalid()
    seen.add(operationKey)
    const maxAttempts = raw.maxAttempts ?? 5
    if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10
      || (Object.hasOwn(raw, 'maxAttempts') && raw.maxAttempts === null)) invalid()
    if (!object(raw.input) || Buffer.byteLength(canonicalJson(raw.input), 'utf8') > MAX_INPUT_BYTES) invalid()
    noCredentials(raw.input)
    return { kind, connector, operationKey, input: raw.input as JsonObject, maxAttempts }
  })
  const receipt: WorkflowReceiptInput = { source, eventId, payload: detached.payload as JsonObject, actions }
  // Materialized defaults count toward the persisted receipt's byte/node budget too.
  canonicalJson(receipt)
  return receipt
}
