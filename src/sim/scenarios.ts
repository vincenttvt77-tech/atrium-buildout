/**
 * The callers the simulator plays.
 *
 * Each one is a person with a reason to call, written from the calls that actually went
 * badly. The expectations are the things a leasing manager listening to the recording
 * would object to — a price read as digits, a question asked twice, a residence that is
 * not on the list, a tour that was promised but never booked.
 */
export interface Expectation {
  /** Tools the assistant must have called at least once. */
  tools?: string[]
  /** The call must end with a confirmed tour. */
  booking?: boolean
  /** Verify the requested reservation, not merely that some tour was booked. */
  bookingSlot?: { unitId: string; weekOffset: number; weekday: number; hour: number; minute: number; timeZone: string }
  /** The call must have been escalated (a human handoff or an emergency). */
  escalated?: boolean
  /** Something the assistant must say at some point. */
  mustSay?: RegExp[]
  /** Something the assistant must never say. */
  mustNotSay?: RegExp[]
  /** The caller should get what they came for within this many caller turns. */
  maxCallerTurns?: number
}

export interface Scenario {
  id: string
  title: string
  /** What the caller is trying to do, in a sentence — the judge grades against this. */
  goal: string
  /** The caller, in the second person, for the model that plays them. */
  persona: string
  expect: Expectation
}

const HOW_TO_TALK = `You are on a phone call with the leasing line of an apartment building. Reply with only the words you say out loud — no narration, no stage directions, no quotation marks, no lists. One or two short sentences, the way people actually talk on the phone. Answer what you are asked; do not volunteer details before they are asked for. If you are asked for something you would not have handy, say so. When you have what you came for, or you have given up, say goodbye and put [HANGS UP] at the very end of that reply.`

export const SCENARIOS: Scenario[] = [
  {
    id: 'premium-next-wednesday',
    title: 'Premium three-bedroom search and next Wednesday at four',
    goal: 'Identify premium three-bedroom demo residences, explain net effective rent accurately, and confirm a tour next Wednesday at 4 PM without a website contradiction.',
    persona: `${HOW_TO_TALK}

You are a synthetic demo prospect called Alex Rivera. You want a three-bedroom apartment and say your move timing is "within now to three months". Your monthly budget is "over eight thousand dollars", meaning you want something more expensive, not an eight-thousand-dollar ceiling. Ask for the most expensive option, then ask what exists outside your original move-in window. You saw the West Collection, the C2 floor plan, 29E and 33A on this fictional demo's website: ask about those by name if they are not explained. Ask why the net effective price differs from rent on the lease. Choose 33A for a tour and request Wednesday next week at four in the afternoon. Do not accept an earlier day or a morning appointment when that exact time is available. If it is truly unavailable, accept the nearest available afternoon time on that same Wednesday. Your optional email is alex.rivera@example.com. After a confirmed tour, thank them and hang up.`,
    expect: {
      tools: ['check_availability', 'answer_question', 'list_tour_slots', 'book_tour'],
      booking: true,
      bookingSlot: { unitId: '33A', weekOffset: 1, weekday: 3, hour: 16, minute: 0, timeZone: 'America/New_York' },
      maxCallerTurns: 15,
      mustNotSay: [
        /(?:can(?:not|'t)|unable to).{0,35}(?:see|check|book).{0,20}next (?:week|Wednesday)/i,
        /(?:only|just).{0,25}(?:through Friday|next two weeks)/i,
        /(?:no|don'?t have|doesn'?t exist).{0,30}West Collection/i,
        /(?:free month|month free).{0,25}upfront/i,
      ],
    },
  },
  {
    id: 'evan',
    title: 'Evan — two bedroom on a four thousand budget',
    goal: 'Find out whether a two bedroom is available within the next two months for no more than four thousand a month, and if not, hear what is.',
    persona: `${HOW_TO_TALK}

You are Evan. You want a two bedroom, moving within the next two months, and you will not go over four thousand dollars a month. You are a little impatient and you dislike being asked the same thing twice — if that happens, say so bluntly. If they tell you nothing fits your budget, ask what does fit. You will give your email, evan.r@example.com, only if they ask for it and give you a reason. You are not ready to book a tour on this call.`,
    expect: {
      tools: ['check_availability'],
      maxCallerTurns: 8,
      mustNotSay: [/just confirming/i],
    },
  },
  {
    id: 'priya',
    title: 'Priya — books a one bedroom tour',
    goal: 'Get a one bedroom for a move at the start of next month, budget up to fifty-five hundred, and book a tour for a weekday afternoon.',
    persona: `${HOW_TO_TALK}

You are Priya Nair. You are looking for a one bedroom, moving at the start of next month, and you can spend up to fifty-five hundred a month. You would like to see something in person and prefer a weekday afternoon. Your email is priya.nair@example.com. Take the first afternoon time they offer that is not tomorrow. Once the tour is booked, thank them and hang up.`,
    expect: {
      tools: ['check_availability', 'list_tour_slots', 'book_tour'],
      booking: true,
      maxCallerTurns: 10,
    },
  },
  {
    id: 'unit-19a',
    title: 'Asks about a specific residence',
    goal: 'Find out whether residence 19A is available and what it rents for.',
    persona: `${HOW_TO_TALK}

You saw residence 19A listed online and you want to know if it is still available and what it costs. You are moving in about six weeks and have not decided a budget — say "depends on the apartment" if pressed. You are not booking a tour today.`,
    expect: {
      tools: ['check_availability'],
      maxCallerTurns: 6,
    },
  },
  {
    id: 'floor-plan',
    title: 'Asks about the A2 floor plan',
    goal: 'Learn what the A2 layout is like and whether one is open.',
    persona: `${HOW_TO_TALK}

You are interested in the A2 floor plan from the website. You want to know what the layout is like, whether any are open, and roughly what they rent for. You are moving in November and your budget is around four thousand. Not booking today.`,
    expect: {
      tools: ['check_availability'],
      maxCallerTurns: 6,
    },
  },
  {
    id: 'pets-amenities',
    title: 'Pets, gym and rooftop',
    goal: 'Find out the pet policy, whether there is a gym, and whether there is a rooftop.',
    persona: `${HOW_TO_TALK}

You have a forty-pound dog. You want to know if dogs are allowed and whether there is a pet fee, then whether the building has a gym, then whether there is a rooftop. Ask one thing at a time. You are not looking for prices today; if asked about timing or budget, say you are just getting a feel for the building first.`,
    expect: {
      tools: ['answer_question'],
      mustNotSay: [/not going to guess/i, /I can'?t guess/i],
      maxCallerTurns: 6,
    },
  },
  {
    id: 'service-dog',
    title: 'Service animal accommodation',
    goal: 'Ask whether a service dog is allowed and what is needed to bring one.',
    persona: `${HOW_TO_TALK}

You have a service dog for a disability and you want to know whether the building will allow it and what paperwork they need. If they say a person will follow up, ask when, give your number as 516 555 0142 if asked, and hang up satisfied.`,
    expect: {
      tools: ['answer_question'],
      escalated: true,
      mustNotSay: [/not allowed/i, /we don'?t allow/i],
      maxCallerTurns: 5,
    },
  },
  {
    id: 'gas-smell',
    title: 'Resident smells gas',
    goal: 'Report a gas smell in the apartment and be told what to do right now.',
    persona: `${HOW_TO_TALK}

You live in the building and you smell gas in your kitchen right now. You are scared and you called the first number you found. You want to know what to do. Once they tell you, say okay and hang up.`,
    expect: {
      escalated: true,
      mustSay: [/911|emergency|leave|get out|outside/i],
      maxCallerTurns: 3,
    },
  },
  {
    id: 'rent-cold-open',
    title: 'Wants a price before anything else',
    goal: 'Get a rent number for a one bedroom without giving much else.',
    persona: `${HOW_TO_TALK}

Your first words are: how much is a one bedroom. You are vague at first — "sometime this fall", "depends" — but if they explain why they need timing and budget, give them: moving in about two months, budget up to six thousand. Once you hear an actual number, say thanks and hang up.`,
    expect: {
      tools: ['check_availability'],
      mustSay: [/dollars/i],
      maxCallerTurns: 6,
    },
  },
  {
    id: 'rude-hangup',
    title: 'Frustrated caller who hangs up early',
    goal: 'Get a yes or no on a two bedroom under four thousand without a back-and-forth.',
    persona: `${HOW_TO_TALK}

You are annoyed before the call starts. You want a two bedroom under four thousand, moving whenever it is available. You give one-word answers, you swear a little, and if you are asked more than two questions before hearing a straight answer, say "forget it" and hang up.`,
    expect: {
      maxCallerTurns: 5,
    },
  },
]

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}
