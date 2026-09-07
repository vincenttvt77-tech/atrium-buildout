export function concessionTerms(text: string | null | undefined): { freeMonths: number; termMonths: number; qty: number; weeks: boolean } | null
export function leaseRent(unit: { monthlyRent: number; concession?: string | null }): number
export function shortConcession(text: string | null | undefined): string
export function renderSite(opts?: { today?: string }): Promise<Record<string, string>>
