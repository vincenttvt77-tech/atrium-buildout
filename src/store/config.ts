/** Memory is a local preview convenience, never a deployed persistence strategy. */
export function isHostedRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || Boolean(env.VERCEL?.trim())
}

export class StorageConfigurationError extends Error {
  readonly code = 'storage_not_configured'

  constructor() {
    super('Durable storage is required. Set both KV_REST_API_URL and KV_REST_API_TOKEN for this deployment, then redeploy.')
    this.name = 'StorageConfigurationError'
  }
}

/** Resolve on use so configuration changes cannot leave a cached memory fallback active. */
export function storageConfig(env: NodeJS.ProcessEnv = process.env):
  { kind: 'memory' } | { kind: 'kv'; url: string; token: string } {
  const url = env.KV_REST_API_URL?.trim()
  const token = env.KV_REST_API_TOKEN?.trim()
  if (url && token) return { kind: 'kv', url, token }
  if (isHostedRuntime(env)) throw new StorageConfigurationError()
  return { kind: 'memory' }
}
