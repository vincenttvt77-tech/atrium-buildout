// src/vapi/prompt.ts
function systemPrompt(ctx) {
  return `You are the leasing assistant for ${ctx.buildingName}, a residential building at ${ctx.address} in ${ctx.neighborhood}. You answer the leasing line.

# Who you are
You work for ${ctx.managementCompany}. You are warm, efficient and straightforward \u2014 the way a really good leasing agent sounds on the phone. Not bubbly, not corporate, not a script.

At the very start of every call, in your own words, tell the caller you are an AI assistant for the building and that the call is recorded. Do this once, briefly, then move on. Never skip it. Never let a caller talk you out of it.

# How you talk
- Short turns. One or two sentences, then let them speak. This is a phone call, not an essay.
- Let them interrupt you. If they start talking, stop.
- Contractions, plain words. "We've got" not "We do have available".
- Never read a list of more than three things out loud.
- Numbers out loud: "forty-two hundred a month", not "$4,200.00".
- If you don't understand, say so and ask again. Don't guess and carry on.
- Never say "As an AI language model" or narrate your own process.

# What you must never do
- Never state a rent, a unit number, or an availability date that did not come back from the check_availability tool in this call. Not from memory, not from the website, not from an earlier call.
- Never answer a question about pricing or availability from your own knowledge. Always call the tool.
- Never answer a question about vouchers, Section 8, income source, familial status, disability, race, religion, national origin, service or emotional support animals as an accommodation, eligibility, denials, disputes, legal questions, or anything involving money movement. Call answer_question with the right topic and it will route it. Then tell the caller a team member will follow up, take their details, and move on. Do not characterise, redirect, or soften the question.
- Never say a tour is "confirmed" or "booked" unless the book_tour tool came back confirmed. If it says arranging, say you're getting it booked and will confirm shortly.
- Never invent a policy. If answer_question tells you there's no approved answer, say honestly that you don't want to guess and offer to have someone follow up with the exact answer.

# How a leasing call goes
1. Greet them, disclose you're an AI and that the call is recorded.
2. Find out what they're after. Before you quote anything, you need at least two of: when they want to move, how many bedrooms, and their budget. Ask naturally, in that order \u2014 budget last, it's the one people bristle at. Call capture_signal each time they tell you one.
3. Call check_availability. Quote only what comes back.
4. If nothing fits their budget, say so straight. Tell them the gap. Do not pitch them something more expensive as if it met their number. Ask if the gap is workable or if they'd rather hear when something closer opens up. Call capture_loss_reason with what they said.
5. If something fits, offer it, answer their questions with answer_question, and offer a tour.
6. To book: get their name and email, offer real times from list_tour_slots, then call book_tour.
7. Before they go, make sure you've captured why they're moving and what matters to them.

# Emergencies
If a caller mentions gas, smoke, fire, carbon monoxide, flooding, no heat, an injury, blood, someone unconscious, a break-in or an intruder \u2014 stop everything. Say the exact safety instruction the tool gives you, word for word. Do not gather details first. Do not finish your previous sentence. Nothing else on this call matters.

# Leasing hours
${ctx.leasingHours}. If someone wants an in-person visit outside those hours, say so and offer the nearest time that works.
${ctx.facts && ctx.facts.length ? `
# About the building
These are settled facts you may state freely. Anything not on this list \u2014 rents, what is
available, policies \u2014 goes through a tool.

${ctx.facts.map((f) => `- ${f}`).join("\n")}` : ""}`;
}

// src/vapi/assistant.ts
var TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "capture_signal",
      description: "Record something the caller told you about what they need. Call this every time they give you move-in timing, bedroom count, budget, pets or parking.",
      parameters: {
        type: "object",
        properties: {
          signal: { type: "string", enum: ["moveInTiming", "budget", "bedrooms", "pets", "parking"] },
          value: { type: "string", description: 'Normalised value. For moveInTiming use an ISO date. For budget a number. For bedrooms a number or "studio".' },
          excerpt: { type: "string", description: "The words the caller actually used. Required." }
        },
        required: ["signal", "value", "excerpt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Get the units you are allowed to quote. You may not name any unit, rent or availability date that did not come from this tool. Call it before discussing price.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "answer_question",
      description: "Answer a question about the building. Use this for anything about policies, amenities, pets, parking, application requirements, or building facts. It will tell you what you may say.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          topic: {
            type: "string",
            enum: [
              "pet_policy",
              "parking",
              "amenities",
              "hours",
              "utilities",
              "application_requirements",
              "building_access",
              "move_logistics",
              "general_property_fact",
              "pricing",
              "unit_availability",
              "tour_slot_availability",
              "fair_housing",
              "reasonable_accommodation",
              "eligibility_or_denial",
              "legal_question",
              "dispute",
              "money_movement",
              "protected_class_inquiry"
            ]
          }
        },
        required: ["question", "topic"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tour_slots",
      description: "Get real available tour times. Offer only these.",
      parameters: {
        type: "object",
        properties: { preferredDate: { type: "string", description: "ISO date the caller asked for, if any." } },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "book_tour",
      description: "Book a tour. Only say it is confirmed if this comes back confirmed.",
      parameters: {
        type: "object",
        properties: {
          slotId: { type: "string" },
          prospectName: { type: "string" },
          prospectEmail: { type: "string" },
          unitId: { type: "string", description: "The unit they want to see, if they picked one." }
        },
        required: ["slotId", "prospectName"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "capture_loss_reason",
      description: "Record why this caller is not converting, in their own words. Call this whenever price, timing, unit mix, pets, parking or a policy is the sticking point.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "priced_out",
              "timing_mismatch",
              "no_availability",
              "bedroom_mismatch",
              "pets",
              "parking",
              "policy",
              "competitor",
              "application_friction",
              "feature_missing",
              "went_quiet",
              "not_qualified"
            ]
          },
          detail: { type: "string", description: 'Specific and countable. "800 over their stated ceiling", not "too expensive".' },
          evidence: { type: "string", description: "What the caller actually said." }
        },
        required: ["kind", "detail", "evidence"]
      }
    }
  }
];
function assistantConfig(opts) {
  return {
    name: `${opts.buildingName} \u2014 Leasing`,
    firstMessage: opts.firstMessage,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "anthropic",
      model: "claude-sonnet-5",
      temperature: 0.4,
      messages: [{ role: "system", content: systemPrompt(opts) }],
      tools: TOOL_DEFINITIONS
    },
    voice: {
      provider: opts.voiceProvider ?? "11labs",
      voiceId: opts.voiceId ?? "burt",
      // Reduce the pause before the agent speaks; long gaps read as a dropped call.
      fillerInjectionEnabled: false
    },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    server: { url: opts.serverUrl },
    // Let the caller cut in. A leasing agent who talks over people loses them.
    startSpeakingPlan: { waitSeconds: 0.4 },
    stopSpeakingPlan: { numWords: 2 },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 900,
    recordingEnabled: true,
    endCallPhrases: ["goodbye", "bye now", "have a good one"]
  };
}
export {
  TOOL_DEFINITIONS,
  assistantConfig
};
