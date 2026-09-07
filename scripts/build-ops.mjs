/**
 * Embeds the operations dashboard page into a module the API function can import.
 *
 * The page cannot live in `public/` any more: everything under `public/` is served to
 * anyone who asks, and this page is the front end for prospect names, email addresses and
 * verbatim call excerpts. It is served by `api/dashboard.ts` instead, behind the session
 * gate — which means the HTML has to reach the function.
 *
 * A JSON module is the one form every pipeline here agrees on. Node runs it directly with
 * an import attribute, esbuild inlines it into the deploy bundle, and Vercel's own builder
 * traces it — none of which is true of `readFileSync` on a serverless filesystem or of a
 * `.html` import. `ops/dashboard.html` stays the file you edit; this is the compiled form,
 * and `src/ops/test/dashboard-page.test.ts` fails if the two drift apart.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
export const SOURCE = join(root, 'ops', 'dashboard.html')
export const OUTPUT = join(root, 'ops', 'dashboard.page.json')

export async function buildOpsPage() {
  const html = await readFile(SOURCE, 'utf8')
  await writeFile(OUTPUT, `${JSON.stringify({ html }, null, 2)}\n`)
  return { bytes: html.length }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const { bytes } = await buildOpsPage()
  console.log(`ops/dashboard.page.json — ${(bytes / 1024).toFixed(1)} kB of HTML embedded`)
}
