/** A download capability is minted only after checking the provider's exact call owner. */
export const recordingCallId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export class RecordingError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
const unavailable = () => new RecordingError(503, 'recording_unavailable', 'The recording connection is unavailable. Try again shortly.')
const missing = () => new RecordingError(404, 'recording_not_found', 'This recording is not available in this workspace.')

/** Only used as an audio source, never followed by the server or used as a page link. */
export function safeRecordingUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16384 || /[\s\\]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)
      && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname)
      && !/(?:^|\.)example\.(?:com|org|net)$/.test(url.hostname)
  } catch { return false }
}

export function hasRecording(raw: unknown): boolean {
  const call = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  if (!recordingCallId(call.id)) return false
  const artifact = call.artifact && typeof call.artifact === 'object' ? call.artifact : {}
  return [call.recordingUrl, call.stereoRecordingUrl, artifact.recordingUrl, artifact.stereoRecordingUrl,
    artifact.presignedMonoUrl, artifact.presignedStereoUrl].some(safeRecordingUrl)
}

async function readCall(response: Response): Promise<Record<string, unknown>> {
  if (response.status === 404) throw missing()
  if (!response.ok || !response.body) throw unavailable()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) { const part = await reader.read(); if (part.done) break
      size += part.value.byteLength; if (size > 1048576) throw unavailable(); chunks.push(part.value) }
    const call = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!call || typeof call !== 'object' || Array.isArray(call)) throw unavailable()
    return call
  } finally { await reader.cancel().catch(() => {}) }
}

export async function getRecording(options: {
  callId: string; apiKey: string; assistantIds: readonly string[] | undefined
  revalidate: () => Promise<void>; fetchImpl?: typeof fetch; signal?: AbortSignal
}): Promise<{ callId: string; url: string }> {
  if (!recordingCallId(options.callId)) throw new RecordingError(400, 'invalid_call', 'Choose a saved call.')
  if (options.assistantIds?.length === 0) throw missing()
  if (!options.apiKey.trim()) throw unavailable()
  const doFetch = options.fetchImpl ?? fetch, signal = options.signal ?? AbortSignal.timeout(8000)
  const url = `https://api.vapi.ai/call/${options.callId}`
  const headers = { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' }
  // Keep authority errors intact, and never expose provider bodies, URLs or credentials.
  let call: Record<string, unknown>
  try { call = await readCall(await doFetch(url, { headers, redirect: 'error', signal })) }
  catch (error) { if (error instanceof RecordingError) throw error; throw unavailable() }
  await options.revalidate()
  if (call.id !== options.callId || typeof call.assistantId !== 'string' || !call.assistantId
      || options.assistantIds && !options.assistantIds.includes(call.assistantId)) throw missing()
  let location: string | null = null
  try {
    const response = await doFetch(`${url}/mono-recording`, { headers, redirect: 'manual', signal })
    try {
      if (response.status === 404) throw missing()
      if (response.status !== 302) throw unavailable()
      location = response.headers.get('location')
      if (!safeRecordingUrl(location)) throw unavailable()
    } finally { await response.body?.cancel().catch(() => {}) }
  } catch (error) { if (error instanceof RecordingError) throw error; throw unavailable() }
  await options.revalidate()
  signal.throwIfAborted()
  return { callId: options.callId, url: location! }
}
