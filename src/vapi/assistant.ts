import { systemPrompt, type PromptContext } from './prompt.ts'

/** Tool schemas as Vapi expects them (OpenAI function-calling shape). */
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'capture_signal',
      description: 'Record something the caller told you about what they need. Call this every time they give you move-in timing, bedroom count, budget, pets or parking.',
      parameters: {
        type: 'object',
        properties: {
          signal: { type: 'string', enum: ['moveInTiming', 'budget', 'bedrooms', 'pets', 'parking'] },
          value: { type: 'string', description: 'Normalised value. For moveInTiming use an ISO date. For budget a number. For bedrooms a number or "studio".' },
          excerpt: { type: 'string', description: 'The words the caller actually used. Required.' },
        },
        required: ['signal', 'value', 'excerpt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description: 'Get the units you are allowed to quote. You may not name any unit, rent or availability date that did not come from this tool. Call it before discussing price.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'answer_question',
      description: 'Answer a question about the building. Use this for anything about policies, amenities, pets, parking, application requirements, or building facts. It will tell you what you may say.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          topic: {
            type: 'string',
            enum: [
              'pet_policy', 'parking', 'amenities', 'hours', 'utilities',
              'application_requirements', 'building_access', 'move_logistics',
              'general_property_fact', 'pricing', 'unit_availability',
              'tour_slot_availability', 'fair_housing', 'reasonable_accommodation',
              'eligibility_or_denial', 'legal_question', 'dispute', 'money_movement',
              'protected_class_inquiry',
            ],
          },
        },
        required: ['question', 'topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tour_slots',
      description: 'Get real available tour times. Offer only these.',
      parameters: {
        type: 'object',
        properties: { preferredDate: { type: 'string', description: 'ISO date the caller asked for, if any.' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_tour',
      description: 'Book a tour. Only say it is confirmed if this comes back confirmed.',
      parameters: {
        type: 'object',
        properties: {
          slotId: { type: 'string' },
          prospectName: { type: 'string' },
          prospectEmail: { type: 'string' },
          unitId: { type: 'string', description: 'The unit they want to see, if they picked one.' },
        },
        required: ['slotId', 'prospectName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'capture_loss_reason',
      description: 'Record why this caller is not converting, in their own words. Call this whenever price, timing, unit mix, pets, parking or a policy is the sticking point.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['priced_out', 'timing_mismatch', 'no_availability', 'bedroom_mismatch',
                   'pets', 'parking', 'policy', 'competitor', 'application_friction',
                   'feature_missing', 'went_quiet', 'not_qualified'],
          },
          detail: { type: 'string', description: 'Specific and countable. "800 over their stated ceiling", not "too expensive".' },
          evidence: { type: 'string', description: 'What the caller actually said.' },
        },
        required: ['kind', 'detail', 'evidence'],
      },
    },
  },
] as const

export interface AssistantConfigOptions extends PromptContext {
  serverUrl: string
  firstMessage: string
  voiceProvider?: string
  voiceId?: string
}

/** The JSON to paste into Vapi. Everything the assistant needs, in one object. */
export function assistantConfig(opts: AssistantConfigOptions) {
  return {
    name: `${opts.buildingName} — Leasing`,
    firstMessage: opts.firstMessage,
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      temperature: 0.4,
      messages: [{ role: 'system', content: systemPrompt(opts) }],
      tools: TOOL_DEFINITIONS,
    },
    voice: {
      provider: opts.voiceProvider ?? '11labs',
      voiceId: opts.voiceId ?? 'burt',
      // Reduce the pause before the agent speaks; long gaps read as a dropped call.
      fillerInjectionEnabled: false,
    },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
    server: { url: opts.serverUrl },
    // Let the caller cut in. A leasing agent who talks over people loses them.
    startSpeakingPlan: { waitSeconds: 0.4 },
    stopSpeakingPlan: { numWords: 2 },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 900,
    recordingEnabled: true,
    endCallPhrases: ['goodbye', 'bye now', 'have a good one'],
  }
}
