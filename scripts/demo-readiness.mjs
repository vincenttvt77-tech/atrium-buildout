import { VOICE_CONTRACT } from '../src/vapi/contract.ts'
import { checkDemoReadiness, parseReadinessArgs } from './lib/demo-readiness.mjs'

try {
  const options = parseReadinessArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/demo-readiness.mjs --origin https://your-deployment.example [--timeout-ms 10000] [--json]\nSix bounded unauthenticated GET requests. No credentials, writes, calls or paid tests. Exit: 0 passed; 1 attention/failure; 2 invalid input.')
  } else {
    const result = await checkDemoReadiness({ ...options, expectedContract: VOICE_CONTRACT })
    if (options.json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`${result.status} — ${result.origin}\n${result.scope}`)
      for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.id}: ${check.detail} (${check.httpStatus ?? 'no response'}, ${check.elapsedMs} ms)`)
      console.log(`Unverified:\n${result.unverified.map(item => `- ${item}`).join('\n')}`)
    }
    process.exitCode = result.status === 'read_only_checks_passed' ? 0 : 1
  }
} catch {
  // Invalid inputs can contain secrets; never echo arguments or arbitrary errors.
  console.error('Preflight could not run. Use --help and supply a plain HTTPS origin and a bounded integer timeout.')
  process.exitCode = 2
}
