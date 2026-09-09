import { systemPrompt, type PromptContext } from './prompt.ts'

/** Tool schemas as Vapi expects them (OpenAI function-calling shape). */
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'capture_contact',
      description: 'Save contact information volunteered by the caller, even when they do not book. Does not send messages.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name the caller gave.' },
          email: { type: 'string', description: 'The email address the caller gave.' },
          phone: { type: 'string', description: 'Their preferred callback number, only if they gave one.' },
          excerpt: { type: 'string', description: 'The caller’s exact words supporting these details.' },
        },
        required: ['excerpt'],
      },
    },
  },
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
          budget: { type: 'string', description: 'The most they want to spend a month, as they said it — "4000", "$4k", "not over four thousand".' },
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
  book_tour: [{ type: 'request-start', content: 'Locking that in now.' }],
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
      /*
       * Smart endpointing is deliberately NOT set. Setting it makes the three
       * transcriptionEndpointing values below inert, and the wait function that replaces
       * them is not exposed in the dashboard — so the one control that matches this
       * failure would become untunable.
       *
       * The failure: a caller answers "I don't know, 2 months" and the agent talks over
       * the number. onNumberSeconds is exactly that case, and its default is about half a
       * second. Leasing answers are mostly bare numbers — bedroom counts, budgets, phone
       * numbers, unit numbers — so this is the single most valuable value on the page.
       */
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.5,
        onNoPunctuationSeconds: 1.8,
        onNumberSeconds: 1.5,
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
