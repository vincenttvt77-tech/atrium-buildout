import EmbeddedPostgres from 'embedded-postgres'
import { mkdtemp, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

/** Real PostgreSQL, private temporary files, loopback only; never an existing database. */
export async function createTestPostgres() {
  if (process.env.ATRIUM_SIMULATION) throw new Error('Database processes are unavailable in voice simulations.')
  const directory = await mkdtemp(join(tmpdir(), 'atrium-postgres-test-'))
  await chmod(directory, 0o700)
  const port = await unusedPort()
  const password = randomBytes(32).toString('base64url')
  const logs = []
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'data'), port, user: 'postgres', password,
    authMethod: 'scram-sha-256', persistent: true, createPostgresUser: false,
    postgresFlags: ['-h', '127.0.0.1', '-k', directory, '-c', 'max_connections=30'],
    onLog: message => { logs.push(String(message)); if (logs.length > 20) logs.shift() },
    onError: message => { logs.push(String(message)); if (logs.length > 20) logs.shift() },
  })
  try {
    await postgres.initialise()
    await postgres.start()
    const admin = postgres.getPgClient('postgres', '127.0.0.1')
    await admin.connect()
    return {
      admin, port, directory,
      connection(user, secret) { return { host: '127.0.0.1', port, user, password: secret, database: 'postgres', ssl: false } },
      async close() { await admin.end(); await postgres.stop(); await rm(directory, { recursive: true, force: true }) },
    }
  } catch (error) {
    try { await postgres.stop() } catch {}
    await rm(directory, { recursive: true, force: true })
    throw new Error(`Local PostgreSQL could not start. ${logs.join('\n')}`, { cause: error })
  }
}
