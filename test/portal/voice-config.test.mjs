import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspectVoiceExport, compareVoiceExports } from '../../scripts/inspect-voice-config.mjs'

const fixture = () => ({ version: { version: 'v1', createdAt: '2026-09-22T00:00:00Z' }, assistant: {
  model: { provider: 'fixture', model: 'synthetic-model', messages: [{ role: 'system', content: 'PRIVATE_PROMPT' }],
    tools: [{ type: 'function', function: { name: 'synthetic' }, server: { secret: 'PRIVATE_TOOL_SECRET' } }], toolIds: [], knowledgeBase: { fileIds: ['PRIVATE_FILE_ID'] } },
  voice: { provider: 'fixture', voiceId: 'PRIVATE_VOICE_ID' }, transcriber: { provider: 'fixture', model: 'synthetic-stt' },
  startSpeakingPlan: { waitSeconds: 0.4 }, stopSpeakingPlan: { voiceSeconds: 0.2 }, firstMessage: 'PRIVATE_GREETING',
  server: { url: 'https://private.example.test', headers: { Authorization: 'PRIVATE_AUTH' } },
  metadata: { customer: 'PRIVATE_CUSTOMER', privatePhone: '+12025550123' },
} })

test('fingerprints contain no prompt, URL, credential, customer or ID values', () => {
  const report = inspectVoiceExport(fixture()), output = JSON.stringify(report)
  assert.doesNotMatch(output, /PRIVATE|example\.test|12025550123|synthetic-model/)
  assert.match(report.configurationSha256, /^[a-f0-9]{64}$/)
  for (const value of Object.values(report.components)) assert.match(value, /^[a-f0-9]{64}$/)
  assert.equal(report.providerSchemaValidated, false)
  assert.equal(report.livePublicationVerified, false)
})

test('property order and export metadata do not imply a behavioral configuration change', () => {
  const a = fixture(), b = fixture()
  b.version = { createdAt: '2026-09-23T00:00:00Z', version: 'v2' }
  b.assistant = Object.fromEntries(Object.entries(b.assistant).reverse())
  const comparison = compareVoiceExports(a, b)
  assert.equal(comparison.sameConfiguration, true)
  assert.deepEqual(comparison.changedComponents, [])
})

test('voice-only tuning is distinguishable from prompt, tool and safety-setting drift', () => {
  const changes = [
    ['voice', a => { a.voice.voiceId = 'candidate' }],
    ['model', a => { a.model.temperature = 0.1 }],
    ['prompt', a => { a.model.messages[0].content = 'changed prompt' }],
    ['tools', a => { a.model.tools[0].server.secret = 'rotated' }],
    ['knowledge', a => { a.model.knowledgeBase.fileIds.push('new-file') }],
    ['transcriber', a => { a.transcriber.model = 'changed-stt' }],
    ['turnTaking', a => { a.stopSpeakingPlan.voiceSeconds = 0.4 }],
    ['greeting', a => { a.firstMessageInterruptionsEnabled = true }],
    ['remaining', a => { a.server.headers.Authorization = 'rotated' }],
    ['remaining', a => { a.newProviderOption = { unknown: true } }],
  ]
  for (const [section, mutate] of changes) {
    const baseline = fixture(), candidate = fixture(); mutate(candidate.assistant)
    const result = compareVoiceExports(baseline, candidate)
    assert.equal(result.sameConfiguration, false, section)
    assert.deepEqual(result.changedComponents, [section], section)
  }
})

test('missing, null, empty and reordered values stay distinguishable', () => {
  const baseline = fixture(), absent = fixture(), empty = fixture(), nil = fixture()
  delete absent.assistant.model.toolIds; nil.assistant.model.toolIds = null
  assert.notEqual(inspectVoiceExport(absent).configurationSha256, inspectVoiceExport(empty).configurationSha256)
  assert.notEqual(inspectVoiceExport(nil).configurationSha256, inspectVoiceExport(empty).configurationSha256)
  baseline.assistant.model.messages.push({ role: 'assistant', content: 'second' })
  const changed = structuredClone(baseline); changed.assistant.model.messages.reverse()
  assert.deepEqual(compareVoiceExports(baseline, changed).changedComponents, ['prompt'])
})

test('malformed shape, non-JSON values and excessive complexity are refused', () => {
  for (const value of [null, [], {}, { assistant: {} }, { ...fixture(), unknown: true }]) assert.throws(() => inspectVoiceExport(value))
  for (const mutate of [v => { v.version.version = '1' }, v => { v.assistant.voice = [] }, v => { v.assistant.model = {} },
    v => { v.assistant.metadata = { value: Infinity } }, v => { v.assistant.metadata = { value: undefined } },
    v => { v.assistant.metadata = new Date() }, v => { v.assistant.metadata = new Array(50001).fill(0) },
    v => { v.assistant.metadata = 'x'.repeat(1024 * 1024) },
    v => { let nested = {}; v.assistant.metadata = nested; for (let i=0;i<65;i++) { nested.next = {}; nested = nested.next } },
  ]) { const value = fixture(); mutate(value); assert.throws(() => inspectVoiceExport(value)) }
})

test('CLI handles the actual export envelope and fails without exposing private files or parser content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-voice-config-'))
  const script = new URL('../../scripts/inspect-voice-config.mjs', import.meta.url).pathname
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 })
  try {
    const source = join(dir, 'PRIVATE_PATH.json'), candidate = join(dir, 'candidate.json')
    await writeFile(source, JSON.stringify(fixture()))
    const value = fixture(); value.assistant.voice.voiceId = 'candidate'
    await writeFile(candidate, JSON.stringify(value))
    const good = run('--input', source, '--compare', candidate)
    assert.equal(good.status, 0); assert.deepEqual(JSON.parse(good.stdout).changedComponents, ['voice'])
    assert.doesNotMatch(good.stdout + good.stderr, /PRIVATE|example\.test/)
    for (const content of ['{"PRIVATE_PARSER_SECRET":', '{"version":{"version":"v1"},"assistant":{"model":{"x":1e999},"voice":{"x":1},"transcriber":{"x":1}}}',
      'x'.repeat(1024 * 1024 + 1), Buffer.from([0xff, 0xfe])]) {
      await writeFile(source, content)
      const failed = run('--input', source)
      assert.equal(failed.status, 2); assert.equal(failed.stdout, '')
      assert.doesNotMatch(failed.stderr, /PRIVATE|example\.test/)
    }
    for (const args of [[], ['--input', join(dir,'PRIVATE_MISSING')], ['--input',dir], ['--input',candidate,'--bad',source]]) {
      const failed = run(...args); assert.equal(failed.status,2); assert.doesNotMatch(failed.stderr,/PRIVATE/)
    }
    assert.equal(run('--help').status,0)
  } finally { await rm(dir,{recursive:true,force:true}) }
})
