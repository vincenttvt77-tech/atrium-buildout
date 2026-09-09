import { assistantConfig } from './assistant.ts'

/**
 * The demo property's assistant, built from the property record.
 *
 * One function, used by the script that prints the configuration and by the endpoint
 * that pushes it to Vapi, so the phone line and the repository cannot describe two
 * different assistants.
 */
type PropertyRecord = Record<string, unknown> & {
  buildingName?: string; address?: string; leasingHours?: string; managementCompany?: string
  floors?: number; yearBuilt?: number; totalUnits?: number; leasingOffice?: string
  buildingFacts?: { height?: string; residenceNumbering?: string }
  team?: { leasing?: string }
  neighborhood?: string | { transit?: string[]; nearby?: string[] }
}

/** The property record nests transit and nearby places; the prompt wants prose. */
function neighborhoodText(n: PropertyRecord['neighborhood']): string {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return 'the neighborhood'
  return [...(n.transit ?? []), ...(n.nearby ?? [])].join('. ')
}

function buildingFacts(p: PropertyRecord): string[] {
  const f: string[] = []
  if (p.buildingFacts?.height) f.push(`${p.floors} floors, ${p.buildingFacts.height} tall, completed ${p.yearBuilt}.`)
  if (p.totalUnits) f.push(`${p.totalUnits} residences.`)
  if (p.buildingFacts?.residenceNumbering) f.push(p.buildingFacts.residenceNumbering)
  if (p.leasingOffice) f.push(p.leasingOffice)
  if (p.team?.leasing) f.push(p.team.leasing)
  // Only the two transit facts a caller asks about unprompted. The rest is in the
  // knowledge base, where it costs nothing until someone actually asks.
  const n = p.neighborhood
  const transit = n && typeof n === 'object' ? (n.transit ?? []) : []
  for (const t of transit.slice(0, 2)) f.push(`Transit: ${t}`)
  return f
}

export function demoAssistantConfig(property: PropertyRecord, deploymentUrl: string, now: Date = new Date(), opts: { dynamicDate?: boolean } = {}) {
  const buildingName = property.buildingName ?? 'the building'
  return assistantConfig({
    buildingName,
    address: property.address ?? '',
    neighborhood: neighborhoodText(property.neighborhood),
    leasingHours: property.leasingHours ?? '',
    managementCompany: property.managementCompany ?? 'the management office',
    facts: buildingFacts(property),
    today: now,
    dynamicDate: opts.dynamicDate ?? true,
    serverUrl: `${deploymentUrl.replace(/\/$/, '')}/api/vapi`,
    firstMessage: `Thanks for calling ${buildingName}. I'm an AI assistant for the building and this call is recorded — how can I help?`,
  })
}

export type DemoAssistantConfig = ReturnType<typeof demoAssistantConfig>
