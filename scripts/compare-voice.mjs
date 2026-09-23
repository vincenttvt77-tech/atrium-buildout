/** Offline only. Paths, raw inputs and provider credentials never appear in output. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { compareVoiceEvaluations } from '../src/voice-evaluation/compare.ts'

const MAX_BYTES = 10 * 1024 * 1024
const invalid = () => { throw new Error('Invalid comparison input') }
async function readCohort(path) {
  // Nonblocking open avoids waiting on a FIFO before checking the file type.
  // Refuse final-component symlinks; this is bounded file IO, not a filesystem sandbox.
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) invalid()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_BYTES) invalid()
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_BYTES) invalid()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)))
  } finally { await file.close() }
}

try {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/compare-voice.mjs --baseline <evaluation.json> --candidate <evaluation.json>\nOffline aggregate comparison. Exit 0 means valid input, not quality or release acceptance.')
  } else {
    if (args.length !== 4) invalid()
    const paths = new Map()
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], path = args[i + 1]
      if (!['--baseline', '--candidate'].includes(flag) || paths.has(flag) || !path || path.startsWith('--')) invalid()
      paths.set(flag, path)
    }
    const baseline = await readCohort(paths.get('--baseline'))
    const candidate = await readCohort(paths.get('--candidate'))
    console.log(JSON.stringify(compareVoiceEvaluations(baseline, candidate), null, 2))
  }
} catch {
  console.error('Cannot compare voice trials. Check the documented input schema, matching rules and file limits. Input values and paths are not echoed.')
  process.exitCode = 2
}
