/**
 * The narrow slice of the Messages API the simulator needs.
 *
 * Kept as our own types rather than the SDK's so the runner and the tests can be driven
 * by a scripted fake, and so the SDK stays a dev-only dependency that nothing under `api/`
 * ever imports.
 */
export type ModelRole = 'user' | 'assistant'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

export interface ModelMessage {
  role: ModelRole
  content: string | ContentBlock[]
}

export interface ModelTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ModelRequest {
  model: string
  max_tokens: number
  system?: string
  tools?: ModelTool[]
  /** Force one tool — used to get a structured verdict out of the judge. */
  tool_choice?: { type: 'tool'; name: string }
  thinking?: { type: 'adaptive' }
  messages: ModelMessage[]
}

export interface ModelResponse {
  content: ContentBlock[]
  stop_reason: string | null
  usage?: { input_tokens: number; output_tokens: number }
}

/** Anything that can answer a Messages request: the real SDK, or a scripted fake in tests. */
export interface Model {
  create(req: ModelRequest): Promise<ModelResponse>
}

/** One line of a simulated call, in the order it happened. */
export type Turn =
  | { who: 'assistant'; text: string }
  | { who: 'caller'; text: string }
  | { who: 'tool'; name: string; input: Record<string, unknown>; result: string }

/** The webhook, driven in-process the way Vapi drives it over HTTPS. */
export type Webhook = (req: { method: string; headers: Record<string, string>; body: unknown }, res: {
  status(code: number): unknown
  json(body: unknown): unknown
  setHeader(name: string, value: string): unknown
}) => Promise<void>
