# Atrium voice audition kit

Prepared September 23, 2026. This is a listening and trial brief, not a deployed
configuration or test result. The owner wants a Black American or Latina female
voice and is considering Vast.ai to reduce response delay. Accent strength and
Spanish support remain undecided. Start with the existing English leasing scope;
add bilingual acceptance only if selected. Task ownership stays in
[the shared board](agent-tasks.md).

## What we are choosing

Choose a voice that sounds clear, conversational and professional on a telephone.
Prefer short, composed answers, natural number pronunciation and a comfortable
pace. The owner chooses from listening samples. Provider or creator descriptions
establish the advertised voice category; a name or sound does not establish a
person's ethnicity. Keep Atrium's AI disclosure.

| Audition lead | Public evidence | Still needed before use |
| --- | --- | --- |
| Zoe | ElevenLabs describes this female voice with an African American accent in its [voice migration table](https://elevenlabs.io/docs/help-center/product/voices/voice-library/how-are-voices-updated-changed). | Current exact ID, account access, commercial-use eligibility, an English phone sample and owner preference. Do not assume an old Aria ID is the desired pinned configuration. |
| Leoni Vergara | ElevenLabs lists it in its [English Latino-accent collection](https://elevenlabs.io/text-to-speech/latino-accent), including a conversational label. The public page exposes listening controls. | Confirm female presentation from the specific provider entry, exact ID, access and commercial-use eligibility, then listen to the same script. No audition has been performed. |
| Vega | The same [collection](https://elevenlabs.io/text-to-speech/latino-accent) lists an English female voice described as warm. | Exact entry/ID, advertised accent, rights, availability and a matched sample; collection placement alone is insufficient to select it. |

These are research leads, not a promise that they are available in the connected
Vapi account. The September 22 Vapi inspection did not find Zoe or Leoni in its
displayed default ElevenLabs list. Current library access must be checked before
configuration. The existing published voice is the listening control, after
rechecking its saved version. No voice was selected, generated or changed here.

## Identical listening script

Use these four clips, in this order, for every candidate. All property facts below
are **fictional test data**, not approved Larkin inventory, prices or availability.
Keep the fixtures outside production knowledge. Static clips test speech quality;
they do not test the model's accuracy or the booking backend.

**Greeting**

“Thanks for calling the Larkin Demo. I'm the building's AI assistant, and this call
is recorded. Are you looking for an apartment, or calling about a tour?”

**Clear apartment details**

“In this sample, Residence nineteen A has two bedrooms and two bathrooms. The
monthly rent is four thousand two hundred fifty dollars. Would you like to hear
about the layout?”

**Date correction and choice**

“Got it—Friday, September twenty-fifth, at ten in the morning. You said nineteen A,
not nineteen B. That time isn't available for nineteen A. Would ten thirty work?”

**Honest recovery**

“I couldn't verify that the reservation went through, so I can't call it confirmed
yet. I can save your details for the leasing team. What is the best callback
number?”

Read each clip without added laughter, whispering, exaggerated character direction
or promotional language. Keep punctuation and wording fixed. Record the actual
voice/model IDs, settings and generation time privately; label samples A/B/C for
the first listening pass. A provider demo clip can shortlist a voice, but it cannot
substitute for the identical Atrium script or phone playback.

## Listening scorecard

The owner and another listener can score independently before comparing notes.
Use 1 (poor) through 5 (excellent); write the specific word or moment causing a
problem. A high average never overrides a wrong price, date or apartment number.

| Criterion | Sample A | Sample B | Sample C |
| --- | --- | --- | --- |
| Easy to understand over a phone speaker | Pending | Pending | Pending |
| Clear apartment numbers, money and dates | Pending | Pending | Pending |
| Natural conversational pace | Pending | Pending | Pending |
| Professional, approachable delivery | Pending | Pending | Pending |
| Calm and clear when something fails | Pending | Pending | Pending |
| Owner's preference and notes | Pending | Pending | Pending |

Then test live interruptions: interrupt during a price, change the apartment
number, speak immediately after a tool result, and pause before finishing a date.
Check whether the assistant stops promptly, remembers the correction and resumes
without talking over the caller. These require the complete phone pipeline;
recording playback alone cannot establish them.

## Hosting comparison

Keep these four configurations separate and preserve the same approved knowledge,
tool definitions, prompt, transcriber and turn-taking settings except for the
component named in the row:

| Trial | Model hosting | Speech voice | Purpose |
| --- | --- | --- | --- |
| A | Current verified setup | Current verified voice | Successful current baseline |
| B | Same as A | Selected audition candidate | Isolate speech quality and speech delay |
| C | Vast candidate | Same as A | Isolate model hosting, tool correctness and model delay |
| D | Same as C | Same as B | Test the combined system after B and C pass |

[Vapi supports compatible custom model endpoints and recommends streaming](https://docs.vapi.ai/customization/custom-llm/fine-tuned-openai-models).
Its [tool integration guide](https://docs.vapi.ai/customization/tool-calling-integration)
describes streamed responses and structured tool calls. Before connecting a phone,
exercise streamed tool arguments, exact tool-result continuation, cancellation,
timeouts and malformed outputs with synthetic fixtures. A model returning fluent
text does not establish that it can execute Atrium's workflows correctly.

Vast's documented [endpoint setup](https://docs.vast.ai/guides/serverless/setting-up-endpoints)
currently defaults to five minimum total workers, sixteen maximum workers and a
minimum active-load setting of one. Its vLLM template exposes an OpenAI-compatible
API. These are documentation defaults, not an Atrium rental recommendation or an
observed configuration. Review capacity and a total spending cap before creation;
do not provision the default worker pool casually. Ready capacity, region,
replacement workers and first-after-idle delay belong in the trial. The model and
speech service remain separate components unless a specific combined design is
selected and verified.

Use the same defined cases for each trial: known-unit question, broad shortlist,
capacity conflict, unit blackout, booking, correction after booking, permissioned
email, reschedule request, interrupted price, unclear date, tool failure and a
long conversation. Include repeat trials and concurrent calls under a pre-agreed
budget. This is a diagnostic set; it does not establish the goal's held-out pilot
success rate or replace representative permissioned calls.

Measure caller speech-end to the first meaningful answer, total task time,
completed actions, incorrect claims, recovery and cost per successful task.
Separate model first-token time from phone response latency. Record transcription,
endpointing, tool and speech timing where available. Report sample counts and
P50/P95 with their limitations; filler acknowledgments are not the answer.
Use [the existing matched evaluator](voice-evaluation.md#compare-matched-trials).
Set numerical latency and cost limits from the successful baseline before judging
the candidate. Faster speech does not compensate for wrong facts or duplicate tours.

## Next owner and agent actions

Owner: choose the accent/language direction and favorite after samples; provide a
bounded paid trial budget when ready. Configure credentials privately. Existing
call credit, current candidate access and commercial rights need verification.

Codex/Fable: resolve the shortlisted voice IDs/rights, prepare identical samples
within authorized spend, establish a successful current phone baseline, then run
the component comparisons. Preserve the published assistant and any separate
draft until a reviewed change is ready. Document exact settings and rollback.
Finish each session with a reciprocal handoff and owner/agent to-dos.

No GPU rental, audio generation, paid call, Vapi change or measured latency gain is
claimed by this kit. Staff tour-contact editing and exact confirmation-review
navigation remain separate upcoming work. The [cloud expiry regression repair](../reports/2026-09-23-expiry-regression.md)
has local acceptance; its own published cloud result is a separate release gate.
