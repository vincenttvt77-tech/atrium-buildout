export const SOURCE_DIR: string
export const HTML_OUTPUT: string
export const OUTPUT: string
export function composeOpsPage(): Promise<{ html: string; included: string[] }>
export function buildOpsPage(): Promise<{ bytes: number; included: string[] }>
