import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const migrationsDirectory = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url))

/** Dedicated maintenance connection only. The application never receives this client. */
export async function applyDatabaseMigrations(client, directory = migrationsDirectory) {
  const files = (await readdir(directory)).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort()
  if (!files.length) throw new Error('No database migrations found.')
  await client.query('BEGIN')
  try {
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('atrium-schema-migrations', 0))")
    await client.query('CREATE SCHEMA IF NOT EXISTS atrium_migrations AUTHORIZATION atrium_admin')
    await client.query('REVOKE ALL ON SCHEMA atrium_migrations FROM PUBLIC')
    await client.query(`CREATE TABLE IF NOT EXISTS atrium_migrations.history (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    await client.query('ALTER TABLE atrium_migrations.history OWNER TO atrium_admin')
    await client.query('REVOKE ALL ON atrium_migrations.history FROM PUBLIC')
    const existing = new Map((await client.query('SELECT version, checksum FROM atrium_migrations.history')).rows.map(row => [row.version, row.checksum]))
    if ([...existing.keys()].some(version => !files.includes(version))) throw new Error('Database migration history includes an unknown version.')
    const appliedVersions = [...existing.keys()].sort()
    if (appliedVersions.some((version,index) => files[index] !== version)) throw new Error('Database migration history is not a prefix of the ordered migrations.')
    const applied = []
    for (const file of files) {
      const sql = await readFile(join(directory, file), 'utf8')
      if (!sql.trim()) throw new Error(`Empty database migration: ${file}`)
      const checksum = createHash('sha256').update(sql).digest('hex')
      if (existing.has(file)) {
        if (existing.get(file) !== checksum) throw new Error(`Database migration checksum mismatch: ${file}`)
        continue
      }
      await client.query(sql)
      await client.query('INSERT INTO atrium_migrations.history(version, checksum) VALUES ($1, $2)', [file, checksum])
      applied.push(file)
    }
    const committed = await client.query('COMMIT')
    if (committed.command !== 'COMMIT') throw new Error('The migration transaction was rolled back.')
    return applied
  } catch (error) { await client.query('ROLLBACK'); throw error }
}
