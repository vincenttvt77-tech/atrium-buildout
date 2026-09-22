import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dgram from 'node:dgram'
import { syncBuiltinESMExports } from 'node:module'

export const ISOLATION_MODE = 'dedicated worker; synthetic tenant; memory only; operational network denied'

/** Build an allowlist, never copy the caller's credentials or deployment configuration. */
export function simulationEnvironment(): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ATRIUM_SIMULATION: 'isolated-v1', TZ: 'UTC' }
}

/** Runtime guard for the application transports, not an operating-system security sandbox. */
export function denyOperationalNetwork(): { attempts: () => number } {
  let attempts = 0
  const denied = () => {
    attempts++
    throw new Error('SIMULATION_NETWORK_DENIED')
  }
  Object.defineProperty(globalThis, 'fetch', { value: async () => denied(), writable: false, configurable: false })
  for (const [object, key] of [
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'],
    [tls, 'connect'], [dgram, 'createSocket'],
  ] as Array<[object, string]>) Object.defineProperty(object, key, { value: denied, writable: false, configurable: false })
  syncBuiltinESMExports()
  return { attempts: () => attempts }
}

/** A worker should never start with inherited environment, even if constructed incorrectly. */
export function assertSimulationEnvironment(env: NodeJS.ProcessEnv): void {
  const expected = simulationEnvironment()
  if (Object.keys(env).some(key => !Object.hasOwn(expected, key)) ||
      Object.entries(expected).some(([key, value]) => env[key] !== value)) {
    throw new Error('SIMULATION_UNSAFE_ENVIRONMENT')
  }
}
