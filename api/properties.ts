import { runtimeForRequest, isPostgresRuntime, readRuntimeError } from '../src/application/runtime.ts'
import type { AuthorizedProperty } from '../src/auth/index.ts'

/** Catalogue only: selecting a link causes fresh authorization for its explicit property. */
export default async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  res.setHeader('x-content-type-options', 'nosniff')
  try {
    if (!isPostgresRuntime()) { res.status(404).json({ error: 'Property selection is not enabled in this workspace.' }); return }
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); res.status(405).json({ error: 'GET only' }); return }
    // The server may inject its runtime when mounting handlers; no browser-selected
    // repository, role or property field is read by this unscoped catalogue route.
    const runtime = runtimeForRequest(req)
    const principal = await runtime.authenticate(req.headers ?? {}, new Date())
    if (!principal) { res.status(401).json({ error: 'Sign in to view your properties.' }); return }
    const properties = await runtime.authorization.listAuthorizedProperties(principal)
    res.status(200).json({ properties: properties.map((property: AuthorizedProperty) => ({
      id: property.id, organizationId: property.organizationId, organizationName: property.organizationName,
      name: property.name, timeZone: property.timeZone, role: property.role,
      permissions: property.permissions, permissionVersion: property.permissionVersion,
      href: `/api/dashboard?${new URLSearchParams({ organizationId: property.organizationId, propertyId: property.id })}`,
    })) })
  } catch (error) {
    const failure = readRuntimeError(error)
    res.status(failure.status).json(failure.body)
  }
}
