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
          signal: {
            type: 'string',
            description: 'Which signal the caller just gave you.',
            enum: ['moveInTiming', 'budget', 'bedrooms', 'pets', 'parking'],
          },
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
      // A parameter-less tool would be an empty `properties: {}`, which several schema
      // validators reject. `reason` is genuinely useful anyway: it records what prompted
      // the lookup, which is one more signal on the call.
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why you are checking now — for example "caller asked about one bedrooms".',
          },
        },
      },
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
          question: { type: 'string', description: 'The question as the caller asked it.' },
          topic: {
            type: 'string',
            description: 'Which kind of question this is. Restricted topics are routed to a human.',
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
          slotId: { type: 'string', description: 'The slotId from list_tour_slots. Never invent one.' },
          prospectName: { type: 'string', description: 'The name to put on the booking.' },
          prospectEmail: { type: 'string', description: 'Where the confirmation goes, if they gave one.' },
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
            description: 'The sticking point.',
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
/** Strips `required: []`, which some schema validators reject outright. */
function pruneEmptyRequired(tools: unknown): unknown {
  return JSON.parse(JSON.stringify(tools, (key, value) => {
    if (key === 'required' && Array.isArray(value) && value.length === 0) return undefined
    return value
  }))
}

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
      tools: pruneEmptyRequired(TOOL_DEFINITIONS),
    },
    voice: {
      provider: opts.voiceProvider ?? '11labs',
      voiceId: opts.voiceId ?? 'burt',
      // Was false. Every tool call then played as dead air, and a caller hearing silence
      // assumes the line dropped long before they assume a lookup is running. The filler
      // does not make the answer arrive sooner; it makes the wait legible.
      fillerInjectionEnabled: true,
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'en',
      /*
       * Vapi's own schema says the 10ms default "can cause some missing words". It is the
       * likeliest cause of a caller answering and the agent behaving as though they had
       * not: the endpoint fires mid-utterance and everything after it never reaches the
       * model at all.
       */
      endpointing: 300,
      /*
       * Transcripts below the confidence threshold are discarded silently. The default of
       * 0.4 drops a mumbled "two months" without trace, and a dropped transcript looks
       * exactly like a caller who said nothing.
       */
      confidenceThreshold: 0.25,
    },

    server: { url: opts.serverUrl },

    /*
     * Endpointing, the part that decides when the caller has finished.
     *
     * waitSeconds alone does not fix truncation — it governs how long the agent waits
     * before speaking, which is the wrong end of the pipeline. Truncation is decided by
     * the endpointing plan below, and words spoken after the endpoint fires never reach
     * the model.
     *
     * The waitFunction is the balanced preset rather than the conservative one: the
     * conservative floor adds 700ms to every turn by design, and this caller's other
     * complaint was that the agent is slow.
     */
    startSpeakingPlan: {
      waitSeconds: 0.6,
      smartEndpointingPlan: {
        provider: 'livekit',
        waitFunction: '(20 + 500 * sqrt(x) + 2500 * x^3 + 700 + 4000 * max(0, x-0.5)) / 2',
      },
      /*
       * Callers answer leasing questions with bare numbers — "two months", "one bedroom",
       * "thirty-eight hundred", a phone number. Those are exactly where a short endpoint
       * cuts them off, so the rules below buy time on the questions that invite one.
       */
      customEndpointingRules: [
        {
          type: 'assistant',
          regex: '(how many bedrooms|what.s your budget|when are you looking|move|phone number|email|spell)',
          timeoutSeconds: 3,
        },
      ],
    },

    // Three words rather than two: two is short enough that "mm-hm" stops the agent
    // mid-sentence, which reads as the agent losing its place.
    stopSpeakingPlan: {
      numWords: 3,
      voiceSeconds: 0.2,
      backoffSeconds: 1,
    },

    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 900,
    recordingEnabled: true,
    endCallPhrases: ['goodbye', 'bye now', 'have a good one'],
  }
}
