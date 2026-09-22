import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, truncate, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const script = new URL('../../scripts/evaluate-voice.mjs', import.meta.url)
const run = args => spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8', timeout: 5000 })
test('offline CLI emits an aggregate report and no raw call fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-evaluation-'))
  try {
    const input = join(dir, 'case.json')
    await writeFile(input, JSON.stringify({ schemaVersion: 1, timingUnit: 'milliseconds', evidence: 'synthetic',
      split: 'development', configurationSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64),
      measurement: 'instrumentation', cases: [] }))
    const r = run(['--input', input])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).cases, 0)
    assert.equal(JSON.parse(r.stdout).assessment.productionReadiness, 'not_established')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('malformed input produces a generic error without leaking content or file path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-evaluation-'))
  try {
    const input = join(dir, 'PRIVATE_NAME.json')
    await writeFile(input, '{"private":"PRIVATE_CONTACT"')
    const r = run(['--input', input])
    assert.equal(r.status, 2)
    assert.equal(r.stdout, '')
    assert.doesNotMatch(r.stderr, /PRIVATE_NAME|PRIVATE_CONTACT|atrium-evaluation-/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('unknown arguments fail and help requires no input', () => {
  assert.equal(run(['--upload', 'https://example.test']).status, 2)
  assert.equal(run(['--help']).status, 0)
})

test('oversized input is rejected before parsing or printing its contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-evaluation-'))
  try {
    const input = join(dir, 'large.json')
    await writeFile(input, '')
    await truncate(input, 10 * 1024 * 1024 + 1)
    const r = run(['--input', input])
    assert.equal(r.status, 2)
    assert.equal(r.stdout, '')
    assert.doesNotMatch(r.stderr, /large.json|atrium-evaluation-/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
