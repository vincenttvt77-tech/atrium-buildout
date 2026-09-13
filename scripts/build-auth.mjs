import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
export async function buildAuthClient() {
  for (const name of ['mfa', 'organization']) {
    const result = await build({ absWorkingDir: root, entryPoints: [`src/auth/${name}-client.js`],
      bundle: true, write: false, platform: 'browser', format: 'iife', target: ['es2022'], minify: true,
      legalComments: 'inline' })
    const script = result.outputFiles[0].text
    await writeFile(resolve(root, `src/auth/${name}-client.bundle.json`), JSON.stringify({ script }) + '\n')
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildAuthClient()
