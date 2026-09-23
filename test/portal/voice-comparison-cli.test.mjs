import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, truncate, symlink, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = new URL('../../scripts/compare-voice.mjs', import.meta.url)
const run = args => spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8', timeout: 5000 })
const cohort = (over = {}) => ({ schemaVersion: 1, timingUnit: 'milliseconds', evidence: 'synthetic',
  split: 'development', configurationSha256: 'a'.repeat(64), datasetSha256: 'b'.repeat(64),
  measurement: 'instrumentation', cases: [{ id: 'case-1', workflow: 'book_tour', outcome: 'success',
    eligibleForContainment: true, containment: 'contained', criticalFailures: [], costUsd: 0,
    turns: [{ responseMs: 100 }] }], ...over })
const refused = result => {
  assert.equal(result.status, 2, result.error?.message)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Cannot compare voice trials. Check the documented input schema, matching rules and file limits. Input values and paths are not echoed.\n')
}
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-comparison-'))
  try {
    const baseline = join(dir, 'PRIVATE_BASELINE.json'), candidate = join(dir, 'PRIVATE_CANDIDATE.json')
    await writeFile(baseline, JSON.stringify(cohort()))
    await writeFile(candidate, JSON.stringify(cohort({ configurationSha256: 'c'.repeat(64) })))
    await fn({ dir, baseline, candidate, args: ['--baseline', baseline, '--candidate', candidate] })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('comparison CLI emits only aggregates, fingerprints and fixed labels without modifying inputs', async () => fixture(async ({ dir, baseline, candidate, args }) => {
  const before = await Promise.all([readFile(baseline, 'utf8'), readFile(candidate, 'utf8')])
  const r = run(args)
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.matching.cases, 1)
  assert.equal(report.matching.sameConfiguration, false)
  assert.equal(report.assessment.productionReadiness, 'not_established')
  assert.equal(report.deltas.latency.metrics.responseMs.p95DeltaMs, 0)
  assert.doesNotMatch(r.stdout, /case-1|PRIVATE_|atrium-comparison-/)
  assert.deepEqual(await Promise.all([readFile(baseline, 'utf8'), readFile(candidate, 'utf8')]), before)
  assert.deepEqual((await readdir(dir)).sort(), ['PRIVATE_BASELINE.json', 'PRIVATE_CANDIDATE.json'])
}))

test('valid but worse trials still exit zero with failures plainly reported, not a quality pass', async () => fixture(async ({ candidate, args }) => {
  const c = cohort(); c.cases[0].outcome = 'failure'; c.cases[0].criticalFailures = ['false_confirmation']
  await writeFile(candidate, JSON.stringify(c))
  const r = run(args)
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.paired.reviewedSuccessRegressions, 1)
  assert.equal(report.assessment.candidateHasRecordedCriticalFailures, true)
  assert.equal(report.candidate.assessment.observedTargetMet, false)
}))

test('mismatched trials, malformed JSON and unknown fields fail without private value or path disclosure', async () => fixture(async ({ candidate, args }) => {
  for (const contents of ['{"private":"PRIVATE_TEXT"', JSON.stringify(cohort({ private: 'PRIVATE_TEXT' })),
    JSON.stringify(cohort({ cases: [] })), JSON.stringify(cohort({ datasetSha256: 'd'.repeat(64) }))]) {
    await writeFile(candidate, contents); refused(run(args))
  }
}))

test('invalid UTF-8 is refused with the same redacted failure as invalid JSON', async () => fixture(async ({ candidate, args }) => {
  const bytes = Buffer.from(JSON.stringify(cohort())); bytes[bytes.indexOf('aaaa')] = 0xff
  await writeFile(candidate, bytes); refused(run(args))
}))

test('oversized input and nonregular files are refused in either input position', async () => fixture(async ({ dir, baseline, candidate }) => {
  const oversized = join(dir, 'PRIVATE_LARGE.json')
  await writeFile(oversized, ''); await truncate(oversized, 10 * 1024 * 1024 + 1)
  const link = join(dir, 'PRIVATE_LINK.json'); await symlink(baseline, link)
  for (const invalid of [oversized, dir, link, join(dir, 'PRIVATE_MISSING.json')]) {
    refused(run(['--baseline', invalid, '--candidate', candidate]))
    refused(run(['--baseline', baseline, '--candidate', invalid]))
  }
}))

test('named pipe input fails promptly without waiting for a writer', { skip: process.platform === 'win32' }, async () => fixture(async ({ dir, candidate }) => {
  const fifo = join(dir, 'PRIVATE_PIPE')
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5000 })
  assert.equal(made.status, 0, made.stderr)
  refused(run(['--baseline', fifo, '--candidate', candidate]))
}))

test('argument order is flexible but missing, duplicate or unknown arguments fail', async () => fixture(async ({ baseline, candidate }) => {
  assert.equal(run(['--candidate', candidate, '--baseline', baseline]).status, 0)
  assert.equal(run(['--help']).status, 0)
  for (const args of [[], ['--baseline', baseline], ['--baseline', baseline, '--baseline', candidate],
    ['--baseline', baseline, '--upload', candidate], ['--help', baseline],
    ['--baseline', baseline, '--candidate', '--help'], ['--baseline', baseline, '--candidate', candidate, '--publish']]) refused(run(args))
}))
