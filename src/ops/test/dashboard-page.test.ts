import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { composeOpsPage } from '../../../scripts/build-ops.mjs'

/**
 * `ops/dashboard.html` and `ops/dashboard.page.json` are generated from `ops/src/` by
 * `npm run build:ops`. Generated files rot silently, so this fails the build the moment
 * someone edits a source and ships the stale copy — which would look like the fix landing
 * and the page not changing.
 */
const root = fileURLToPath(new URL('../../..', import.meta.url))

describe('the embedded dashboard page', () => {
  test('matches the composed ops/src exactly — run `npm run build:ops` if this fails', async () => {
    const { html } = await composeOpsPage()
    const written = await readFile(join(root, 'ops', 'dashboard.html'), 'utf8')
    const embedded = JSON.parse(await readFile(join(root, 'ops', 'dashboard.page.json'), 'utf8'))
    assert.equal(written, html)
    assert.equal(embedded.html, html)
  })

  test('every include directive was resolved', async () => {
    const { html } = await composeOpsPage()
    assert.doesNotMatch(html, /<!--\s*@include/)
  })

  test('the page is not served as a static file', async () => {
    await assert.rejects(
      readFile(join(root, 'public', 'dashboard.html')),
      /ENOENT/,
      'public/ is the deployment root; a dashboard in it is a dashboard with no gate',
    )
  })

  test('robots.txt disallows the operations routes as well', async () => {
    const robots = await readFile(join(root, 'public', 'robots.txt'), 'utf8')
    assert.match(robots, /Disallow: \/api\//)
  })
})
