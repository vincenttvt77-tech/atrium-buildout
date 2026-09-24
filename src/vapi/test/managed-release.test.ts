import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { hashJson } from '../../workflows/validation.ts'
import { demoAssistantConfig } from '../config.ts'
import { createManagedVoiceRelease } from '../managed-release.ts'

function fixture() {
  const store = new MemoryDocumentStore()
  let at = new Date('2026-09-24T23:00:00Z'), authorized = true, ready = true
  let saved: Record<string, any> = { id: 'assistant-a', orgId: 'provider-org', name: 'Synthetic leasing assistant',
    voice: { provider: 'synthetic-voice', voiceId: 'selected-voice' },
    transcriber: { provider: 'synthetic-transcriber', language: 'en' },
    model: { provider: 'custom-llm', url: 'https://synthetic-model.example/v1', model: 'synthetic-model',
      temperature: 0.2, headers: { authorization: 'synthetic-private-marker' } },
    server: { url: 'https://old.example/api/vapi', credentialId: 'old-credential' } }
  const context = { organizationId: 'org-a', propertyId: 'property-a', configurationVersion: 1,
    bindingFingerprint: hashJson('binding-a'), assistantId: 'assistant-a', providerOrganizationId: 'provider-org' }
  const base = demoAssistantConfig({ buildingName: 'Synthetic building', address: '10 Test Street' }, 'https://backend.example', at, { timeZone: 'America/Chicago' })
  const config = { ...base, server: { ...base.server, credentialId: 'synthetic-vault-credential' } }
  const calls: string[] = []
  const provider = {
    async read(assistantId: string) { assert.equal(assistantId, 'assistant-a'); calls.push('GET'); return structuredClone(saved) },
    async patch(assistantId: string, patch: Record<string, unknown>) {
      assert.equal(assistantId, 'assistant-a'); calls.push('PATCH')
      const j = await store.get<any>('voice-release:assistant-a')
      assert.equal(j.releases.filter((r: any) => r.state === 'sending').length, 1, 'admission saved before provider IO')
      saved = { ...saved, ...structuredClone(patch) }
    },
  }
  const options = { store, context, config, actorId: 'owner-a', provider,
    async authorize() { if (!authorized) throw new Error('forbidden') },
    async backendReady() { return ready }, clock: () => at }
  return { store, provider, options, calls, service: createManagedVoiceRelease(options),
    get saved() { return saved }, set saved(v) { saved = v },
    revoke() { authorized = false }, mismatch() { ready = false }, advance(ms: number) { at = new Date(at.getTime() + ms) } }
}

test('review and exact publish preserve custom model/voice and expose no provider secrets', async () => {
  const f = fixture(), before = structuredClone(f.saved)
  const prepared = await f.service.prepare('review-1')
  assert.equal(prepared.release.state, 'prepared'); assert.deepEqual(f.calls, ['GET'])
  assert.match(prepared.proposal!.prompt[0]!.content, /America\/Chicago/)
  assert.doesNotMatch(JSON.stringify(prepared), /synthetic-private-marker|old-credential/)
  const published = await f.service.publish('review-1', prepared.release.reviewHash)
  assert.equal(published.release.state, 'verified'); assert.equal(published.release.check, 'matches')
  assert.deepEqual(f.calls, ['GET', 'GET', 'PATCH', 'GET'])
  assert.deepEqual(f.saved.voice, before.voice); assert.deepEqual(f.saved.transcriber, before.transcriber)
  for (const key of ['provider', 'url', 'model', 'headers', 'temperature']) assert.deepEqual(f.saved.model[key], before.model[key])
  assert.equal(f.saved.model.tools.length, 9)
  for (const tool of f.saved.model.tools) assert.equal(tool.server.credentialId, 'synthetic-vault-credential')
  assert.doesNotMatch(JSON.stringify(await f.store.get('voice-release:assistant-a')), /synthetic-private-marker|https:\/\/synthetic-model/)
  await f.service.publish('review-1', prepared.release.reviewHash)
  assert.equal(f.calls.filter(c => c === 'PATCH').length, 1)
})

test('simultaneous publish commands produce one provider write', async () => {
  const f = fixture(), p = await f.service.prepare('review-1')
  const results = await Promise.all([f.service.publish('review-1', p.release.reviewHash), f.service.publish('review-1', p.release.reviewHash)])
  assert.equal(f.calls.filter(c => c === 'PATCH').length, 1)
  assert.ok(results.every(r => ['sending', 'verified'].includes(r.release.state)))
})

test('lost PATCH reply is recovered by GET and never resubmitted', async () => {
  const f = fixture(), write = f.provider.patch
  f.provider.patch = async (id, patch) => { await write(id, patch); throw new Error('synthetic lost reply') }
  const p = await f.service.prepare('review-1'), result = await f.service.publish('review-1', p.release.reviewHash)
  assert.equal(result.release.state, 'verified'); assert.equal(f.calls.filter(c => c === 'PATCH').length, 1)
})

test('unavailable readback survives restart; later exact verification sends nothing', async () => {
  const f = fixture(), read = f.provider.read, write = f.provider.patch
  f.provider.patch = async (id, patch) => { await write(id, patch); f.provider.read = async () => { throw new Error('sensitive provider outage') } }
  const p = await f.service.prepare('review-1'), result = await f.service.publish('review-1', p.release.reviewHash)
  assert.equal(result.release.state, 'sending'); assert.equal(result.release.check, 'unavailable')
  assert.doesNotMatch(JSON.stringify(result), /sensitive provider outage/)
  const restarted = createManagedVoiceRelease(f.options)
  await assert.rejects(restarted.prepare('review-2'), /earlier update is unconfirmed/)
  assert.equal((await restarted.publish('review-1', p.release.reviewHash)).release.state, 'sending')
  f.provider.read = read
  assert.equal((await restarted.verify('review-1')).release.state, 'verified')
  assert.equal(f.calls.filter(c => c === 'PATCH').length, 1)
})

test('mismatched readback never confirms, cancels or dispatches a replacement', async () => {
  const f = fixture(), write = f.provider.patch
  f.provider.patch = async (id, patch) => { await write(id, patch); f.saved.model.tools[0].server.url = 'https://foreign.example/api/vapi' }
  const p = await f.service.prepare('review-1'), result = await f.service.publish('review-1', p.release.reviewHash)
  assert.equal(result.release.state, 'sending'); assert.equal(result.release.check, 'differs')
  await assert.rejects(f.service.cancel('review-1', p.release.reviewHash), /may already have reached/)
  await assert.rejects(f.service.prepare('review-2'), /unconfirmed/)
  assert.equal(f.calls.filter(c => c === 'PATCH').length, 1)
})

test('provider drift, expired review, changed binding/configuration and revoked authority refuse before write', async () => {
  for (const fault of ['provider', 'expires', 'binding', 'configuration', 'authority', 'backend', 'review']) {
    const f = fixture(), p = await f.service.prepare('review-1')
    if (fault === 'provider') f.saved.model.model = 'changed-model'
    if (fault === 'expires') f.advance(15 * 60_000)
    if (fault === 'authority') f.revoke()
    if (fault === 'backend') f.mismatch()
    if (fault === 'binding') f.options.context.bindingFingerprint = hashJson('changed-binding')
    if (fault === 'configuration') f.options.context.configurationVersion++
    const service = createManagedVoiceRelease(f.options)
    await assert.rejects(service.publish('review-1', fault === 'review' ? hashJson('wrong') : p.release.reviewHash), /changed|forbidden|does not match/, fault)
    assert.equal(f.calls.filter(c => c === 'PATCH').length, 0, fault)
  }
})

test('wrong provider assistant/account and conflicting credentials cannot produce a plan', async () => {
  for (const fault of ['assistant', 'account', 'credentials', 'masked']) {
    const f = fixture()
    if (fault === 'assistant') f.saved.id = 'foreign-assistant'
    if (fault === 'account') f.saved.orgId = 'foreign-provider-org'
    if (fault === 'credentials') f.saved.server.headers = { Authorization: 'synthetic-secret' }
    if (fault === 'masked') f.saved.model.headers.authorization = '[REDACTED]'
    await assert.rejects(f.service.prepare('review-1'))
    assert.equal(await f.store.get('voice-release:assistant-a'), null)
    assert.equal(f.calls.filter(c => c === 'PATCH').length, 0)
  }
})

test('failed admission never invokes PATCH; failed acknowledgement cannot cause a second write', async () => {
  for (const stage of ['admission', 'acknowledgement']) {
    const f = fixture(), p = await f.service.prepare('review-1'), update = f.store.update.bind(f.store)
    let writes = 0
    f.store.update = async (...args) => { if (++writes === (stage === 'admission' ? 1 : 2)) throw new Error('synthetic storage fault'); return update(...args) }
    await assert.rejects(f.service.publish('review-1', p.release.reviewHash), /storage fault/)
    assert.equal(f.calls.filter(c => c === 'PATCH').length, stage === 'admission' ? 0 : 1)
    f.store.update = update
    if (stage === 'acknowledgement') {
      assert.equal((await f.service.verify('review-1')).release.state, 'verified')
      await f.service.publish('review-1', p.release.reviewHash)
      assert.equal(f.calls.filter(c => c === 'PATCH').length, 1)
    }
  }
})

test('cancelled review cannot publish and same prepare request never extends its lifetime', async () => {
  const f = fixture(), p = await f.service.prepare('review-1')
  f.advance(14 * 60_000)
  assert.equal((await f.service.prepare('review-1')).release.expiresAt, p.release.expiresAt)
  await f.service.cancel('review-1', p.release.reviewHash)
  assert.equal((await f.service.publish('review-1', p.release.reviewHash)).release.state, 'cancelled')
  assert.equal(f.calls.filter(c => c === 'PATCH').length, 0)
})

test('journal corruption and cross-property injected records fail closed', async () => {
  for (const fault of ['hash', 'property']) {
    const f = fixture(); await f.service.prepare('review-1')
    const j = await f.store.get<any>('voice-release:assistant-a')
    if (fault === 'hash') j.releases[0].reviewHash = hashJson('corrupt')
    else {
      const r = j.releases[0]; r.context.propertyId = 'foreign-property'
      const { reviewHash, state, ...content } = r
      r.reviewHash = hashJson(content)
    }
    await f.store.set('voice-release:assistant-a', j)
    await assert.rejects(f.service.list(), /administrator review/)
  }
})
