/**
 * Bundles the API functions to plain JavaScript for deployment.
 *
 * Node runs the TypeScript directly in development, but a deploy target's runtime cannot be
 * relied on to resolve explicit .ts import specifiers. Bundling removes the question
 * entirely and means what ships is exactly what was tested, with no resolution differences
 * between here and there.
 */
import { build } from 'esbuild'
import { readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { buildOpsPage } from './build-ops.mjs'

// The dashboard page is compiled into api/dashboard.ts rather than served from public/,
// so regenerate it first — bundling a stale page is how a fix appears not to have landed.
await buildOpsPage()

const SRC = 'api'
const OUT = '.vercel-build/api'

const entries = (await readdir(SRC))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(SRC, f))

await mkdir(OUT, { recursive: true })

const result = await build({
  entryPoints: entries,
  outdir: OUT,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  // Node builtins stay external; everything of ours is inlined.
  packages: 'bundle',
  minify: process.env.MINIFY === '1',
  keepNames: true,
  logLevel: 'info',
  metafile: true,
})

const sizes = Object.entries(result.metafile.outputs)
  .map(([f, o]) => `${f} — ${(o.bytes / 1024).toFixed(1)} kB`)
console.log(sizes.join('\n'))
