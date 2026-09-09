import { DatabaseConfigurationError } from './errors.ts'

export function isPostgresRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.ATRIUM_RUNTIME_MODE
  if (mode === 'postgres') {
    if (env.ATRIUM_SIMULATION) throw new DatabaseConfigurationError()
    return true
  }
  if (mode !== undefined || env.ATRIUM_DATABASE_URL !== undefined || env.ATRIUM_AUTH_DATABASE_URL !== undefined) throw new DatabaseConfigurationError()
  return false
}
