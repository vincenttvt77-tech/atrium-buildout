/** Offline fingerprints only. Never print prompt text, endpoints, IDs or credentials. */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BYTES = 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = () => { throw new Error('Invalid voice export') }
function canonical(value) {
  let nodes = 0
  function walk(item, depth) {
    if (++nodes > 50000 || depth > 64) invalid()
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return JSON.stringify(item) }
    if (Array.isArray(item)) return '[' + item.map(entry => walk(entry, depth + 1)).join(',') + ']'
    if (!object(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid()
    return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + walk(item[key], depth + 1)).join(',') + '}'
  }
  const result = walk(value, 0)
  if (Buffer.byteLength(result) > MAX_BYTES) invalid()
  return result
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
const pick = (source, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]))
const omit = (source, keys) => Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)))

export function inspectVoiceExport(input) {
  // Validate/bound the entire document, including otherwise excluded version metadata.
  canonical(input)
  if (!object(input) || Object.keys(input).sort().join(',') !== 'assistant,version'
    || !object(input.assistant) || !object(input.version)
    || typeof input.version.version !== 'string' || !/^v[1-9][0-9]{0,8}$/.test(input.version.version)) invalid()
  const assistant = input.assistant
  for (const section of ['model', 'voice', 'transcriber']) if (!object(assistant[section]) || !Object.keys(assistant[section]).length) invalid()
  const modelSpecial = ['messages', 'tools', 'toolIds', 'knowledgeBase']
  const assistantSpecial = ['model', 'voice', 'transcriber', 'startSpeakingPlan', 'stopSpeakingPlan',
    'firstMessage', 'firstMessageMode', 'firstMessageInterruptionsEnabled']
  const groups = {
    model: omit(assistant.model, modelSpecial),
    prompt: pick(assistant.model, ['messages']),
    tools: pick(assistant.model, ['tools', 'toolIds']),
    knowledge: pick(assistant.model, ['knowledgeBase']),
    voice: pick(assistant, ['voice']),
    transcriber: pick(assistant, ['transcriber']),
    turnTaking: pick(assistant, ['startSpeakingPlan', 'stopSpeakingPlan']),
    greeting: pick(assistant, ['firstMessage', 'firstMessageMode', 'firstMessageInterruptionsEnabled']),
    remaining: omit(assistant, assistantSpecial),
  }
  return { format: 'atrium-voice-fingerprint-v1', configurationSha256: hash(assistant),
    components: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, hash(value)])),
    providerSchemaValidated: false, livePublicationVerified: false }
}

export function compareVoiceExports(baseline, candidate) {
  const before = inspectVoiceExport(baseline), after = inspectVoiceExport(candidate)
  return { format: 'atrium-voice-comparison-v1', baseline: before, candidate: after,
    sameConfiguration: before.configurationSha256 === after.configurationSha256,
    changedComponents: Object.keys(before.components).filter(key => before.components[key] !== after.components[key]) }
}

async function readExport(path) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_BYTES) invalid()
    // A bounded read also prevents a growing file from defeating the initial stat.
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/inspect-voice-config.mjs --input <version-export.json> [--compare <candidate-export.json>]\nOffline fingerprints only; no network, writes or original values. See docs/voice-evaluation.md.')
  } else {
    try {
      if (![2, 4].includes(args.length) || args[0] !== '--input' || !args[1]
        || (args.length === 4 && (args[2] !== '--compare' || !args[3]))) invalid()
      const baseline = await readExport(args[1])
      const report = args.length === 4 ? compareVoiceExports(baseline, await readExport(args[3])) : inspectVoiceExport(baseline)
      console.log(JSON.stringify(report, null, 2))
    } catch {
      console.error('Voice export could not be inspected. Check the export shape and size (maximum 1 MiB). No input values or paths are echoed.')
      process.exitCode = 2
    }
  }
}
