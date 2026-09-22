import { systemPrompt, type PromptContext } from './prompt.ts'

/** Tool schemas as Vapi expects them (OpenAI function-calling shape). */
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'capture_contact',
      description: 'Save volunteered contact details or a staff request to change an existing tour. For a reschedule or cancellation, set requestType to tour_change and include the caller’s words even without contact details. Does not change a tour or send messages.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name the caller gave.' },
          email: { type: 'string', description: 'The email address the caller gave.' },
          phone: { type: 'string', description: 'Their preferred callback number, only if they gave one.' },
          excerpt: { type: 'string', description: 'The caller’s exact words supporting these details.' },
          requestType: { type: 'string', enum: ['tour_change'], description: 'Only for an actual request to reschedule, move or cancel an existing tour. Saves a staff review request; caller identity is not verified and the original tour is not changed.' },
        },
        required: ['excerpt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'capture_signal',
      description: 'Save a volunteered preference while gathering information, or pets/parking evidence. When checking residences now, pass timing, bedrooms and budget directly to check_availability instead of duplicating capture calls.',
      parameters: {
        type: 'object',
        properties: {
          signal: {
            type: 'string',
            description: 'Which signal the caller just gave you.',
            enum: ['moveInTiming', 'budget', 'bedrooms', 'pets', 'parking'],
          },
          value: { type: 'string', description: 'For moveInTiming, their words — "within the next 2 months", "November", "asap". For budget, the number as they said it — "4000", "$4k", "four thousand". For bedrooms a number or "studio".' },
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
      description: 'Get the units you are allowed to quote. You may not name any unit, rent or availability date that did not come from this tool. Call it before discussing price. Pass whatever they have told you about timing, bedrooms and budget in the same call — one call is faster than several and cannot lose an answer.',
      // A parameter-less tool would be an empty `properties: {}`, which several schema
      // validators reject. `reason` is genuinely useful anyway: it records what prompted
      // the lookup, which is one more signal on the call.
      parameters: {
        type: 'object',
        properties: {
          unitId: {
            type: 'string',
            description: 'If the caller named a specific residence — "is 19A available?" — or a floor plan — "is an A2 open?", "the two bedroom with balcony" — pass it here and it is looked up directly, no qualification needed.',
          },
          reason: {
            type: 'string',
            description: 'Why you are checking now — for example "caller asked about one bedrooms".',
          },
          moveIn: { type: 'string', description: 'When they want to move, in their words — "within the next 2 months", "November", "asap". Pass it here instead of a separate capture_signal call.' },
          bedrooms: { type: 'string', description: 'How many bedrooms — a number or "studio".' },
          budget: { type: 'string', description: 'Their exact spending words, including minimum vs maximum — "over eight thousand", "not over four thousand", "between eight and twelve thousand". Never strip "over" into a ceiling.' },
          sortBy: { type: 'string', enum: ['price_desc'], description: 'Use price_desc only when the caller asks for the highest-priced residences; ranks the requested search by net effective rent.' },
          includeOutsideMoveIn: { type: 'boolean', description: 'True only when the caller asks to consider homes outside the previously stated move-in window. Does not erase their saved timing.' },
          ignoreBudget: { type: 'boolean', description: 'True only when the caller explicitly asks to remove their prior spending constraint, such as asking for more expensive options. Does not erase their saved preference.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'answer_question',
      description: 'Answer a question about the building: policies, amenities, pets, parking, fees and specials, application requirements, floor plans and layouts, balconies, finishes, or any building fact. Pick the closest topic — it searches every approved article, so a near-miss is fine. It will tell you what you may say.',
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
      description: 'Get real tour times under the property’s current hours, capacity, apartment-sharing policy, duration, buffers and notice rules. Pass the selected residence to filter its conflicts. Ask for any future preferred date; do not assume a fixed two-week booking limit. Offer only returned times.',
      parameters: {
        type: 'object',
        properties: {
          preferredDate: { type: 'string', description: 'Building-local date YYYY-MM-DD the caller asked for, if any.' },
          preferredTime: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Requested building-local time in HH:mm, with preferredDate required. For 4 PM use 16:00. Ask once if morning/afternoon is unclear.' },
          unitId: { type: 'string', description: 'Selected residence ID returned by check_availability, if known. Keep it the same when booking.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_tour',
      description: 'Book a NEW tour only. Never use this to reschedule, replace or cancel an existing reservation; save a staff tour-change request instead. Only say confirmed after confirmed readback. An existing future tour may require staff review.',
      parameters: {
        type: 'object',
        properties: {
          slotId: { type: 'string', description: 'The slotId from list_tour_slots. Never invent one.' },
          prospectName: { type: 'string', description: 'The name to put on the booking.' },
          prospectEmail: { type: 'string', description: 'Optional email voluntarily provided for staff follow-up. No confirmation message is sent automatically.' },
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
/**
 * Spoken the moment a tool starts, so the caller never hears dead air while the model
 * waits on the lookup. Vapi reads these from the tool definition, not the prompt, and they
 * sit beside `function`, not inside it. A tool that usually answers within a second gets
 * only the delayed message, so it is not announced every time.
 */
export const TOOL_MESSAGES: Record<string, Array<Record<string, unknown>>> = {
  check_availability: [
    { type: 'request-start', content: 'Let me pull that up.' },
    { type: 'request-response-delayed', content: 'One more second.', timingMilliseconds: 2500 },
  ],
  list_tour_slots: [{ type: 'request-start', content: 'Let me look at the calendar.' }],
  book_tour: [{ type: 'request-start', content: 'Checking that time now.', blocking: false }],
  answer_question: [{ type: 'request-response-delayed', content: 'Let me check that for you.', timingMilliseconds: 1500 }],
}

export const toolsWithMessages = () => TOOL_DEFINITIONS.map((t) => {
  const messages = TOOL_MESSAGES[t.function.name]
  return messages ? { ...t, messages } : t
})

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
      tools: pruneEmptyRequired(toolsWithMessages()),
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

    // Documented timing fields: docs.vapi.ai/customization/voice-pipeline-configuration.
    // These are tuning defaults, not measured call latency. Keep longer contact-spelling
    // windows without imposing that same pause after every ordinary leasing question.
    startSpeakingPlan: {
      waitSeconds: 0.4,
      // Used only without a smart/built-in endpointing provider. An existing saved
      // assistant's smart endpointing provider is preserved by synchronization.
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.3,
        onNoPunctuationSeconds: 1.2,
        onNumberSeconds: 1.0,
      },
      customEndpointingRules: [
        {
          type: 'assistant',
          regex: '\\b(phone number|callback number|e-?mail|spell|spelling)\\b',
          regexOptions: [{ type: 'ignore-case', enabled: true }],
          timeoutSeconds: 3,
        },
      ],
    },

    /*
     * numWords stays at 0, the documented default and the recommended value.
     *
     * An earlier version raised it to 3 on the theory that a low threshold made the agent
     * twitchy. That was backwards: above 0 the agent waits for transcribed words before
     * it will stop, which adds 200-500ms and swallows short answers — the exact complaint.
     * At 0 it uses voice activity and interrupts in 50-100ms, and Vapi already suppresses
     * "okay", "yeah" and "right" internally, so it does not trip on backchannel.
     */
    stopSpeakingPlan: {
      numWords: 0,
      voiceSeconds: 0.2,
      // Blocks all assistant audio after an interruption. The default of 1s reads as
      // sluggish when a caller cuts in and then waits.
      backoffSeconds: 0.8,
    },

    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 900,
    recordingEnabled: true,
    endCallPhrases: ['goodbye', 'bye now', 'have a good one'],
  }
}
