/** Import the exact shipped files outside node_modules, with no deployment secrets. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const probe = String.raw`
  import assert from 'node:assert/strict';
  import { readdir } from 'node:fs/promises';
  import { pathToFileURL } from 'node:url';
  import net from 'node:net';
  import http from 'node:http';
  import https from 'node:https';
  const blocked = () => { throw new Error('Bundle smoke check attempted network access'); };
  net.Socket.prototype.connect = blocked;
  http.request = blocked; http.get = blocked; https.request = blocked; https.get = blocked;
  globalThis.fetch = blocked;
  for (const file of (await readdir('.')).filter(file => file.endsWith('.mjs')).sort()) {
    const loaded = await import(pathToFileURL(process.cwd() + '/' + file).href);
    assert.equal(typeof loaded.default, 'function', file + ' must export a handler');
    const res = { code: 0, headers: {}, body: undefined,
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; }, send(body) { this.body = body; }, end(body) { this.body = body; } };
    await loaded.default({ method: 'GET', headers: {}, query: {}, body: undefined }, res);
    const expected = file === 'vapi-sync.mjs' ? 405
      : ['properties.mjs', 'account.mjs', 'mfa.mjs', 'workflows.mjs', 'organizations.mjs', 'resident-services.mjs'].includes(file) && !process.env.ATRIUM_RUNTIME_MODE ? 404 : 503;
    assert.equal(res.code, expected, file + ': incomplete runtime must refuse without contacting a service');
    assert.match(String(res.headers['cache-control']), /no-store/, file + ': private response must not be cached');
    assert.match(String(res.headers['x-robots-tag']), /noindex/, file + ': private response must not be indexed');
    for (const key of ['calls', 'profiles', 'slots', 'bookings', 'properties', 'actions']) {
      assert.equal(Object.hasOwn(res.body || {}, key), false, file + ': refused request leaked operational data');
    }
  }
`

export async function verifyApiBundle(directory = join(root, '.vercel-build', 'api')) {
  const expected = (await readdir(join(root, 'api'))).filter(file => file.endsWith('.ts')).map(file => file.replace(/\.ts$/, '.mjs')).sort()
  const actual = (await readdir(directory)).filter(file => file.endsWith('.mjs')).sort()
  assert.deepEqual(actual, expected, 'The deploy bundle must contain every current handler and no retired handler')
  const isolated = await mkdtemp(join(tmpdir(), 'atrium-api-bundle-'))
  try {
    for (const file of actual) await copyFile(join(directory, file), join(isolated, file))
    for (const mode of ['legacy', 'postgres']) {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
        cwd: isolated, encoding: 'utf8', timeout: 30000,
        // Do not inherit credentials, NODE_OPTIONS, PGOPTIONS, or a running preview's
        // account/provider settings. PostgreSQL intentionally has no configured URLs.
        env: { NODE_ENV: 'production', ...(mode === 'postgres' ? { ATRIUM_RUNTIME_MODE: 'postgres' } : {}) },
      })
      if (result.error) throw result.error
      assert.equal(result.status, 0, `${mode} bundle smoke check failed:\n${result.stderr || result.stdout}`)
    }
  } finally { await rm(isolated, { recursive: true, force: true }) }
  console.log(`API bundle smoke: ${actual.length} handlers imported and refused unconfigured requests in both runtime modes`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await verifyApiBundle()
