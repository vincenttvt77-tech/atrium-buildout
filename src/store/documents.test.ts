import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore, KvDocumentStore } from './documents.ts'
import { KvCalendarStore } from '../calendar/store.ts'
import { storeBackedCalendar } from '../calendar/port.ts'
import { propertyId } from '../domain/ids.ts'

/** Models Redis's atomic EVAL, while independent HTTP reads can race. */
function redis() {
  const data = new Map<string, string>()
  const commands: string[][] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    assert.equal(init?.method, 'POST', 'caller data belongs in the body, never the URL')
    const cmd = JSON.parse(String(init?.body)) as string[]
    commands.push(cmd)
    let result: unknown = null
    const [op, key] = cmd
    if (op === 'GET') result = data.get(key!) ?? null
    else if (op === 'SET') { data.set(key!, cmd[2]!); result = 'OK' }
    else if (op === 'EVAL') {
      const [, , , key, exists, before, next] = cmd
      const match = exists === 'missing' ? !data.has(key!) : data.get(key!) === before
      if (match) data.set(key!, next!)
      result = match ? 1 : 0
    }
    return new Response(JSON.stringify({ result }))
  }
  return { data, commands, fetchImpl }
}

test('simultaneous memory updates retain every change', async () => {
  const store = new MemoryDocumentStore()
  await Promise.all(Array.from({ length: 25 }, () => store.update('counter', 0, (n) => n + 1)))
  assert.equal(await store.get('counter'), 25)
})

test('independent KV clients retain concurrent document updates', async () => {
  const server = redis()
  const a = new KvDocumentStore('https://kv.test', 'test', server)
  const b = new KvDocumentStore('https://kv.test', 'test', server)
  await Promise.all([a.update('lead', [] as string[], (x) => [...x, 'first']), b.update('lead', [] as string[], (x) => [...x, 'second'])])
  assert.deepEqual((await a.get<string[]>('lead'))?.sort(), ['first', 'second'])
})

test('concurrent calendar blocks both survive', async () => {
  const server = redis()
  const a = new KvCalendarStore('https://kv.test', 'test', server)
  const b = new KvCalendarStore('https://kv.test', 'test', server)
  await Promise.all([a, b].map((store, i) => store.mutate((s) => ({ ...s, blocks: [...s.blocks, { target: `2026-09-${10 + i}`, reason: 'held', blockedAt: '' }] }))))
  assert.equal((await a.read()).blocks.length, 2)
})

test('KV service errors cannot erase existing data or offer an empty calendar', async () => {
  const commands: string[][] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    commands.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ error: 'ERR unavailable' }))
  }
  const docs = new KvDocumentStore('https://kv.test', 'test', { fetchImpl })
  await assert.rejects(docs.update<Record<string, unknown>>('lead', {}, () => ({ changed: true })), /KV command failed/)
  assert.equal(docs.describe().durable, false)
  const store = new KvCalendarStore('https://kv.test', 'test', { fetchImpl })
  const calendar = storeBackedCalendar(store, () => new Date('2026-09-09T14:00:00Z'))
  await assert.rejects(calendar.listSlots(propertyId('p'), new Date(), new Date()), /KV command failed/)
  assert.ok(commands.every((c) => c[0] === 'GET'), 'a failed read must never be followed by a write')
})

test('corrupt JSON is not replaced with an empty document', async () => {
  const server = redis()
  server.data.set('atrium:lead', '{invalid')
  const store = new KvDocumentStore('https://kv.test', 'test', server)
  await assert.rejects(store.update('lead', {}, () => ({})))
  assert.equal(server.data.get('atrium:lead'), '{invalid')
  assert.equal(store.describe().durable, false)
})
