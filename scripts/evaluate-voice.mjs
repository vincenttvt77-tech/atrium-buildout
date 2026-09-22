import { readFile, stat } from 'node:fs/promises'
import { evaluateVoice } from '../src/voice-evaluation/metrics.ts'

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node scripts/evaluate-voice.mjs --input <reviewed-evaluation.json>\nOffline aggregate report only. No network, calls, credentials or transcripts. See docs/voice-evaluation.md.')
} else {
  try {
    if (args.length !== 2 || args[0] !== '--input' || !args[1]) throw new Error()
    const info = await stat(args[1])
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error()
    const data = await readFile(args[1])
    if (data.length > 10 * 1024 * 1024) throw new Error()
    console.log(JSON.stringify(evaluateVoice(JSON.parse(data.toString('utf8'))), null, 2))
  } catch {
    // Neither parser errors nor file paths/input values belong in shared evidence.
    console.error('Evaluation could not run. Check the input schema and file size (maximum 10 MiB). No input values are echoed.')
    process.exitCode = 2
  }
}
